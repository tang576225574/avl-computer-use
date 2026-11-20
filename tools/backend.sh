#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

case "${1:-}" in
  desktop)
    shift
    exec python3 -m uvicorn avl_computer_use.backend.server:create_app --factory \
      --host "${AVL_BIND_ADDRESS:-127.0.0.1}" --port "${AVL_PORT:-8080}" \
      --ws-max-size 65536 --ws-per-message-deflate false "$@"
    ;;
  simulator)
    shift
    exec python3 -m avl_computer_use.backend.simulator "$@"
    ;;
  *)
    echo "Usage: bash tools/backend.sh desktop|simulator [options]" >&2
    exit 2
    ;;
esac
