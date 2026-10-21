"""Fit the engine's confidence in its own page choice: P(the chosen candidate overlaps the true page by >= 0.9).
Inputs: the same candidate dumps as fit_rank_rs.py. Usage: python3 tools/fit_conf_rs.py train.pkl[,sd.pkl:half] test.pkl[,sd.pkl:rest] [--apply]"""
import paths as PATHS  # noqa: F401
import numpy as np, re, sys, os
from scipy.optimize import minimize
from fit_rank_rs import load, FEAT0

HERE = os.path.dirname(os.path.abspath(__file__)); RS = os.path.join(HERE, "..", "engine", "src", "detect.rs")


def weights():
    t = open(RS).read(); m = re.search(r"pub static mut WEIGHTS: \[f32; NF \+ 1\] = \[([^\]]*)\];", t, re.S)
    return np.array([float(x) for x in m.group(1).split(",")])


def many(spec):
    out = []; nf = 0
    for s in spec.split(","): sc, nf = load(s, 1.0); out += sc
    return out, nf


def table(scenes, w):
    X = []; y = []
    for s in scenes:
        sc = s["F"] @ w[:-1] + w[-1]; o = np.argsort(-sc); b = o[0]
        margin = sc[b] - (sc[o[1]] if len(o) > 1 else sc[b] - 5)
        X.append(np.concatenate([s["F"][b], [sc[b], min(margin, 8.0), 1.0 if s["src"][b] == 3 else 0.0]])); y.append(1.0 if s["iou"][b] >= 0.9 else 0.0)
    return np.array(X), np.array(y)


def fit(X, y, lam):
    mu = X.mean(0); sd = X.std(0) + 1e-6; Z = (X - mu) / sd
    def f(p):
        z = Z @ p[:-1] + p[-1]; pr = 1 / (1 + np.exp(-z)); eps = 1e-9
        return -np.mean(y * np.log(pr + eps) + (1 - y) * np.log(1 - pr + eps)) + lam * np.sum(p[:-1] ** 2), np.concatenate([Z.T @ (pr - y) / len(y) + 2 * lam * p[:-1], [np.mean(pr - y)]])
    r = minimize(f, np.zeros(Z.shape[1] + 1), jac=True, method="L-BFGS-B")
    wz = r.x[:-1] / sd; b = r.x[-1] - np.sum(r.x[:-1] * mu / sd)   # fold the scaling into the weights
    return np.concatenate([wz, [b]])


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    w = weights(); train, nf = many(args[0]); test = many(args[1])[0]
    Xa, ya = table(train, w); Xb, yb = table(test, w)
    print(f"chosen candidate correct: train {ya.mean():.1%}  test {yb.mean():.1%}")
    p = fit(Xa, ya, 1e-3)
    for name, X, y in (("train", Xa, ya), ("test", Xb, yb)):
        pr = 1 / (1 + np.exp(-(X @ p[:-1] + p[-1])))
        for tau in (0.3, 0.5, 0.7):
            keep = pr >= tau; print(f"  {name} tau={tau}: say 'found' on {keep.mean():.1%}; of those correct {y[keep].mean():.1%}; of the rest correct {y[~keep].mean() if (~keep).any() else float('nan'):.1%}")
    lit = "[" + ", ".join(f"{x:.4f}" for x in p) + "]"; print("CONF =", lit)
    if "--apply" in sys.argv:
        t = open(RS).read()
        t2 = re.sub(r"(pub static mut CONF: \[f32; NF \+ 4\] = )\[[^\]]*\];", lambda m: m.group(1) + lit + ";", t, flags=re.S)
        assert t2 != t; open(RS, "w").write(t2); print("written")


if __name__ == "__main__":
    main()
