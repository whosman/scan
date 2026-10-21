"""SmartDoc 2015 ch1 benchmark: IoU of detected quad vs ground truth, written incrementally to a CSV."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import cv2, numpy as np, csv, gzip, sys, time, importlib, os
mod = importlib.import_module(sys.argv[1]); out = sys.argv[2]
listfile = sys.argv[3] if len(sys.argv) > 3 else str(PATHS.SMARTDOC / "sample.txt")
root = str(PATHS.SMARTDOC) + "/"
want = set(open(listfile).read().split())
rows = [r for r in csv.DictReader(gzip.open(root + "metadata.csv.gz", "rt")) if r["image_path"] in want]
def iou(q1, q2, shape):
    m1 = np.zeros(shape[:2], np.uint8); m2 = m1.copy()
    cv2.fillPoly(m1, [np.int32(np.round(q1))], 1); cv2.fillPoly(m2, [np.int32(np.round(q2))], 1)
    u = (m1 | m2).sum(); return (m1 & m2).sum() / u if u else 0
done = set()
if os.path.exists(out):
    done = {l.split(",")[0] for l in open(out)}
f = open(out, "a")
for r in rows:
    if r["image_path"] in done: continue
    img = cv2.imread(root + r["image_path"])
    gt = np.float32([[r["tl_x"], r["tl_y"]], [r["tr_x"], r["tr_y"]], [r["br_x"], r["br_y"]], [r["bl_x"], r["bl_y"]]])
    t = time.time(); q, how = mod.find_page(img); dt = time.time() - t
    j = 0.0 if q is None else iou(q, gt, img.shape)
    f.write(f"{r['image_path']},{r['bg_name']},{j:.4f},{dt:.3f},{how.replace(',', ';')}\n"); f.flush()
