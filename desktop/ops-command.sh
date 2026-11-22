#!/bin/sh
set -eu

case "${SSH_ORIGINAL_COMMAND:-}" in
  probe|'recover x11'|'recover xfce'|'recover novnc'|'recover backend')
    printf '%s\n' "$SSH_ORIGINAL_COMMAND" | /usr/bin/sudo -n /opt/avl/desktop/privileged-ops.sh
    ;;
  *)
    exit 2
    ;;
esac
