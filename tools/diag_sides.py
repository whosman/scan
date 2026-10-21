import paths as PATHS  # noqa: F401
import cv2, numpy as np, json, sys, collections
import engine_rs
from eval_detect_rs import S, iou_q
L = [json.loads(l) for l in open(S + "labels.jsonl")][int(sys.argv[1]):int(sys.argv[2])]
eng = engine_rs.Engine_(); cnt = collections.Counter(); miss_scenes = []
def inside_frac(a, b, w, h):
    n = 40; t = np.linspace(0, 1, n); p = a[None] + (b - a)[None] * t[:, None]
    return float(((p[:, 0] >= 0) & (p[:, 0] <= w) & (p[:, 1] >= 0) & (p[:, 1] <= h)).mean())
for r in L:
    if r["bg"] in ("clutter", "white-on-white", "sheet"): continue
    img = cv2.imread(S + r["id"] + ".jpg"); H, W = img.shape[:2]; found, info, cands = eng.detect(img); s = info[6]; ww, wh = info[7], info[8]
    iou = iou_q(info[17:25].reshape(4, 2), r["quad"], img.shape)
    n = eng.call("hw_lines_count"); lines = eng.read_f32(eng.call("hw_lines_buf"), n * 3).reshape(n, 3)
    gt = np.array(r["quad"]) * s; scene_missing = 0
    for k in range(4):
        a, b = gt[k], gt[(k + 1) % 4]
        vis = inside_frac(a, b, ww, wh)
        if vis < 0.3: cnt["side outside frame"] += 1; continue
        d = (b - a) / (np.linalg.norm(b - a) + 1e-6); th0 = np.arctan2(d[0], -d[1]) % np.pi  # normal angle
        ok = False
        for c, t, rho in lines:
            dt = abs(t - th0); dt = min(dt, np.pi - dt)
            e1 = abs(a[0] * np.cos(t) + a[1] * np.sin(t) - rho); e2 = abs(b[0] * np.cos(t) + b[1] * np.sin(t) - rho)
            if dt < np.radians(3) and max(e1, e2) < 5: ok = True; break
        cnt["side has a line" if ok else "side MISSING"] += 1
        if not ok: scene_missing += 1
    if iou < 0.9: cnt["scene miss, missing sides=%d" % scene_missing] += 1
print(dict(cnt))
