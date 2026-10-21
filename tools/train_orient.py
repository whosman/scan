"""Train the up/down model. Train: even-index writers + printed fonts. Test: odd-index writers, the 6 real pages, SmartDoc printed pages."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import numpy as np, cv2, glob, sys, time, pyarrow.parquet as pq
from PIL import Image, ImageDraw, ImageFont
from sklearn.linear_model import LogisticRegression
import hwdata, orient_model as om
rng = np.random.default_rng(0)
FONTS = [f for f in glob.glob("/usr/share/fonts/truetype/dejavu/*.ttf") if "Mono" not in f or rng.random() < 0.5]
WORDS = " ".join(pq.read_table(str(PATHS.HANDWRITING / "iam_test.parquet"), columns=["text"]).column("text").to_pylist()).split()

def printed_page(rng):
    img = Image.new("L", (1600, 2070), 0); d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONTS[rng.integers(len(FONTS))], int(rng.uniform(22, 48)))
    y = int(rng.uniform(40, 120)); x0 = int(rng.uniform(40, 200))
    while y < rng.uniform(0.4, 1.0) * 2000:
        n = rng.integers(3, 14); s = " ".join(WORDS[i] for i in rng.integers(len(WORDS), size=n))
        d.text((x0 + int(rng.uniform(0, 60)), y), s, fill=255, font=f)
        y += int(f.size * rng.uniform(1.3, 2.2))
    return np.array(img)

def augment(ink, rng):
    ink = ink.astype(np.float32)
    s = rng.uniform(0.35, 1.0)  # resolution loss (old phones)
    small = cv2.resize(ink, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    ink = cv2.resize(small, (ink.shape[1], ink.shape[0]), interpolation=cv2.INTER_CUBIC)
    if rng.random() < 0.5: ink = cv2.GaussianBlur(ink, (0, 0), rng.uniform(0.5, 1.5))
    ink = np.clip(ink * rng.uniform(0.8, 1.6), 0, 255)
    M = cv2.getRotationMatrix2D((800, 1035), rng.normal(0, 1.2), 1)
    return cv2.warpAffine(ink, M, (1600, 2070)).astype(np.uint8)

def page_set(n_hw, n_pr, split, rng):
    L = hwdata.lines(split)
    pages = []
    for i in range(n_hw):
        pages.append(augment((np.clip(hwdata.compose(rng, L), 0, 1) * 255).astype(np.uint8), rng))
    for i in range(n_pr):
        pages.append(augment(printed_page(rng), rng))
    return pages

def XY(pages):
    X, Y = [], []
    for p in pages:
        for lab, img in ((1, p), (0, cv2.rotate(p, cv2.ROTATE_180))):
            F = om.features(om.line_patches(img, 120)); X.append(F); Y.append(np.full(len(F), lab))
    return np.concatenate(X), np.concatenate(Y)

def page_acc(model_path, pages):
    m = om.UpDown(model_path); ok = 0; tot = 0; margins = []
    for p in pages:
        a, _ = m.logodds(p); b, _ = m.logodds(cv2.rotate(p, cv2.ROTATE_180))
        ok += (a > 0) + (b < 0); tot += 2; margins += [a, -b]
    return ok / tot, np.percentile(margins, 5)

if __name__ == "__main__":
    t = time.time()
    tr = page_set(int(sys.argv[1]), int(sys.argv[2]), "train", rng)
    X, Y = XY(tr); print("train patches", X.shape, f"{time.time() - t:.0f}s")
    mu, sd = X.mean(0), X.std(0) + 1e-6
    clf = LogisticRegression(C=0.05, max_iter=400).fit((X - mu) / sd, Y)
    print("patch train acc", clf.score((X - mu) / sd, Y))
    np.savez(str(PATHS.DATA / "updown_iam_testonly.npz"), w=clf.coef_.ravel().astype(np.float32), b=np.float32(clf.intercept_[0]), mu=mu.astype(np.float32), sd=sd.astype(np.float32))
    te_rng = np.random.default_rng(99)
    te_hw = page_set(150, 0, "test", te_rng); te_pr = page_set(0, 40, "test", te_rng)
    print("page acc, unseen writers:", page_acc(str(PATHS.DATA / "updown_iam_testonly.npz"), te_hw))
    print("page acc, printed:", page_acc(str(PATHS.DATA / "updown_iam_testonly.npz"), te_pr))
    real = []
    for f in sorted(glob.glob(str(PATHS.RAW / "*.jpg"))):
        g = cv2.imread(f, 0); g = cv2.resize(g, (1600, 2070))
        import gen_suite
        n = gen_suite.flatten(g).astype(np.float32); ink = np.clip((236 - n) / 126 * 255, 0, 255).astype(np.uint8)
        real += [augment(ink, te_rng) for _ in range(5)]
    print("page acc, the 6 real pages x5 augmentations:", page_acc(str(PATHS.DATA / "updown_iam_testonly.npz"), real))
    sd_pages = [cv2.resize(255 - cv2.imread(f, 0), (1600, 2262)) for f in sorted(glob.glob(str(PATHS.SMARTDOC / "02-edited" / "*.png")))]
    print("page acc, SmartDoc printed pages:", page_acc(str(PATHS.DATA / "updown_iam_testonly.npz"), sd_pages))
