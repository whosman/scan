"""Cache detector candidate features + IoU vs ground truth for the synthetic suite."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import cv2, numpy as np, json, sys, os, pickle, importlib
mod = importlib.import_module(sys.argv[1]); out = sys.argv[2]; lo, hi = int(sys.argv[3]), int(sys.argv[4])
S = str(PATHS.SUITE) + "/"
L = [json.loads(l) for l in open(S + "labels.jsonl")][lo:hi]
def iou(q1, q2, shape):
    m1 = np.zeros(shape[:2], np.uint8); m2 = m1.copy()
    cv2.fillPoly(m1, [np.int32(np.round(q1))], 1); cv2.fillPoly(m2, [np.int32(np.round(q2))], 1)
    u = (m1 | m2).sum(); return (m1 & m2).sum() / u if u else 0
res = pickle.load(open(out, "rb")) if os.path.exists(out) else {}
for n, r in enumerate(L):
    key = "syn/" + r["id"]
    if key in res: continue
    img = cv2.imread(S + r["id"] + ".jpg")
    c = mod.candidates(img)
    res[key] = dict(group=r["bg"], meta=r, F=np.array([f for _, f in c]) if c else np.zeros((0, len(mod.FEATURES))),
                    iou=np.array([iou(q, r["quad"], img.shape) for q, _ in c]))
    if n % 50 == 0: pickle.dump(res, open(out, "wb"))
pickle.dump(res, open(out, "wb")); print("done", len(res))
