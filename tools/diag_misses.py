import paths as PATHS  # noqa: F401
import cv2, numpy as np, json, sys
import engine_rs
from eval_detect_rs import S, iou_q
L = [json.loads(l) for l in open(S + "labels.jsonl")][int(sys.argv[1]):int(sys.argv[2])]
eng = engine_rs.Engine_(); ids = []
for r in L:
    if r["bg"] in ("clutter", "white-on-white", "sheet"): continue
    img = cv2.imread(S + r["id"] + ".jpg"); found, info, cands = eng.detect(img)
    iou = iou_q(info[17:25].reshape(4, 2), r["quad"], img.shape)
    if iou >= 0.9: continue
    orc = max([iou_q(c[2:10].reshape(4, 2), r["quad"], img.shape) for c in cands] or [0])
    gt = eng.quad_features(np.array(r["quad"]))
    print(r["id"], r["bg"], r["res"], "chosen_iou %.2f oracle %.2f | gt score %.2f chosen score %.2f | gt hitmin %.2f rec %.2f prec %.2f outpaper %.2f" % (iou, orc, gt[-1], info[2], gt[0], gt[14], gt[15], gt[16]), "tags", [t for t in r["tags"]][:4])
    ids.append(r["id"])
print(" ".join(ids))
