#!/usr/bin/env bash
# One-shot setup: Python venv with ipykernel, plus npm deps for the TS spike.
set -euo pipefail

cd "$(dirname "$0")"

# Python side: managed venv via uv, isolated from the rest of the system.
echo ">>> creating .venv with Python 3.12"
uv venv --python 3.12 .venv
echo ">>> installing ipykernel"
uv pip install --python .venv/bin/python ipykernel jupyter_client

# TS side
echo ">>> installing TS deps"
npm install --silent

echo
echo "ready. run the spike:"
echo "  npm run spike"
