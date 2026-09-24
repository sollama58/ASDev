#!/usr/bin/env node
/**
 * Platform wallet key tool
 * v30.4
 *
 *   node scripts/wallet-key.js encrypt          Wrap a clear-text key in a passphrase-encrypted
 *                                               envelope for DEV_WALLET_KEY_FILE / DEV_WALLET_PRIVATE_KEY.
 *                                               Reads the key from stdin (paste, or `< id.json`) and the
 *                                               passphrase from DEV_WALLET_KEY_PASSPHRASE or a hidden prompt.
 *   node scripts/wallet-key.js pubkey           Print the public key of the configured signer
 *                                               (env var, file or Vault) without revealing anything else.
 *   node scripts/wallet-key.js verify           Build the signer exactly as the server would, sign a test
 *                                               message and verify it. Run this after any key change.
 *
 * Nothing here ever prints key material.
 */
process.env.WALLET_CHECK = 'skip'; // tooling: config/env.js must not exit before we can explain what is missing

const readline = require('readline');
const nacl = require('tweetnacl');
const signerService = require('../src/services/signer');

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => { data += c; });
        process.stdin.on('end', () => resolve(data));
    });
}

/** Prompt without echo. */
function promptHidden(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
        const write = rl._writeToOutput;
        rl._writeToOutput = function (str) { if (str.includes('\n')) write.call(rl, '\n'); };
        process.stderr.write(question);
        rl.question('', (answer) => { rl.close(); process.stderr.write('\n'); resolve(answer); });
    });
}

async function encrypt() {
    let key;
    if (process.stdin.isTTY) {
        key = await promptHidden('Paste the wallet key (base58 or JSON byte array), then Enter: ');
    } else {
        key = await readStdin();
    }
    let pass = process.env.DEV_WALLET_KEY_PASSPHRASE;
    if (!pass) {
        if (!process.stdin.isTTY) throw new Error('set DEV_WALLET_KEY_PASSPHRASE when the key comes from stdin');
        pass = await promptHidden('Passphrase (12+ characters): ');
        const again = await promptHidden('Passphrase again: ');
        if (pass !== again) throw new Error('passphrases do not match');
    }
    const envelope = signerService.encryptEnvelope(key, pass);
    // Confirm the envelope opens and name the wallet it holds, so a typo is caught now.
    const sk = signerService.parseKeyMaterial(envelope, pass);
    const signer = signerService.createLocalSigner(sk);
    process.stderr.write(`Envelope for wallet ${signer.publicKey.toBase58()} (store the passphrase separately):\n`);
    process.stdout.write(envelope + '\n');
}

async function build() {
    // No signing policy here: `verify` signs a plain test message, which the policy would
    // (correctly) refuse as not being a transaction. The server always attaches the policy.
    const signer = await signerService.createSignerFromEnv(process.env, null);
    signerService.scrubSecretsFromEnv();
    return signer;
}

async function pubkey() {
    const signer = await build();
    process.stdout.write(signer.publicKey.toBase58() + '\n');
}

async function verify() {
    const signer = await build();
    const msg = Buffer.from(`shitpad wallet-key verify ${Date.now()}`);
    const sig = await signer.signMessage(msg);
    const good = nacl.sign.detached.verify(msg, sig, signer.publicKey.toBytes());
    if (!good) throw new Error('signature did not verify against the public key');
    process.stdout.write(`OK: ${signer.kind} signer (${signer.source}) controls ${signer.publicKey.toBase58()}\n`);
}

const cmd = process.argv[2];
const run = { encrypt, pubkey, verify }[cmd];
if (!run) {
    process.stderr.write('usage: node scripts/wallet-key.js <encrypt|pubkey|verify>\n');
    process.exit(2);
}
run().catch((e) => { process.stderr.write(`error: ${e.message}\n`); process.exit(1); });
