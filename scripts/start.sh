#!/bin/bash
# ASDev Startup Script
# Starts Redis, Vanity Grinder, and the main server

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
GRINDER_DIR="$PROJECT_DIR/asdf-vanity-grinder"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== ASDev Startup ===${NC}"

# 1. Check Redis
echo -e "${YELLOW}Checking Redis...${NC}"
if ! redis-cli ping > /dev/null 2>&1; then
    echo "Starting Redis..."
    redis-server --daemonize yes
    sleep 1
fi
echo -e "${GREEN}Redis: OK${NC}"

# 2. Start Vanity Grinder (if enabled)
if [ "$VANITY_GRINDER_ENABLED" = "true" ]; then
    echo -e "${YELLOW}Starting Vanity Grinder...${NC}"

    GRINDER_PORT="${VANITY_GRINDER_PORT:-8080}"
    GRINDER_API_KEY="${VANITY_GRINDER_API_KEY:-}"
    GRINDER_THREADS="${VANITY_GRINDER_THREADS:-1}"
    GRINDER_MIN_POOL="${VANITY_POOL_MIN_SIZE:-10}"

    # Check if grinder is already running
    if pgrep -f "asdf-vanity-grinder" > /dev/null; then
        echo -e "${YELLOW}Vanity Grinder already running${NC}"
    else
        if [ -f "$GRINDER_DIR/target/release/asdf-vanity-grinder" ]; then
            cd "$GRINDER_DIR"

            # Start with low priority
            nice -n 19 ionice -c 3 ./target/release/asdf-vanity-grinder pool \
                --file vanity_pool.json \
                --port "$GRINDER_PORT" \
                --api-key "$GRINDER_API_KEY" \
                --min-pool "$GRINDER_MIN_POOL" \
                --threads "$GRINDER_THREADS" \
                > grinder.log 2>&1 &

            echo -e "${GREEN}Vanity Grinder started (port $GRINDER_PORT, threads $GRINDER_THREADS)${NC}"
            cd "$PROJECT_DIR"
        else
            echo -e "${RED}Vanity Grinder binary not found. Skipping...${NC}"
        fi
    fi
fi

# 3. Start the main server
echo -e "${YELLOW}Starting ASDev...${NC}"
cd "$PROJECT_DIR"
node src/index.js
