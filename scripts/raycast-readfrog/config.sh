# Local configuration. Paths are derived from this directory by default.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
READFROG_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export READFROG_PROJECT_DIR="${READFROG_PROJECT_DIR:-$READFROG_SCRIPT_DIR/../..}"
export READFROG_NODE="${READFROG_NODE:-$(command -v node)}"
