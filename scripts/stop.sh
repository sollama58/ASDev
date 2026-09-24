#!/bin/sh
# Stop the processes scripts/start.sh launched.
pkill -f "node src/index.js" 2>/dev/null || true
pkill -f "node src/worker.js" 2>/dev/null || true
pkill -f "node src/grinder.js" 2>/dev/null || true
echo "Stopped."
