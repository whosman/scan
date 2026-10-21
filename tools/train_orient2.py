"""Up/down model trained only on openly licensed data: DejaVu fonts and OFL handwriting fonts (Google Fonts),
with elastic distortion so font text looks hand-made. IAM / MathWriting / the user's pages are used for testing only."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import numpy as np, cv2, glob, sys, time
from PIL import Image, ImageDraw, ImageFont
from sklearn.linear_model import LogisticRegression
import orient_model as om
FONTS_HW = sorted(glob.glob(str(PATHS.FONTS / "*.ttf")))
FONTS_PR = sorted(f for f in glob.glob("/usr/share/fonts/truetype/dejavu/*.ttf"))
SYL = "ka ri to ne ma su lo pe di an er in on at es or ti ce la mo vi ra de st th qu ex".split()
VAR = list("abcdxyzqtFEVRCQAmn") + ["dx", "dy", "dt", "sin", "cos", "tan", "log", "ln", "lim"]
OPS = ["=", "+", "-", "x", "/", "(", ")", "^2", "^3", "E-6", "E-12", "%", "<", ">", "~"]

def word(rng):
    return "".join(rng.choice(SYL, rng.integers(1, 4)))

def math_line(rng):
    t = []
    for _ in range(rng.integers(3, 12)):
        r = rng.random()
        t.append(rng.choice(VAR) if r < 0.35 else rng.choice(OPS) if r < 0.65 else f"{rng.uniform(0, 999):.{rng.integers(0, 4)}f}")
    return " ".join(t)

def text_line(rng):
    return " ".join(word(rng) for _ in range(rng.integers(3, 10)))

def elastic(a, rng, amp):
    H, W = a.shape
    f = lambda: cv2.resize(rng.standard_normal((H // 24 + 2, W // 24 + 2)).astype(np.float32), (W, H), interpolation=cv2.INTER_CUBIC) * amp
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    return cv2.remap(a, x + f(), y + f(), cv2.INTER_LINEAR)

def render_page(rng, hand):
    img = Image.new("L", (1600, 2070), 0); d = ImageDraw.Draw(img)
    fonts = FONTS_HW if hand else FONTS_PR
    f = ImageFont.truetype(fonts[rng.integers(len(fonts))], int(rng.uniform(26, 60)))
    y = int(rng.uniform(30, 140)); x0 = int(rng.uniform(30, 220)); fill = rng.uniform(0.3, 1.0)
    while y < fill * 1950:
        s = math_line(rng) if rng.random() < (0.7 if hand else 0.3) else text_line(rng)
        x = x0 + int(rng.uniform(0, 300) if rng.random() < 0.4 else 0)
        d.text((x, y), s, fill=255, font=f)
        if hand and rng.random() < 0.12:
            bb = d.textbbox((x, y), s, font=f); d.rectangle([bb[0] - 8, bb[1] - 8, bb[2] + 8, bb[3] + 8], outline=255, width=2)
        y += int(f.size * rng.uniform(1.2, 2.6))
    a = np.array(img)
    if hand:
        a = elastic(a.astype(np.float32), rng, rng.uniform(1.5, 4.0))
        k = int(rng.choice([1, 1, 2, 3]))
        if k > 1: a = cv2.dilate(a, np.ones((k, k), np.uint8))
    return np.clip(a, 0, 255).astype(np.uint8)

def augment(ink, rng):
    ink = ink.astype(np.float32); H, W = ink.shape
    s = rng.uniform(0.35, 1.0)
    ink = cv2.resize(cv2.resize(ink, None, fx=s, fy=s, interpolation=cv2.INTER_AREA), (W, H), interpolation=cv2.INTER_CUBIC)
    if rng.random() < 0.5: ink = cv2.GaussianBlur(ink, (0, 0), rng.uniform(0.5, 1.5))
    ink = np.clip(ink * rng.uniform(0.8, 1.6), 0, 255)
    M = cv2.getRotationMatrix2D((W / 2, H / 2), rng.normal(0, 1.2), 1)
    return cv2.warpAffine(ink, M, (W, H)).astype(np.uint8)

if __name__ == "__main__":
    rng = np.random.default_rng(0); t = time.time()
    n_hw, n_pr = int(sys.argv[1]), int(sys.argv[2])
    X, Y = [], []
    for i in range(n_hw + n_pr):
        p = augment(render_page(rng, i < n_hw), rng)
        for lab, img in ((1, p), (0, cv2.rotate(p, cv2.ROTATE_180))):
            P = om.line_patches(img, 100); X.append(P); Y.append(np.full(len(P), lab))
    X, Y = np.concatenate(X), np.concatenate(Y); print("patches", X.shape, f"{time.time() - t:.0f}s")
    np.savez_compressed("/tmp/orient_PY.npz", P=X, Y=Y.astype(np.int8))
    X = om.features(X)
    mu, sd = X.mean(0), X.std(0) + 1e-6
    clf = LogisticRegression(C=0.05, max_iter=500).fit((X - mu) / sd, Y)
    print("patch train acc", round(clf.score((X - mu) / sd, Y), 3))
    np.savez(str(PATHS.PYTHON / "hwscan_updown_new.npz"), w=clf.coef_.ravel().astype(np.float32), b=np.float32(clf.intercept_[0]), mu=mu.astype(np.float32), sd=sd.astype(np.float32))
