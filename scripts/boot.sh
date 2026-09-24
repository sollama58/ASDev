#!/bin/sh
# Start a ShitPad process with the wallet key kept out of its environment.
#
#   startCommand: sh scripts/boot.sh src/worker.js
#
# Deleting a variable from process.env does not remove it from the process's initial
# environment block, which stays readable at /proc/<pid>/environ for the life of the process
# (by anything running as the same user: a shell in the container, a compromised dependency).
# exec() rebuilds that block from the environment passed to it, so this script parks the key
# in a private tmpfs file, drops the variable, and execs node. The signer reads the file and
# deletes it during boot; from then on the running process has the key neither in its
# environment nor on disk -- only in memory, where signing needs it.
#
# Does nothing special when DEV_WALLET_PRIVATE_KEY is unset (key file, Vault, or a key-free
# API process), so it is safe as the start command everywhere.
set -eu

ENTRY="${1:-src/index.js}"

if [ -n "${DEV_WALLET_PRIVATE_KEY:-}" ] && [ -z "${DEV_WALLET_KEY_FILE:-}" ]; then
    dir=/dev/shm
    if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then
        dir="${TMPDIR:-/tmp}"
    fi
    keyfile="$dir/.wallet-key.$$"
    umask 077
    printf '%s' "$DEV_WALLET_PRIVATE_KEY" > "$keyfile"
    unset DEV_WALLET_PRIVATE_KEY
    DEV_WALLET_KEY_FILE="$keyfile"
    DEV_WALLET_KEY_FILE_EPHEMERAL=1
    export DEV_WALLET_KEY_FILE DEV_WALLET_KEY_FILE_EPHEMERAL
fi

exec node "$ENTRY"
