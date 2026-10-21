"""Draw ground truth (green), chosen quad (red), best candidate (blue) and the Hough lines (yellow, thin)."""
import paths as PATHS  # noqa: F401
import cv2, numpy as np, json, sys
import engine_rs
from eval_detect_rs import S, iou_q
L = {json.loads(l)["id"]: json.loads(l) for l in open(S + "labels.jsonl")}
eng = engine_rs.Engine_(); tiles = []
for sid in sys.argv[2:]:
    r = L[sid]; img = cv2.imread(S + sid + ".jpg"); found, info, cands = eng.detect(img); s = info[6]
    n = eng.call("hw_lines_count"); lines = eng.read_f32(eng.call("hw_lines_buf"), n * 3).reshape(n, 3)
    ws = cv2.resize(img, (int(info[7]), int(info[8])), interpolation=cv2.INTER_AREA); big = cv2.resize(ws, None, fx=1.6, fy=1.6); k = 1.6
    for c, t, rho in lines:
        a, b = np.cos(t), np.sin(t); x0, y0 = a * rho, b * rho
        cv2.line(big, (int((x0 - 1000 * b) * k), int((y0 + 1000 * a) * k)), (int((x0 + 1000 * b) * k), int((y0 - 1000 * a) * k)), (0, 220, 255), 1)
    cv2.polylines(big, [np.int32(np.array(r["quad"]) * s * k)], True, (0, 255, 0), 2)
    oi = [iou_q(c[2:10].reshape(4, 2), r["quad"], img.shape) for c in cands]; bi = int(np.argmax(oi)) if oi else 0
    if oi: cv2.polylines(big, [np.int32(cands[bi][2:10].reshape(4, 2) * s * k)], True, (255, 120, 0), 2)
    cv2.polylines(big, [np.int32(info[17:25].reshape(4, 2) * s * k)], True, (0, 0, 255), 2)
    cv2.putText(big, f"{sid} {r['bg']} oracle={max(oi) if oi else 0:.2f} lines={n}", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    c = np.zeros((520, 520, 3), np.uint8); c[:big.shape[0], :big.shape[1]] = big[:520, :520]; tiles.append(c)
rows = [np.hstack(tiles[i:i + 2] + [np.zeros_like(tiles[0])] * (2 - len(tiles[i:i + 2]))) for i in range(0, len(tiles), 2)]
cv2.imwrite(sys.argv[1], np.vstack(rows))
