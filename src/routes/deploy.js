/**
 * Deploy Routes
 * Token deployment and metadata preparation endpoints
 */
const express = require('express');
const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const config = require('../config/env');
const { pinata, moderation, vanity, redis, logger } = require('../services');
const { isValidPubkey } = require('./solana');

const router = express.Router();

/**
 * Initialize routes with dependencies
 */
function init(deps) {
    const { connection, devKeypair, db, addFees } = deps;

    // Test vanity grinder
    router.get('/test-vanity', async (req, res) => {
        try {
            const startTime = Date.now();
            const keypair = await vanity.getMintKeypair();
            const elapsed = Date.now() - startTime;
            const address = keypair.publicKey.toBase58();
            const isVanity = address.toUpperCase().endsWith('ASDF');

            res.json({
                success: true,
                address,
                isVanityAddress: isVanity,
                vanityGrinderEnabled: config.VANITY_GRINDER_ENABLED,
                vanityGrinderUrl: config.VANITY_GRINDER_URL || 'not configured',
                fetchTimeMs: elapsed
            });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // Prepare metadata
    router.post('/prepare-metadata', async (req, res) => {
        try {
            let { name, ticker, description, twitter, website, image } = req.body;

            const descInput = description || "";
            if (descInput.length > 75) {
                return res.status(400).json({ error: "Description must be 75 characters or less." });
            }
            if (!name || name.length > 32) {
                return res.status(400).json({ error: "Invalid Name" });
            }
            if (!ticker || ticker.length >= 12) {
                return res.status(400).json({ error: "Invalid Ticker" });
            }
            if (!image) {
                return res.status(400).json({ error: "Image required" });
            }

            const DESCRIPTION_FOOTER = " Launched via Ignition. Dev fees towards PUMP airdrops of holders. ASDFASDFA Ignition Tool";
            const finalDescription = descInput + DESCRIPTION_FOOTER;

            const isSafe = await moderation.checkContentSafety(image);
            if (!isSafe) {
                return res.status(400).json({ error: "Upload blocked: Illegal content detected." });
            }

            const metadataUri = await pinata.uploadMetadata(name, ticker, finalDescription, twitter, website, image);
            res.json({ success: true, metadataUri });
        } catch (err) {
            logger.error("Metadata Prep Error", { error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    // Deploy token
    router.post('/deploy', async (req, res) => {
        try {
            const { name, ticker, description, twitter, website, image, metadataUri, userTx, userPubkey, isMayhemMode } = req.body;

            if (!metadataUri) {
                return res.status(400).json({ error: "Missing metadata URI" });
            }
            if (!userPubkey || !isValidPubkey(userPubkey)) {
                return res.status(400).json({ error: "Invalid Solana address" });
            }
            if (!userTx || typeof userTx !== 'string') {
                return res.status(400).json({ error: "Invalid transaction signature" });
            }

            try {
                await db.run('INSERT INTO transactions (signature, userPubkey) VALUES (?, ?)', [userTx, userPubkey]);
            } catch (dbErr) {
                if (dbErr.message.includes('UNIQUE')) {
                    return res.status(400).json({ error: "Tx already used." });
                }
                throw dbErr;
            }

            let validPayment = false;
            for (let i = 0; i < 15; i++) {
                const txInfo = await connection.getParsedTransaction(userTx, {
                    commitment: "confirmed",
                    maxSupportedTransactionVersion: 0
                });

                if (txInfo) {
                    validPayment = txInfo.transaction.message.instructions.some(ix => {
                        if (ix.programId.toString() !== '11111111111111111111111111111111') return false;
                        if (ix.parsed.type !== 'transfer') return false;
                        return ix.parsed.info.destination === devKeypair.publicKey.toString() &&
                               ix.parsed.info.lamports >= config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL;
                    });
                    break;
                }
                await new Promise(r => setTimeout(r, 2000));
            }

            if (!validPayment) {
                await db.run('DELETE FROM transactions WHERE signature = ?', [userTx]);
                return res.status(400).json({ error: "Payment verification failed or timed out." });
            }

            await addFees(config.DEPLOYMENT_FEE_SOL * LAMPORTS_PER_SOL);

            const job = await redis.addDeployJob({
                name, ticker, description, twitter, website, image,
                userPubkey, isMayhemMode, metadataUri
            });

            res.json({ success: true, jobId: job.id, message: "Queued" });
        } catch (err) {
            logger.error("Deploy API Error", { error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    // Job status
    router.get('/job-status/:id', async (req, res) => {
        const job = await redis.getJob(req.params.id);
        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }
        const state = await job.getState();
        res.json({
            id: job.id,
            state,
            result: job.returnvalue,
            failedReason: job.failedReason
        });
    });

    return router;
}

module.exports = { init };
