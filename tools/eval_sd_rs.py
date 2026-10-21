"""Score the engine's page detection on SmartDoc 2015 frames (real photographs with true corners), and dump candidates for training.
Usage: python3 tools/eval_sd_rs.py [out.pkl] [half|rest|all]   (half = the frames listed in sample_half.txt)"""
import paths as PATHS  # noqa: F401
import cv2, numpy as np, csv, gzip, sys, pickle, time, collections
import engine_rs
from eval_detect_rs import iou_q

root = str(PATHS.SMARTDOC) + "/"
which = sys.argv[2] if len(sys.argv) > 2 else "all"
allf = open(root + "sample.txt").read().split(); half = set(open(root + "sample_half.txt").read().split())
want = set(allf) if which == "all" else (half if which == "half" else set(allf) - half)
only = sys.argv[3] if len(sys.argv) > 3 else None
rows = [r for r in csv.DictReader(gzip.open(root + "metadata.csv.gz", "rt")) if r["image_path"] in want and (only is None or r["bg_name"] == only)]
eng = engine_rs.Engine_(); res = []; dump = {}; t0 = time.time()
for r in rows:
    img = cv2.imread(root + r["image_path"]); h, w = img.shape[:2]
    gt = np.float32([[r["tl_x"], r["tl_y"]], [r["tr_x"], r["tr_y"]], [r["br_x"], r["br_y"]], [r["bl_x"], r["bl_y"]]])
    found, info, cands = eng.detect(img)
    iou = iou_q(info[27:35].reshape(4, 2), gt, img.shape) if found else 0.0
    ci = np.array([iou_q(c[2:10].reshape(4, 2), gt, img.shape) for c in cands]) if len(cands) else np.zeros(0)
    res.append(dict(id=r["image_path"], bg=r["bg_name"], iou=iou, oracle=float(ci.max()) if len(ci) else 0.0))
    dump[r["image_path"]] = (cands, ci)
n = len(res); ok = np.array([x["iou"] >= 0.9 for x in res]); orc = np.array([x["oracle"] >= 0.9 for x in res])
print(f"SmartDoc {which}: n={n}  found(IoU>=0.9) {ok.mean():.1%}   oracle {orc.mean():.1%}   {(time.time() - t0) / n * 1000:.0f} ms/frame")
by = collections.defaultdict(list)
for x, o, c in zip(res, ok, orc): by[x["bg"]].append((o, c))
for k in sorted(by): a = np.array(by[k]); print(f"  {k:14s} n={len(a):4d}  found {a[:, 0].mean():6.1%}   oracle {a[:, 1].mean():6.1%}")
if len(sys.argv) > 1 and sys.argv[1] != "-": pickle.dump(dict(rows=[dict(id=x["id"], bg=x["bg"]) for x in res], dump=dump, nf=eng.nf), open(sys.argv[1], "wb"))
