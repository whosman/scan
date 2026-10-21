import paths as PATHS  # noqa: F401
import cv2, numpy as np, csv, gzip, sys, pickle
import engine_rs
from eval_detect_rs import iou_q
root = str(PATHS.SMARTDOC) + "/"; want = set(open(root + "sample.txt").read().split())
rows = [r for r in csv.DictReader(gzip.open(root + "metadata.csv.gz", "rt")) if r["image_path"] in want and r["bg_name"] == sys.argv[2]]
eng = engine_rs.Engine_(); tiles = []; k = 0
for r in rows[::7]:
    img = cv2.imread(root + r["image_path"]); gt = np.float32([[r["tl_x"], r["tl_y"]], [r["tr_x"], r["tr_y"]], [r["br_x"], r["br_y"]], [r["bl_x"], r["bl_y"]]])
    found, info, cands = eng.detect(img); iou = iou_q(info[17:25].reshape(4, 2), gt, img.shape)
    if iou >= 0.9: continue
    ci = [iou_q(c[2:10].reshape(4, 2), gt, img.shape) for c in cands]
    d = img.copy(); cv2.polylines(d, [np.int32(gt)], True, (0, 255, 0), 3); cv2.polylines(d, [np.int32(info[17:25].reshape(4, 2))], True, (0, 0, 255), 3)
    if ci: cv2.polylines(d, [np.int32(cands[int(np.argmax(ci))][2:10].reshape(4, 2))], True, (255, 120, 0), 2)
    s = 520 / d.shape[1]; d = cv2.resize(d, None, fx=s, fy=s); cv2.putText(d, f"iou {iou:.2f} oracle {max(ci) if ci else 0:.2f}", (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    tiles.append(d); k += 1
    if k == 4: break
rows2 = [np.hstack(tiles[i:i + 2]) for i in range(0, len(tiles) - len(tiles) % 2, 2)]
cv2.imwrite(sys.argv[1], np.vstack(rows2))
