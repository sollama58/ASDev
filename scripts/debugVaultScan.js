#!/usr/bin/env node
/**
 * Debug Vault Scan
 * Diagnostic script to understand what transactions are in the vault
 * and how to extract mints from them.
 *
 * Usage: node scripts/debugVaultScan.js [--limit N]
 */
require('dotenv').config();

const { Keypair, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');

// Avoid loading config/env.js which exits on missing vars
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const DEV_WALLET_PRIVATE_KEY = process.env.DEV_WALLET_PRIVATE_KEY;

const { PROGRAMS } = require('../src/config/constants');
const pump = require('../src/services/pump');
const mintExtractor = require('../src/services/mintExtractor');

// Parse args
const limitArg = process.argv.find(a => a.startsWith('--limit'));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1] || process.argv[process.argv.indexOf('--limit') + 1]) : 10;

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('                     VAULT SCAN DIAGNOSTIC                       ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    if (!DEV_WALLET_PRIVATE_KEY) {
        console.log('❌ DEV_WALLET_PRIVATE_KEY not configured');
        process.exit(1);
    }

    if (!HELIUS_API_KEY) {
        console.log('❌ HELIUS_API_KEY not configured');
        process.exit(1);
    }

    const devKeypair = Keypair.fromSecretKey(bs58.decode(DEV_WALLET_PRIVATE_KEY));
    console.log(`Dev Wallet: ${devKeypair.publicKey.toString()}`);
    console.log(`Limit: ${LIMIT} transactions per vault`);

    // Get vault addresses
    const { bcVault, ammVaultAuth } = pump.getCreatorFeeVaults(devKeypair.publicKey);
    console.log(`\nBC Vault: ${bcVault.toString()}`);
    console.log(`AMM Vault Auth: ${ammVaultAuth.toString()}`);

    // Fetch recent transactions from BC vault
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                  BC VAULT TRANSACTIONS                          ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const bcVaultStr = bcVault.toString();
    const bcTxs = await fetchVaultTransactions(bcVaultStr, LIMIT);
    const bcMints = await analyzeTransactions(bcTxs, 'BC', bcVaultStr);

    // Fetch recent transactions from AMM vault
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                  AMM VAULT TRANSACTIONS                         ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const ammVaultStr = ammVaultAuth.toString();
    const ammTxs = await fetchVaultTransactions(ammVaultStr, LIMIT);
    const ammMints = await analyzeTransactions(ammTxs, 'AMM', ammVaultStr);

    // Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                         SUMMARY                                 ');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const allMints = new Set([...bcMints, ...ammMints]);
    console.log(`BC Vault: ${bcTxs.length} transactions, ${bcMints.size} unique mints found`);
    console.log(`AMM Vault: ${ammTxs.length} transactions, ${ammMints.size} unique mints found`);
    console.log(`Total unique mints: ${allMints.size}`);

    if (allMints.size > 0) {
        console.log('\nDiscovered mints:');
        for (const mint of allMints) {
            console.log(`  - ${mint}`);
        }
    }

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                         COMPLETE                                ');
    console.log('═══════════════════════════════════════════════════════════════\n');
}

