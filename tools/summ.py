import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import sys, numpy as np, collections
d = collections.defaultdict(list); t = []
for l in open(sys.argv[1]):
    p = l.strip().split(","); d[p[1]].append(float(p[2])); t.append(float(p[3]))
a = []
for k in sorted(d):
    v = np.array(d[k]); a += list(v); print(f"{k}: n={len(v):5d} meanIoU={v.mean():.3f} IoU>=0.9={np.mean(v>=.9):.1%} IoU>=0.8={np.mean(v>=.8):.1%}")
a = np.array(a); print(f"ALL: n={len(a)} meanIoU={a.mean():.3f} IoU>=0.9={np.mean(a>=.9):.1%}  {np.mean(t)*1000:.0f} ms")
