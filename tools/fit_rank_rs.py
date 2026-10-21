"""Fit the weights of the engine's candidate scorer.
Listwise: in each scene the softmax over candidate scores should put its mass on candidates whose IoU with the true page is >= GOOD.
Usage: python3 tools/fit_rank_rs.py train.pkl [test.pkl] [--apply]   (--apply writes the weights into engine/src/detect.rs)"""
import paths as PATHS  # noqa: F401
import numpy as np, pickle, sys, re, os
from scipy.optimize import minimize
from scipy.special import logsumexp

GOOD = 0.9
FEAT0 = 10  # candidate row: src, score, q(8), then the NF features


def load(spec, weight=1.0):
    # spec: path, or path:half / path:rest for SmartDoc dumps (half = the frames the old ranker was fitted on)
    path, _, subset = spec.partition(":")
    d = pickle.load(open(path, "rb")); nf = d["nf"]; scenes = []
    keep = None
    if subset:
        half = set(open(str(PATHS.SMARTDOC) + "/sample_half.txt").read().split()); keep = half if subset == "half" else None
    for r in d["rows"]:
        if subset == "half" and r["id"] not in keep: continue
        if subset == "rest" and r["id"] in half: continue
        c, iou = d["dump"][r["id"]]
        if len(c) == 0: continue
        scenes.append(dict(id=r["id"], bg=r["bg"], F=c[:, FEAT0:FEAT0 + nf].astype(np.float64), src=c[:, 0], iou=iou, wt=weight))
    return scenes, nf


def objective(w, scenes, lam):
    loss = 0.0; g = np.zeros_like(w); n = 0
    for s in scenes:
        good = s["iou"] >= GOOD
        if not good.any(): continue
        F = s["F"]; sc = F @ w[:-1] + w[-1]; wt = s.get("wt", 1.0)
        lz = logsumexp(sc); lg = logsumexp(sc[good])
        pz = np.exp(sc - lz); pg = np.exp(sc[good] - lg)
        loss += wt * (lz - lg); n += wt
        g[:-1] += wt * (pz @ F - pg @ F[good]); g[-1] += wt * (pz.sum() - pg.sum())
    loss /= max(n, 1); g /= max(n, 1)
    loss += lam * np.sum(w[:-1] ** 2); g[:-1] += 2 * lam * w[:-1]
    return loss, g


def pick_rate(w, scenes, by_bg=False):
    ok = []; res = {}
    for s in scenes:
        best = int(np.argmax(s["F"] @ w[:-1] + w[-1])); hit = s["iou"][best] >= GOOD; ok.append(hit)
        res.setdefault(s["bg"], []).append(hit)
    out = np.mean(ok)
    return (out, {k: float(np.mean(v)) for k, v in res.items()}) if by_bg else out


def oracle(scenes): return np.mean([(s["iou"] >= GOOD).any() for s in scenes])


def main():
    # usage: fit_rank_rs.py train1[,train2:half...] [test1,test2:rest...] [--apply] [--sdw 0.5]
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    sdw = float(sys.argv[sys.argv.index("--sdw") + 1]) if "--sdw" in sys.argv else 0.5
    if "--sdw" in sys.argv: args = [a for a in args if a != str(sdw) and a != sys.argv[sys.argv.index("--sdw") + 1]]
    def many(spec):
        out = []; nf = 0
        for s in spec.split(","):
            sc, nf = load(s, sdw if "smartdoc" in s or "_sd_" in s else 1.0); out += sc
        return out, nf
    train, nf = many(args[0]); test = many(args[1])[0] if len(args) > 1 else []
    print(f"train scenes {len(train)}  oracle {oracle(train):.1%}" + (f"   test scenes {len(test)}  oracle {oracle(test):.1%}" if test else ""))
    best = None
    for lam in (1e-4, 1e-3, 1e-2):
        w0 = np.zeros(nf + 1)
        r = minimize(objective, w0, args=(train, lam), jac=True, method="L-BFGS-B", options=dict(maxiter=500))
        tr = pick_rate(r.x, train); te = pick_rate(r.x, test) if test else float("nan")
        print(f"lambda {lam:g}: train picks the right page {tr:.1%}   test {te:.1%}")
        if best is None or (te if test else tr) > best[0]: best = ((te if test else tr), r.x, lam)
    w = best[1]
    print("chosen lambda", best[2])
    if test:
        a, by = pick_rate(w, test, True); print("test by group:", {k: f"{v:.0%}" for k, v in sorted(by.items())})
    lit = "[" + ", ".join(f"{x:.4f}" for x in w) + "]"
    print("weights:", lit)
    if "--apply" in sys.argv:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "engine", "src", "detect.rs"); t = open(p).read()
        t2 = re.sub(r"(pub static mut WEIGHTS: \[f32; NF \+ 1\] = )\[[^\]]*\];", lambda m: m.group(1) + lit + ";", t, flags=re.S)
        assert t2 != t; open(p, "w").write(t2); print("written to", p)


if __name__ == "__main__":
    main()