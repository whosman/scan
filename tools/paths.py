"""Repository paths. Large data lives outside git, in $HWSCAN_DATA (default: <repo>/data)."""
import os, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
PYTHON = ROOT / "python"
DATA = Path(os.environ.get("HWSCAN_DATA", ROOT / "data"))
SUITE = DATA / "suite"              # synthetic stress suite (made by tools/gen_suite.py)
RAW = DATA / "raw"                  # optional: your own real homework photos (private, never committed)
SMARTDOC = DATA / "smartdoc"        # SmartDoc 2015 ch1 frames, metadata.csv.gz, 02-edited page models
HANDWRITING = DATA / "handwriting"  # IAM + MathWriting test lines (lines.pkl); test pages only
FONTS = DATA / "fonts"              # open-licence handwriting fonts for orientation training
for p in (str(PYTHON), str(TOOLS)):
    if p not in sys.path:
        sys.path.insert(0, p)
