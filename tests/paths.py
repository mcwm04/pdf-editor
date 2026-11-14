"""Shared paths for the browser tests: everything relative to the repository."""
from pathlib import Path
TESTS = Path(__file__).resolve().parent
ROOT = TESTS.parent
APP = (ROOT / "dist" / "index.html").as_uri()   # run `npm run build` first
FIX = TESTS / "fixtures"
OUT = TESTS / "out"
OUT.mkdir(exist_ok=True)
