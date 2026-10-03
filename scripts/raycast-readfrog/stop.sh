#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title 停止 ReadFrog ChatGPT
# @raycast.mode silent
# @raycast.packageName ReadFrog
# @raycast.icon ⏹️
# @raycast.description 停止本地服务，不清除登录凭据
source "$(dirname "$0")/config.sh"
exec "$READFROG_NODE" "$READFROG_SCRIPT_DIR/service.mjs" stop
