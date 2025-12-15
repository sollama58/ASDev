#!/bin/bash
# ASDev Stop Script

echo "Stopping ASDev..."

# Stop Node.js server
pkill -f "node src/index.js" 2>/dev/null || true
pkill -f "node server.js" 2>/dev/null || true

# Stop Vanity Grinder
pkill -f "asdf-vanity-grinder" 2>/dev/null || true

echo "Stopped."
