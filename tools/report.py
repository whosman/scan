"""Summarise e2e results by condition. usable = page content matches the clean page (NCC >= tau) and is upright."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import json, sys, collections, numpy as np
res = list({j["id"]: j for j in (json.loads(l) for l in open(sys.argv[1]))}.values())
L = {json.loads(l)["id"]: json.loads(l) for l in open(str(PATHS.SUITE / "labels.jsonl"))}
good = [r["best"] for r in res if r["iou"] >= 0.95]
tau = float(sys.argv[2]) if len(sys.argv) > 2 else round(float(np.percentile(good, 5)) - 0.05, 3)
def flags(r):
    det = r["iou"] >= 0.9
    upright = r["best_rot"] == 0
    content = r["best"] >= tau
    return det, upright, content, upright and content
tot = np.array([flags(r) for r in res]).mean(0)
print(f"n={len(res)}  tau={tau}  page found (IoU>=0.9) {tot[0]:.1%}  upright {tot[1]:.1%}  content ok {tot[2]:.1%}  USABLE {tot[3]:.1%}")
warned_bad = np.mean([bool(r["warn"]) for r in res if not flags(r)[3]]) if any(not flags(r)[3] for r in res) else 0
print(f"of the unusable pages, {warned_bad:.1%} carried a retake warning; median time {np.median([r['t'] for r in res]):.2f}s")
cat = collections.defaultdict(list)
for r in res:
    m = L[r["id"]]
    keys = ["bg:" + m["bg"], "res:" + "x".join(sorted(m["res"].split("x"), key=int)), "src:" + m["src"], "paper:" + m["paper"].split("/")[0],
            "pen:" + (m["paper"].split("/")[1] if "/" in m["paper"] else "print"), "frame:" + ("cut-off" if m["out_of_frame"] else "inside")]
    keys += ["tag:" + t for t in m["tags"]]
    for k in keys: cat[k].append(flags(r))
print(f"{'condition':26s} {'n':>5s} {'found':>7s} {'upright':>8s} {'usable':>7s}")
for k in sorted(cat):
    a = np.array(cat[k]).mean(0); print(f"{k:26s} {len(cat[k]):5d} {a[0]:7.1%} {a[1]:8.1%} {a[3]:7.1%}")
