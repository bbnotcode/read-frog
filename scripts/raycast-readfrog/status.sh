#!/bin/bash
# @raycast.schemaVersion 1
# @raycast.title 查看 ReadFrog ChatGPT 状态
# @raycast.mode fullOutput
# @raycast.packageName ReadFrog
# @raycast.icon 📊
# @raycast.description 查看服务、登录及每日阅读预算
source "$(dirname "$0")/config.sh"
exec "$READFROG_NODE" "$READFROG_SCRIPT_DIR/service.mjs" status
