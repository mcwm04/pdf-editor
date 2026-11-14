#!/usr/bin/env bash
# Builds the web app and runs every browser test. Exit code is non-zero if any test fails.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
cd tests
for t in e2e urdu editpdf rot; do
  echo "=== tests/$t.py"
  python3 "$t.py"
done
echo "ALL TESTS PASSED"