async function fetchVaultTransactions(vaultAddress, limit = 10) {
    try {
        // Try enhanced API first (better parsing)
        console.log(`Fetching from Helius Enhanced API...`);
        const response = await axios.get(
            `https://api.helius.xyz/v0/addresses/${vaultAddress}/transactions?api-key=${HELIUS_API_KEY}&limit=${limit}`,
            { timeout: 30000 }
        );

        if (Array.isArray(response.data)) {
            console.log(`Found ${response.data.length} transactions (enhanced format)`);
            return response.data;
        }
    } catch (e) {
        console.log(`Enhanced API failed: ${e.message}`);
    }

    // Fallback to standard RPC
    try {
        console.log(`Trying standard RPC...`);
        const response = await axios.post(
            `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
            {
                jsonrpc: '2.0',
                id: '1',
                method: 'getTransactionsForAddress',
                params: [vaultAddress, {
                    limit,
                    sortOrder: 'desc',
                    transactionDetails: 'full',
                }]
            },
            { timeout: 30000 }
        );

        const result = response.data?.result;
        console.log(`Found ${result?.data?.length || 0} transactions (RPC format)`);
        return result?.data || [];
    } catch (e) {
        console.log(`RPC error: ${e.message}`);
        return [];
    }
}

async function analyzeTransactions(transactions, vaultType, vaultAddress) {
    const pumpProgramId = PROGRAMS.PUMP.toString();
    const ammProgramId = PROGRAMS.PUMP_AMM.toString();
    const foundMints = new Set();
    const processedSources = new Set();

    for (let i = 0; i < transactions.length; i++) {
        const tx = transactions[i];
        console.log(`\n--- Transaction ${i + 1} ---`);
        console.log(`Signature: ${tx.signature}`);

        // Extract source address (the BC/pool that sent fees)
        const sourceAddress = mintExtractor.extractSourceAddress(tx, vaultAddress);
        if (sourceAddress) {
            if (processedSources.has(sourceAddress)) {
                console.log(`⏭️  Source already seen: ${sourceAddress.slice(0, 8)}... (skipping)`);
                continue;
            }
            console.log(`  Source: ${sourceAddress}`);
            processedSources.add(sourceAddress);
        }

        // Try extracting mint using mintExtractor
        const extractedMint = mintExtractor.extractMintFromTransaction(tx);
        if (extractedMint) {
            console.log(`✅ Extracted mint: ${extractedMint}`);
            foundMints.add(extractedMint);
        } else {
            console.log(`❌ No mint extracted`);
        }

        // Show enhanced transaction fields if available
        if (tx.type) console.log(`  Type: ${tx.type}`);
        if (tx.source) console.log(`  Source: ${tx.source}`);
        if (tx.description) console.log(`  Description: ${tx.description}`);

        // Show token transfers (enhanced format)
        const tokenTransfers = tx.tokenTransfers || [];
        if (tokenTransfers.length > 0) {
            console.log(`  Token Transfers (${tokenTransfers.length}):`);
            for (const transfer of tokenTransfers) {
                console.log(`    - Mint: ${transfer.mint}, Amount: ${transfer.tokenAmount}`);
                if (transfer.mint && !foundMints.has(transfer.mint)) {
                    console.log(`      (Adding to found mints)`);
                    foundMints.add(transfer.mint);
                }
            }
        }

        // Show native transfers
        const nativeTransfers = tx.nativeTransfers || [];
        if (nativeTransfers.length > 0) {
            console.log(`  Native Transfers (${nativeTransfers.length}):`);
            for (const transfer of nativeTransfers) {
                const solAmount = transfer.amount / 1e9;
                console.log(`    - ${transfer.fromUserAccount?.slice(0, 8)}... -> ${transfer.toUserAccount?.slice(0, 8)}... : ${solAmount.toFixed(4)} SOL`);
            }
        }

        // Show account data changes
        const accountData = tx.accountData || [];
        if (accountData.length > 0) {
            for (const acc of accountData) {
                if (acc.tokenBalanceChanges && acc.tokenBalanceChanges.length > 0) {
                    console.log(`  Token Balance Changes:`);
                    for (const change of acc.tokenBalanceChanges) {
                        console.log(`    - ${change.mint?.slice(0, 8)}... : ${change.rawTokenAmount?.tokenAmount}`);
                        if (change.mint && !foundMints.has(change.mint)) {
                            foundMints.add(change.mint);
                        }
                    }
                }
            }
        }

        // Analyze RPC format (if not enhanced)
        const message = tx.transaction?.message;
        if (message) {
            const accountKeys = message.accountKeys || [];
            const instructions = message.instructions || [];

            // Look for Pump.fun instructions
            for (const ix of instructions) {
                const programIdIndex = ix.programIdIndex;
                const programId = accountKeys[programIdIndex];
                const programIdStr = typeof programId === 'string' ? programId : programId?.pubkey;

                if (programIdStr === pumpProgramId || programIdStr === ammProgramId) {
                    console.log(`  Found ${programIdStr === pumpProgramId ? 'PUMP' : 'AMM'} instruction`);

                    // Try to decode discriminator
                    try {
                        const data = Buffer.from(ix.data, 'base64');
                        if (data.length >= 8) {
                            const discriminator = Array.from(data.slice(0, 8));
                            console.log(`    Discriminator: [${discriminator.join(', ')}]`);
                        }
                    } catch {}

                    // Show account indices
                    const ixAccounts = ix.accounts || [];
                    if (ixAccounts.length > 2) {
                        const potentialMintIdx = programIdStr === pumpProgramId ? 2 : 7;
                        if (ixAccounts.length > potentialMintIdx) {
                            const mintIdx = ixAccounts[potentialMintIdx];
                            const mintAcc = accountKeys[mintIdx];
                            const mintStr = typeof mintAcc === 'string' ? mintAcc : mintAcc?.pubkey;
                            console.log(`    Potential mint (idx ${potentialMintIdx}): ${mintStr}`);
                        }
                    }
                }
            }
        }
    }

    return foundMints;
}

function arraysEqual(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
