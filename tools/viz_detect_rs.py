"""Draw the ground-truth quad (green), the engine's choice (red) and the best candidate (blue) on scenes, side by side.
Usage: python3 tools/viz_detect_rs.py out.png id1 id2 ..."""
import paths as PATHS  # noqa: F401
import cv2, numpy as np, json, sys
import engine_rs

S = str(PATHS.SUITE) + "/"
L = {json.loads(l)["id"]: json.loads(l) for l in open(S + "labels.jsonl")}
eng = engine_rs.Engine_()
tiles = []
for sid in sys.argv[2:]:
    img = cv2.imread(S + sid + ".jpg"); found, info, cands = eng.detect(img)
    d = img.copy(); lw = max(2, img.shape[1] // 300)
    cv2.polylines(d, [np.int32(np.round(np.array(L[sid]["quad"])))], True, (0, 220, 0), lw)
    cv2.polylines(d, [np.int32(np.round(info[17:25].reshape(4, 2)))], True, (0, 0, 255), lw)
    s = 360 / max(d.shape[:2]); d = cv2.resize(d, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    cv2.putText(d, f"{sid} {L[sid]['bg']} src={int(info[1])} found={found} n={len(cands)}", (4, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    canvas = np.zeros((360, 360, 3), np.uint8); canvas[:d.shape[0], :d.shape[1]] = d; tiles.append(canvas)
rows = [np.hstack(tiles[i:i + 3] + [np.zeros_like(tiles[0])] * (3 - len(tiles[i:i + 3]))) for i in range(0, len(tiles), 3)]
cv2.imwrite(sys.argv[1], np.vstack(rows))
