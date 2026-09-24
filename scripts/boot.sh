#!/bin/sh
# Start a ShitPad process with its wallet secrets kept out of the process environment.
#
#   startCommand: sh scripts/boot.sh src/worker.js
#
# Deleting a variable from process.env does not remove it from the process's initial
# environment block, which stays readable at /proc/<pid>/environ for the life of the process
# (by anything running as the same user: a shell in the container, a compromised dependency).
# exec() rebuilds that block from the environment passed to it, so this script parks each
# secret in a private tmpfs file, drops the variable, and execs node. The signer reads the
# files and deletes them during boot; from then on the running process has the secrets neither
# in its environment nor on disk -- only in memory, where signing needs them.
#
# Handles DEV_WALLET_PRIVATE_KEY (becomes DEV_WALLET_KEY_FILE), DEV_WALLET_KEY_PASSPHRASE and
# VAULT_TOKEN (become <NAME>_FILE). Does nothing for variables that are not set, so it is safe
# as the start command everywhere, including a key-free API process.
set -eu

ENTRY="${1:-src/index.js}"

dir=/dev/shm
if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then
    dir="${TMPDIR:-/tmp}"
fi
umask 077
parked=0

if [ -n "${DEV_WALLET_PRIVATE_KEY:-}" ] && [ -z "${DEV_WALLET_KEY_FILE:-}" ]; then
    keyfile="$dir/.wallet-key.$$"
    printf '%s' "$DEV_WALLET_PRIVATE_KEY" > "$keyfile"
    unset DEV_WALLET_PRIVATE_KEY
    DEV_WALLET_KEY_FILE="$keyfile"
    export DEV_WALLET_KEY_FILE
    parked=1
fi

if [ -n "${DEV_WALLET_KEY_PASSPHRASE:-}" ]; then
    f="$dir/.wallet-passphrase.$$"
    printf '%s' "$DEV_WALLET_KEY_PASSPHRASE" > "$f"
    unset DEV_WALLET_KEY_PASSPHRASE
    DEV_WALLET_KEY_PASSPHRASE_FILE="$f"
    export DEV_WALLET_KEY_PASSPHRASE_FILE
    parked=1
fi

if [ -n "${VAULT_TOKEN:-}" ]; then
    f="$dir/.vault-token.$$"
    printf '%s' "$VAULT_TOKEN" > "$f"
    unset VAULT_TOKEN
    VAULT_TOKEN_FILE="$f"
    export VAULT_TOKEN_FILE
    parked=1
fi

if [ "$parked" = 1 ]; then
    # Tells the signer these files are its to delete once read.
    DEV_WALLET_SECRETS_EPHEMERAL=1
    export DEV_WALLET_SECRETS_EPHEMERAL
fi

exec node "$ENTRY"
