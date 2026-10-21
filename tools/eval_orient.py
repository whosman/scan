"""Test up/down decisions on real handwriting (IAM + MathWriting odd split), the user's pages, and printed SmartDoc pages."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import numpy as np, cv2, glob, sys, pickle
import train_orient as T, orient_model as om, hwscan2 as hs, gen_suite
model = sys.argv[1]
rng = np.random.default_rng(int(sys.argv[2]) if len(sys.argv) > 2 else 99)
sets = {"unseen writers": T.page_set(150, 0, "test", rng)}
real = []
for f in sorted(glob.glob(str(PATHS.RAW / "*.jpg"))):
    g = cv2.resize(cv2.imread(f, 0), (1600, 2070)); n = gen_suite.flatten(g).astype(np.float32)
    ink = np.clip((236 - n) / 126 * 255, 0, 255).astype(np.uint8); real += [T.augment(ink, rng) for _ in range(5)]
sets["real pages"] = real
sets["printed (SmartDoc)"] = [cv2.resize(255 - cv2.imread(f, 0), (1600, 2262)) for f in sorted(glob.glob(str(PATHS.SMARTDOC / "02-edited" / "*.png")))]
m = om.UpDown(model)
def feats(p):
    a, n = m.logodds(p)
    small = cv2.resize(p, (600, int(600 * p.shape[0] / p.shape[1])), interpolation=cv2.INTER_AREA)
    return a, n, hs.upright_score((small > 128).astype(np.uint8))
R = {}
for name, S in sets.items():
    rows = []
    for p in S:
        rows.append((*feats(p), 1)); rows.append((*feats(cv2.rotate(p, cv2.ROTATE_180)), 0))
    R[name] = np.array(rows)
pickle.dump(R, open("/tmp/orient_eval.pkl", "wb"))
for name, A in R.items():
    lo, n, u, y = A.T
    mean = lo / np.maximum(n, 1)
    gated = np.where(np.abs(mean) >= 1.5, np.sign(lo) * 10 + u * 8, u * 8 + lo / 400)
    print(f"{name:20s} n={len(y):3d} model={np.mean((lo > 0) == y):.1%} layout={np.mean((u > 0) == y):.1%} combined={np.mean(((lo / 40 + u * 8) > 0) == y):.1%} gated={np.mean((gated > 0) == y):.1%}")
