"""End-to-end test of the engine on the synthetic suite, same output format as tools/e2e.py (so tools/report.py works on it).
Usage: python3 tools/e2e_rs.py LO HI out.jsonl [dpi]"""
import paths as PATHS  # noqa: F401
import cv2, numpy as np, json, sys, os, time
import engine_rs
from evalcommon import inkmap, ncc, iou, S

ROT = {0: None, 90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def rot(g, a): return g if ROT[a] is None else cv2.rotate(g, ROT[a])


def main():
    lo, hi, out = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]; dpi = int(sys.argv[4]) if len(sys.argv) > 4 else 120
    L = [json.loads(l) for l in open(S + "labels.jsonl")][lo:hi]
    eng = engine_rs.Engine_(); eng.load_model()
    done = {json.loads(l)["id"] for l in open(out)} if os.path.exists(out) else set()
    f = open(out, "a")
    for r in L:
        if r["id"] in done: continue
        img = cv2.imread(S + r["id"] + ".jpg"); ref = cv2.imread(S + "pages/" + r["page"] + ".png", 0)
        shape = (ref.shape[0] // 4, ref.shape[1] // 4); R = inkmap(ref, shape)
        t = time.time()
        found, outp, g, info = eng.process(img, dpi=dpi)
        q = info[1:9].reshape(4, 2) if found else None
        sc = {a: ncc(inkmap(rot(g, (360 - a) % 360), shape), R) for a in (0, 90, 180, 270)}
        best = max(sc, key=sc.get)
        rec = dict(id=r["id"], rot=str(int(info[17])), iou=round(iou(q, r["quad"], img.shape), 4), score=round(sc[0], 4), best_rot=best, best=round(sc[best], 4),
                   warn=engine_rs.warnings_of(info), page="found" if found else "full frame", t=round(time.time() - t, 3))
        f.write(json.dumps(rec) + "\n"); f.flush()


if __name__ == "__main__":
    main()
