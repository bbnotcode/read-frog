#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title 启动 ReadFrog ChatGPT
# @raycast.mode silent
# @raycast.packageName ReadFrog
# @raycast.icon ▶️
# @raycast.description 按需启动本地订阅服务，保留登录和每日预算
source "$(dirname "$0")/config.sh"
exec "$READFROG_NODE" "$READFROG_SCRIPT_DIR/service.mjs" start
