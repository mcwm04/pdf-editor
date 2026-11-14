"""Shared paths for the browser tests: everything relative to the repository."""
from pathlib import Path
TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
APP = (ROOT / "dist" / "index.html").as_uri()   # run `npm run build` first
FIX = TESTS / "fixtures"
OUT = TESTS / "out"
OUT.mkdir(exist_ok=True)

# Browser: Playwright's own Chromium if installed, otherwise Chrome for Testing (scripts/setup.sh fallback)
# or any CHROME_PATH you set.
import glob, os
def _chrome():
    if os.environ.get("CHROME_PATH"): return os.environ["CHROME_PATH"]
    found = sorted(glob.glob(os.path.expanduser("~/.cache/chrome-for-testing/chrome/*/chrome-linux64/chrome")))
    if found and not glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium*")): return found[-1]
    return None
LAUNCH = {"executable_path": _chrome()} if _chrome() else {}
