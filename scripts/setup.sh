#!/usr/bin/env bash
# One-time environment setup: Claude Code cloud environments ("Setup script" field), GitHub Actions, or a new machine.
#   Claude Code cloud: set the environment's Setup script to:  bash scripts/setup.sh
# Installs JS packages, the Python test tools and a Chromium for the browser tests, then builds the app.
set -uo pipefail
cd "$(dirname "$0")/.."

npm ci || exit 1

# Python test tools. Ubuntu 24.04 marks the system Python as "externally managed", hence the flag.
python3 -m pip install --quiet -r tests/requirements.txt 2>/dev/null \
  || python3 -m pip install --quiet --break-system-packages -r tests/requirements.txt || exit 1

# A browser for the tests. Playwright's own download host may be blocked by a network allowlist,
# so fall back to Chrome for Testing (served from storage.googleapis.com, which Claude Code's
# default "Trusted" network allows). tests/paths.py finds either one.
if ! python3 -m playwright install --with-deps chromium; then
  echo "Playwright browser download failed; installing Chrome for Testing instead"
  python3 -m playwright install-deps chromium || true
  npx -y @puppeteer/browsers install chrome@stable --path "$HOME/.cache/chrome-for-testing" || true
fi

npm run build || exit 1
echo "Setup complete"
exit 0
