"""Cache candidate features + IoU vs ground truth for SmartDoc frames (for weight fitting)."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import cv2, numpy as np, csv, gzip, sys, os, pickle, importlib
mod = importlib.import_module(sys.argv[1]); out = sys.argv[2]
root = str(PATHS.SMARTDOC) + "/"
want = set(open(root + "sample_half.txt").read().split())
rows = [r for r in csv.DictReader(gzip.open(root + "metadata.csv.gz", "rt")) if r["image_path"] in want]
def iou(q1, q2, shape):
    m1 = np.zeros(shape[:2], np.uint8); m2 = m1.copy()
    cv2.fillPoly(m1, [np.int32(np.round(q1))], 1); cv2.fillPoly(m2, [np.int32(np.round(q2))], 1)
    u = (m1 | m2).sum(); return (m1 & m2).sum() / u if u else 0
res = pickle.load(open(out, "rb")) if os.path.exists(out) else {}
for n, r in enumerate(rows):
    if r["image_path"] in res: continue
    img = cv2.imread(root + r["image_path"])
    gt = np.float32([[r["tl_x"], r["tl_y"]], [r["tr_x"], r["tr_y"]], [r["br_x"], r["br_y"]], [r["bl_x"], r["bl_y"]]])
    c = mod.candidates(img)
    res[r["image_path"]] = dict(bg=r["bg_name"], F=np.array([f for _, f in c]) if c else np.zeros((0, len(mod.FEATURES))),
                                iou=np.array([iou(q, gt, img.shape) for q, _ in c]))
    if n % 50 == 0: pickle.dump(res, open(out, "wb"))
pickle.dump(res, open(out, "wb")); print("done", len(res))
