#!/usr/bin/env bash
# Setup script for the OpenAI Codex cloud environment (paste into the environment's "Setup script" box,
# or set it to: bash scripts/codex-setup.sh). Runs while the internet is available.
set -euo pipefail
npm ci
python3 -m pip install --quiet -r tests/requirements.txt
python3 -m playwright install --with-deps chromium
npm run build
# The desktop app (desktop/) downloads Electron (~100 MB); install it only when working on desktop code:
#   (cd desktop && npm ci)
