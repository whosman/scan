"""Multi-writer handwritten homework pages from IAM lines and MathWriting expressions."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import pickle, numpy as np, cv2

_LINES = None


def lines(split):
    """split 'train' = even indices, 'test' = odd indices (keeps orientation-model data apart from the suite)."""
    global _LINES
    if _LINES is None:
        _LINES = pickle.load(open(str(PATHS.HANDWRITING / "lines.pkl"), "rb"))
    k = 0 if split == "train" else 1
    return {n: v[k::2] for n, v in _LINES.items()}


def _place(page, ink, x, y):
    H, W = page.shape
    h, w = ink.shape
    if x >= W or y >= H: return
    h, w = min(h, H - y), min(w, W - x)
    page[y:y + h, x:x + w] = np.maximum(page[y:y + h, x:x + w], ink[:h, :w])


def _wobbly_box(page, x0, y0, x1, y1, rng, th):
    pts = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], np.float32)
    pts += rng.normal(0, 3, pts.shape)
    cv2.polylines(page, [pts.astype(np.int32)], False, 1.0, th, cv2.LINE_AA)


def compose(rng, L, W=1600, H=2070):
    """One homework page: numbered problems, math lines, some text lines, boxed answers. Float ink map 0..1."""
    page = np.zeros((H, W), np.float32)
    th = int(rng.choice([1, 2, 2, 3]))  # pen thickness in px at this scale
    scale = rng.uniform(0.7, 1.3)
    y = int(rng.uniform(0.03, 0.07) * H)
    fill = rng.uniform(0.3, 1.0)
    left = int(rng.uniform(0.03, 0.1) * W)
    def get(kind):
        a = L[kind][rng.integers(len(L[kind]))].astype(np.float32) / 255
        s = scale * (rng.uniform(0.55, 0.8) if kind == "iam" else rng.uniform(0.8, 1.2))
        a = cv2.resize(a, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        if th > 1:
            a = cv2.dilate(a, np.ones((th, th), np.uint8))
        return np.clip(a * rng.uniform(0.75, 1.0), 0, 1)
    while y < fill * H:
        # problem header: an expression or a short text crop, often boxed or underlined
        hd = get("math" if rng.random() < 0.6 else "iam")
        hd = hd[:, : int(min(hd.shape[1], rng.uniform(0.08, 0.3) * W))]
        _place(page, hd, left, y)
        if rng.random() < 0.5:
            _wobbly_box(page, left - 8, y - 8, left + hd.shape[1] + 8, y + hd.shape[0] + 8, rng, th)
        y += hd.shape[0] + int(rng.uniform(10, 40))
        for _ in range(rng.integers(2, 7)):
            if y >= fill * H: break
            a = get("math" if rng.random() < 0.75 else "iam")
            a = a[:, : int(W - left - 20)]
            x = left + int(rng.uniform(0, 0.25) * W)
            if x + a.shape[1] > W - 10: x = max(left, W - 10 - a.shape[1])
            _place(page, a, x, y)
            if rng.random() < 0.15:  # boxed answer
                _wobbly_box(page, x - 10, y - 10, x + a.shape[1] + 10, y + a.shape[0] + 10, rng, th)
            # right-hand second column sometimes
            if rng.random() < 0.2:
                b = get("math")
                bx = int(rng.uniform(0.55, 0.65) * W)
                if bx > x + a.shape[1] + 20:
                    _place(page, b[:, : W - bx - 10], bx, y)
            y += a.shape[0] + int(rng.uniform(8, 35))
        if rng.random() < 0.3:  # separator line between problems
            cv2.line(page, (left, y), (int(rng.uniform(0.3, 0.9) * W), y + int(rng.normal(0, 4))), 1.0, th)
        y += int(rng.uniform(30, 90))
    return page


def worksheet(rng, printed_gray, L):
    """Printed sheet (form/letter) with handwritten answers added. Returns ink map 0..1 at 1600 px width."""
    g = cv2.resize(printed_gray, (1600, 2262), interpolation=cv2.INTER_AREA).astype(np.float32)
    ink = np.clip((245 - g) / 200, 0, 1)
    for _ in range(rng.integers(3, 10)):
        a = L["math"][rng.integers(len(L["math"]))].astype(np.float32) / 255
        a = cv2.resize(a, None, fx=rng.uniform(0.6, 1.0), fy=rng.uniform(0.6, 1.0))
        x, y = int(rng.uniform(0.05, 0.6) * 1600), int(rng.uniform(0.05, 0.92) * 2262)
        _place(ink, a[:, : 1600 - x], x, y)
    return ink
