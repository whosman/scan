"""Fit ranker weights on SmartDoc + synthetic candidate features. Held-out: 1/3 of SmartDoc videos, 1/3 of synthetic scenes."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import pickle, sys, numpy as np, json
import hwscan2 as d
def load(path, kind):
    R = []
    for k, v in pickle.load(open(path, "rb")).items():
        g = v.get("bg") or v.get("group")
        R.append((k, kind + ":" + g, v["F"].astype(np.float64), v["iou"]))
    return R
def pick(F, w): return int(np.argmax(F @ w)) if len(F) else -1
def acc(R, w, thr=0.9):
    return np.mean([(iou[pick(F, w)] >= thr) if len(F) else False for _, _, F, iou in R])
def miou(R, w): return np.mean([iou[pick(F, w)] if len(F) else 0 for _, _, F, iou in R])
def fit(R, w0, iters, seed=0):
    rng = np.random.default_rng(seed); w = w0.copy(); best = acc(R, w) + 0.1 * miou(R, w)
    for i in range(iters):
        c = w.copy(); j = rng.integers(len(w)); c[j] += rng.normal(0, 0.4 if i < iters / 2 else 0.1)
        s = acc(R, c) + 0.1 * miou(R, c)
        if s >= best: w, best = c, s
    return w
if __name__ == "__main__":
    S = load(sys.argv[2], "sd"); Y = load(sys.argv[3], "syn")
    rng = np.random.default_rng(1)
    vids = sorted({k.rsplit("/", 1)[0] for k, *_ in S}); rng.shuffle(vids); tv = set(vids[: len(vids) // 3])
    trS = [r for r in S if r[0].rsplit("/", 1)[0] not in tv]; teS = [r for r in S if r[0].rsplit("/", 1)[0] in tv]
    trY = [r for r in Y if int(r[0][-5:]) % 3 != 0]; teY = [r for r in Y if int(r[0][-5:]) % 3 == 0]
    tr, te = trS + trY, teS + teY
    w0 = d.WEIGHTS.astype(np.float64)
    for name, T in (("SmartDoc test", teS), ("synthetic test", teY)):
        print(f"{name}: n={len(T)} oracle={np.mean([len(i) and i.max() >= .9 for *_, i in T]):.1%} hand={acc(T, w0):.1%}")
    w = fit(tr, w0, int(sys.argv[1]) if len(sys.argv) > 1 else 3000)
    for name, T in (("SmartDoc test", teS), ("synthetic test", teY)):
        print(f"{name}: fitted={acc(T, w):.1%} mIoU={miou(T, w):.3f}")
    groups = sorted({r[1] for r in te})
    for g in groups:
        sub = [r for r in te if r[1] == g]
        print(f"  {g:28s} n={len(sub):3d} fitted={acc(sub, w):.1%} oracle={np.mean([len(r[3]) and r[3].max() >= .9 for r in sub]):.1%}")
    print("weights", json.dumps([round(float(x), 4) for x in w]))
    np.save("weights_fit8.npy", w)
