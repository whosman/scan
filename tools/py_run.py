"""Run the Python reference on files; write cleaned page PGM + info JSONL (same layout as node_run.js)."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import sys, os, json, cv2, time, numpy as np
import hwscan2 as hs
out, dpi, files = sys.argv[1], sys.argv[2], sys.argv[3:]
os.makedirs(out, exist_ok=True)
args = hs.build_parser().parse_args(["x", "-o", "x.pdf", "--dpi", dpi])
_orig = hs.refine_corners
QUAD = {}
def rc(gray, q, search=None):
    r = _orig(gray, q, search); QUAD["q"] = r.tolist(); return r
hs.refine_corners = rc
for f in files:
    t = time.time(); QUAD.clear()
    img = cv2.imread(f)
    _, g, info = hs.process(img, args)
    cv2.imwrite(os.path.join(out, os.path.basename(f).rsplit(".", 1)[0] + ".pgm"), g)
    info["quad"] = QUAD.get("q"); info["ms"] = int(1000 * (time.time() - t))
    open(os.path.join(out, "info.jsonl"), "a").write(json.dumps({"file": os.path.basename(f), **info}, default=float) + "\n")
