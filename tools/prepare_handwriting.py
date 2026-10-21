"""Build data/handwriting/lines.pkl (ink maps of handwriting lines) from the IAM and MathWriting test parquets.
Used only to make synthetic test pages; never shipped in the app."""
import paths as PATHS  # noqa: F401
import io, pickle, numpy as np, cv2, pyarrow.parquet as pq
from PIL import Image
H = PATHS.HANDWRITING
def ink_of(b, target_h):
    g = np.array(Image.open(io.BytesIO(b)).convert("L")).astype(np.float32)
    bg = np.percentile(g, 90)
    ink = np.clip((bg - g) / max(bg - np.percentile(g, 1), 30), 0, 1); ink[ink < 0.1] = 0
    ys, xs = np.nonzero(ink > 0.2)
    if len(ys) < 30: return None
    ink = ink[max(0, ys.min() - 4):ys.max() + 5, max(0, xs.min() - 4):xs.max() + 5]
    s = target_h / ink.shape[0]
    return (cv2.resize(ink, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) * 255).astype(np.uint8)
out = {"iam": [], "math": []}
for r in pq.read_table(H / "iam_test.parquet").to_pylist():
    x = ink_of(r["image"]["bytes"], 64)
    if x is not None: out["iam"].append(x)
for r in pq.read_table(H / "mathwriting_test.parquet").to_pylist():
    b = r["image"]["bytes"]; h = Image.open(io.BytesIO(b)).size[1]
    x = ink_of(b, int(np.clip(h * 0.6, 40, 140)))
    if x is not None: out["math"].append(x)
pickle.dump(out, open(H / "lines.pkl", "wb")); print({k: len(v) for k, v in out.items()})
