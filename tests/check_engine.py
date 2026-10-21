"""CI check of the engine (app/engine-simd.wasm, run through wasmtime):
 1. each sample photo: the page is found (IoU >= 0.9 with the true page), comes out upright, and is clean (mostly white);
 2. odd inputs (tiny, very thin, blank, noise) never crash the engine and always return a page.
Usage: python3 tests/check_engine.py samples_dir"""
import os, sys, json
import cv2, numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import engine_rs  # noqa: E402


def iou(q1, q2, shape):
    m1 = np.zeros(shape, np.uint8); m2 = m1.copy()
    cv2.fillPoly(m1, [np.int32(np.round(q1))], 1); cv2.fillPoly(m2, [np.int32(np.round(q2))], 1)
    return float((m1 & m2).sum() / max(1, (m1 | m2).sum()))


def main():
    d = sys.argv[1]; eng = engine_rs.Engine_(); eng.load_model(); ok = True
    for lab in json.load(open(os.path.join(d, "labels.json"))):
        img = cv2.imread(os.path.join(d, lab["file"])); h, w = img.shape[:2]
        found, out, g, info = eng.process(img, dpi=150)
        i = iou(info[1:9].reshape(4, 2), lab["quad"], (h, w)) if found else 0.0
        want = (360 - 90 * int(round(lab["roll"] / 90.0))) % 360
        white = float((g > 235).mean())
        good = found == 1 and i >= 0.9 and int(info[17]) == want and white > 0.8
        ok &= good
        print(f"{lab['file']}: found={found} IoU={i:.3f} rotation={int(info[17])} (want {want}) white={white:.0%} warnings={engine_rs.warnings_of(info)} {'OK' if good else 'FAIL'}")
    rng = np.random.default_rng(1)
    cases = {
        "1x1": np.full((1, 1, 3), 200, np.uint8), "3x5": np.full((5, 3, 3), 90, np.uint8), "16x16": np.full((16, 16, 3), 255, np.uint8),
        "thin 50x3000": rng.integers(0, 255, (3000, 50, 3), dtype=np.uint8), "thin 3000x50": rng.integers(0, 255, (50, 3000, 3), dtype=np.uint8),
        "noise 640x480": rng.integers(0, 255, (480, 640, 3), dtype=np.uint8), "black 640x480": np.zeros((480, 640, 3), np.uint8),
        "white 640x480": np.full((480, 640, 3), 255, np.uint8), "gradient": np.dstack([np.tile(np.linspace(0, 255, 800, dtype=np.uint8), (600, 1))] * 3),
    }
    for name, im in cases.items():
        try:
            found, out, g, info = eng.process(im, dpi=150)
            good = out.shape[0] > 0 and out.shape[1] > 0
            print(f"odd input {name}: returned a {out.shape[1]}x{out.shape[0]} page  {'OK' if good else 'FAIL'}")
        except Exception as e:  # a trap in the module
            good = False; print(f"odd input {name}: CRASH {str(e)[:80]}  FAIL")
        ok &= good
        if not good: eng = engine_rs.Engine_(); eng.load_model()  # a trapped module is unusable; start a new one to keep testing
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
