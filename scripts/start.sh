#!/bin/sh
# Local development start: Redis if it is not running, the grinder if enabled, then the API
# with background tasks in-process (SERVER_MODE=full). Production runs from render.yaml.
set -eu
cd "$(dirname "$0")/.."

if ! redis-cli ping >/dev/null 2>&1; then
    echo "Starting Redis..."
    redis-server --daemonize yes >/dev/null
    sleep 1
fi

if [ "${VANITY_GRINDER_ENABLED:-false}" = "true" ]; then
    if pgrep -f "node src/grinder.js" >/dev/null; then
        echo "Grinder already running"
    else
        echo "Starting grinder..."
        SERVER_MODE=grinder nohup node src/grinder.js > grinder.log 2>&1 &
    fi
fi

echo "Starting ASDev..."
exec sh scripts/boot.sh src/index.js
