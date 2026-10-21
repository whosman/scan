"""End-to-end test on the synthetic suite with the Python reference (hwscan2).
Per scene: detection IoU vs ground truth, chosen rotation vs truth, content similarity (NCC of ink maps) vs the clean page,
warnings. Resumable: appends JSON lines to the output file."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import cv2, numpy as np, json, sys, os, time
import hwscan2 as hs
S = str(PATHS.SUITE) + "/"

def inkmap(g, shape):
    g = cv2.resize(g, shape[::-1], interpolation=cv2.INTER_AREA).astype(np.float32)
    return cv2.GaussianBlur(255 - g, (0, 0), 1.5)


def ncc(a, b):
    a = a - a.mean(); b = b - b.mean(); return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))


def iou(q1, q2, shape):
    if q1 is None: return 0.0
    m1 = np.zeros(shape[:2], np.uint8); m2 = m1.copy()
    cv2.fillPoly(m1, [np.int32(np.round(q1))], 1); cv2.fillPoly(m2, [np.int32(np.round(q2))], 1)
    u = (m1 | m2).sum(); return float((m1 & m2).sum() / u) if u else 0.0


CACHE = None


def main():
    lo, hi, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
    dpi = sys.argv[4] if len(sys.argv) > 4 else "120"
    global CACHE
    CACHE = sys.argv[5] if len(sys.argv) > 5 else None
    if CACHE: os.makedirs(CACHE, exist_ok=True)
    L = [json.loads(l) for l in open(S + "labels.jsonl")][lo:hi]
    args = hs.build_parser().parse_args(["x", "-o", "x.pdf", "--dpi", dpi])
    _orig = hs.refine_corners; QUAD = {}
    def rc(gray, q, search=None):
        r = _orig(gray, q, search); QUAD["q"] = r; return r
    hs.refine_corners = rc
    done = {json.loads(l)["id"] for l in open(out)} if os.path.exists(out) else set()
    f = open(out, "a")
    for r in L:
        if r["id"] in done: continue
        img = cv2.imread(S + r["id"] + ".jpg")
        ref = cv2.imread(S + "pages/" + r["page"] + ".png", 0)
        shape = (ref.shape[0] // 4, ref.shape[1] // 4); R = inkmap(ref, shape)
        t = time.time(); QUAD.clear()
        try:
            _, g, info = hs.process(img, args)
            if CACHE:  # the cleaned page before rotation, for orientation experiments without re-running detection
                g0 = hs.rot(g, (360 - int(str(info.get("orient", "0")).split()[0])) % 360)
                cv2.imwrite(f"{CACHE}/{r['id']}.png", g0)
            sc = {a: ncc(inkmap(hs.rot(g, (360 - a) % 360), shape), R) for a in (0, 90, 180, 270)}
            best = max(sc, key=sc.get)
            rec = dict(id=r["id"], rot=info.get("orient", ""), iou=round(iou(QUAD.get("q"), r["quad"], img.shape), 4), score=round(sc[0], 4), best_rot=best,
                       best=round(sc[best], 4), warn=info.get("warn", []), page=info.get("page", ""), t=round(time.time() - t, 2))
        except Exception as e:
            rec = dict(id=r["id"], rot=info.get("orient", ""), iou=0, score=0, best_rot=-1, best=0, warn=[f"ERROR {e}"], page="", t=round(time.time() - t, 2))
        f.write(json.dumps(rec) + "\n"); f.flush()


if __name__ == "__main__":
    main()
