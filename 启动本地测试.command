#!/bin/zsh
cd -- "$(dirname "$0")"
./.venv/bin/python dev.py start || exit 1
open http://127.0.0.1:18787
