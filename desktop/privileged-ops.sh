#!/bin/sh
set -eu
exec /opt/avl-venv/bin/python -I -m avl_computer_use.backend.desktop_ops "$@"
