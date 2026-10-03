#!/bin/bash
source "$(dirname "$0")/config.sh"
cd "$READFROG_PROJECT_DIR" || exit 1
exec "$READFROG_NODE" "$READFROG_PROJECT_DIR/scripts/chatgpt-bridge.mjs"
