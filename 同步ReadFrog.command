#!/usr/bin/env bash
set -euo pipefail
readfrog_repo="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  printf '找不到 Node.js，请先安装 Node.js 26。\n' >&2
  exit 1
fi
readfrog_exit=0
node "$readfrog_repo/scripts/sync-upstream.mjs" "$@" || readfrog_exit=$?
if [[ -t 0 && $# -eq 0 ]]; then
  printf '\n按回车键关闭窗口…'
  read -r _
fi
exit "$readfrog_exit"
