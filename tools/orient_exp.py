"""Orientation accuracy with the true page quad given (so detection cannot interfere). Usage: python3 tools/_orient_exp.py LO HI"""
import paths as PATHS  # noqa: F401
import cv2, numpy as np, json, sys
import engine_rs
from evalcommon import inkmap, ncc, S
from e2e_rs import rot
L = [json.loads(l) for l in open(S + "labels.jsonl")][int(sys.argv[1]):int(sys.argv[2])]
eng = engine_rs.Engine_(); eng.load_model(); ok = n = 0; wrong = {}
for r in L:
    if r["out_of_frame"]: continue
    img = cv2.imread(S + r["id"] + ".jpg"); ref = cv2.imread(S + "pages/" + r["page"] + ".png", 0)
    shape = (ref.shape[0] // 4, ref.shape[1] // 4); R = inkmap(ref, shape)
    import os; found, out, g, info = eng.process(img, quad=r["quad"], dpi=int(os.environ.get('DPI', 120)), margin=float(os.environ.get('MARGIN', 10)))
    sc = {a: ncc(inkmap(rot(g, (360 - a) % 360), shape), R) for a in (0, 90, 180, 270)}
    best = max(sc, key=sc.get)
    # only count scenes where the content matches at all
    if sc[best] < 0.25: continue
    n += 1; ok += best == 0
    if best != 0: wrong[best] = wrong.get(best, 0) + 1
print(f"scenes {n}  upright {ok / n:.1%}   needed rotation when wrong: {wrong}")

