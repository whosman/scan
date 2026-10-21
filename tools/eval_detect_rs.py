"""Score the engine's page detection on the synthetic suite, and (optionally) dump every candidate with its features and IoU
for learning the scorer weights. Usage: python3 tools/eval_detect_rs.py LO HI [out.pkl]"""
import paths as PATHS  # noqa: F401
import cv2, numpy as np, json, sys, pickle, time, collections
import engine_rs

S = str(PATHS.SUITE) + "/"


def iou_q(q1, q2, shape):
    m1 = np.zeros(shape[:2], np.uint8); m2 = m1.copy()
    cv2.fillPoly(m1, [np.int32(np.round(np.array(q1)))], 1); cv2.fillPoly(m2, [np.int32(np.round(np.array(q2)))], 1)
    u = (m1 | m2).sum(); return float((m1 & m2).sum() / u) if u else 0.0


def main():
    lo, hi = int(sys.argv[1]), int(sys.argv[2]); out = sys.argv[3] if len(sys.argv) > 3 else None
    L = [json.loads(l) for l in open(S + "labels.jsonl")][lo:hi]
    eng = engine_rs.Engine_()
    rows = []; dump = {}; t0 = time.time()
    for r in L:
        img = cv2.imread(S + r["id"] + ".jpg"); sh = img.shape
        found, info, cands = eng.detect(img)
        bq = info[27:35].reshape(4, 2)
        iou = iou_q(bq, r["quad"], sh) if found else 0.0
        ci = np.array([iou_q(c[2:10].reshape(4, 2), r["quad"], sh) for c in cands]) if len(cands) else np.zeros(0)
        rows.append(dict(id=r["id"], bg=r["bg"], found=int(found), iou=iou, oracle=float(ci.max()) if len(ci) else 0.0, src=int(info[1]), n=len(cands)))
        if out: dump[r["id"]] = (cands, ci)
    el = time.time() - t0
    n = len(rows); ok = np.array([x["iou"] >= 0.9 for x in rows]); orc = np.array([x["oracle"] >= 0.9 for x in rows])
    print(f"n={n}  found(IoU>=0.9) {ok.mean():.1%}   oracle (best candidate) {orc.mean():.1%}   {el / n * 1000:.0f} ms/scene")
    by = collections.defaultdict(list)
    for x, o, c in zip(rows, ok, orc): by[x["bg"]].append((o, c))
    for k in sorted(by):
        a = np.array(by[k]); print(f"  {k:16s} n={len(a):4d}  found {a[:, 0].mean():6.1%}   oracle {a[:, 1].mean():6.1%}")
    if out: pickle.dump(dict(rows=rows, dump=dump, nf=eng.nf), open(out, "wb"))


if __name__ == "__main__":
    main()
