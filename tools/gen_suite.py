"""Generate a large synthetic stress suite of phone photos of homework, with ground truth.

Each scene: a page (handwritten composite, lined/graph paper, pencil or pen, or a printed page)
photographed by a virtual camera (3D pose, focal length) on a background (incl. white-on-white),
with lighting (gradients, spots, hard shadows, glare, low light), occlusions (thumb, pen),
and old-phone degradations (low resolution, defocus, motion blur, sensor noise, over-sharpening,
smeary denoise, heavy JPEG).

Writes  suite/<id>.jpg  and  suite/labels.jsonl  (gt quad tl,tr,br,bl in frame pixels, page id, tags).
Reference pages: suite/pages/<page>.png (clean ink map, upright).

usage: python3 gen_suite.py N [start_id] [seed]
"""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import cv2, numpy as np, json, os, sys, glob
import hwdata

OUT = str(PATHS.SUITE)
RAW = sorted(glob.glob(str(PATHS.RAW / "*.jpg")))
PRINTED = sorted(glob.glob(str(PATHS.SMARTDOC / "02-edited" / "*.png")))
os.makedirs(OUT + "/pages", exist_ok=True)  # created on import


def flatten(g):
    k = int(0.02 * g.shape[1]) | 1
    bg = cv2.morphologyEx(g, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    bg = cv2.GaussianBlur(cv2.medianBlur(bg, 21), (0, 0), 0.004 * g.shape[1])
    return cv2.divide(g, np.maximum(bg, 1), scale=255)


# ---------- page pool ----------
def ink_maps():
    """Ink darkness maps (0 = paper, 1 = full ink) for the 6 handwritten pages, and their text bands."""
    maps, bands = [], []
    for f in RAW:
        g = cv2.imread(f, 0)
        g = g[12:-12, 12:-12]
        n = flatten(g).astype(np.float32)
        ink = np.clip((236 - n) / (236 - 110), 0, 1)
        ink[ink < 0.08] = 0
        maps.append(ink)
        rows = (ink > 0.3).sum(1) > 2
        # bands: runs of ink rows separated by >= 30 empty rows
        y, H = 0, len(rows)
        while y < H:
            if rows[y]:
                y0 = y; gap = 0
                while y < H and gap < 30:
                    gap = 0 if rows[y] else gap + 1
                    y += 1
                y1 = y - gap
                if y1 - y0 > 25:
                    bands.append(ink[max(0, y0 - 8):y1 + 8])
            y += 1
    return maps, bands


def compose_page(rng, maps, bands, W=1600, H=2070):
    """New handwritten page from random text bands of the real pages (portrait, upright)."""
    ink = np.zeros((H, W), np.float32)
    fill = rng.uniform(0.25, 1.0)
    y = int(rng.uniform(0.02, 0.06) * H)
    while y < fill * H:
        b = bands[rng.integers(len(bands))]
        bw = b.shape[1]
        b = cv2.resize(b, (W, int(b.shape[0] * W / bw)))
        h = min(b.shape[0], H - y)
        if h <= 0:
            break
        ink[y:y + h] = np.maximum(ink[y:y + h], b[:h])
        y += h + int(rng.uniform(0, 0.04) * H)
    return ink


def paper_style(rng, ink):
    """Turn an ink map into a colour page: paper type, rulings, pen colour. Returns BGR uint8 and tag."""
    H, W = ink.shape
    kind = rng.choice(["plain", "lined", "graph", "legal", "recycled"], p=[0.35, 0.3, 0.12, 0.1, 0.13])
    paper = {"plain": (250, 250, 248), "lined": (250, 250, 247), "graph": (248, 250, 250),
             "legal": (175, 245, 252), "recycled": (222, 228, 232)}[kind]
    page = np.empty((H, W, 3), np.float32); page[:] = paper
    page *= 1 + 0.01 * rng.standard_normal((H, W, 1), dtype=np.float32)  # paper grain
    if kind in ("lined", "legal"):
        sp = int(H / rng.uniform(28, 36))
        for yy in range(int(0.08 * H), H, sp):
            cv2.line(page, (0, yy), (W, yy), (235, 200, 170) if kind == "lined" else (210, 175, 140), 2)
        cv2.line(page, (int(0.12 * W), 0), (int(0.12 * W), H), (170, 170, 240), 2)  # red margin
    if kind == "graph":
        sp = int(W / rng.uniform(30, 45))
        for v in range(0, max(H, W), sp):
            cv2.line(page, (v, 0), (v, H), (225, 215, 190), 1); cv2.line(page, (0, v), (W, v), (225, 215, 190), 1)
    pen = rng.choice(["black", "blue", "pencil", "faint-pencil"], p=[0.35, 0.3, 0.25, 0.1])
    col = {"black": (35, 30, 30), "blue": (140, 60, 25), "pencil": (95, 95, 100), "faint-pencil": (150, 150, 155)}[pen]
    a = ink[..., None]
    page = page * (1 - a) + np.array(col, np.float32) * a
    return np.clip(page, 0, 255).astype(np.uint8), f"{kind}/{pen}"


# ---------- backgrounds ----------
def background(rng, H, W, paper_bgr):
    kind = rng.choice(["solid", "wood", "fabric", "two-tone", "clutter", "white-on-white", "sheet"],
                      p=[0.14, 0.18, 0.12, 0.1, 0.16, 0.2, 0.1])
    if kind == "white-on-white":
        delta = rng.uniform(4, 16)  # very subtle: paper vs desk differ by a few levels
        base = np.array(paper_bgr, np.float32) - delta * rng.uniform(0.5, 1.5, 3)
        img = np.empty((H, W, 3), np.float32); img[:] = base
    elif kind == "wood":
        base = np.array(rng.choice([(60, 90, 140), (120, 165, 205), (150, 190, 220), (40, 60, 90), (170, 200, 215)]), np.float32)
        y = np.arange(H, dtype=np.float32)[:, None]; x = np.arange(W, dtype=np.float32)[None]
        ang = rng.uniform(0, np.pi)
        u = x * np.cos(ang) + y * np.sin(ang)
        grain = np.sin(u / rng.uniform(4, 14) + 3 * np.sin(u / rng.uniform(60, 200)) + rng.normal(0, 1)) * rng.uniform(5, 18)
        img = (base[None, None] + grain[..., None]).astype(np.float32)
    elif kind == "fabric":
        base = rng.uniform(40, 230, 3).astype(np.float32)
        n = cv2.resize(rng.standard_normal((H // 4 + 1, W // 4 + 1), dtype=np.float32), (W, H))
        img = (base[None, None] + n[..., None] * np.float32(rng.uniform(5, 20))).astype(np.float32)
    elif kind == "sheet":  # bed sheet / couch with folds
        base = rng.uniform(150, 245, 3).astype(np.float32)
        y = np.arange(H, dtype=np.float32)[:, None]; x = np.arange(W, dtype=np.float32)[None]
        folds = np.sin(x / rng.uniform(40, 120) + np.sin(y / rng.uniform(50, 200)) * 2) * rng.uniform(10, 35)
        img = (base[None, None] + folds[..., None]).astype(np.float32)
    else:
        base = rng.uniform(30, 235, 3).astype(np.float32)
        img = np.empty((H, W, 3), np.float32); img[:] = base
        if kind == "two-tone":
            p1 = (int(rng.uniform(0, W)), 0); p2 = (int(rng.uniform(0, W)), H)
            poly = np.array([p1, p2, (W if rng.random() < 0.5 else 0, H), (W if rng.random() < 0.5 else 0, 0)], np.int32)
            cv2.fillPoly(img, [poly], rng.uniform(20, 200, 3).tolist())
    if kind == "clutter":
        for _ in range(rng.integers(3, 9)):
            c = rng.uniform(0, 255, 3).tolist()
            t = rng.integers(4)
            cx, cy = int(rng.uniform(0, W)), int(rng.uniform(0, H)); s = int(rng.uniform(0.05, 0.3) * min(H, W))
            if t == 0:
                cv2.ellipse(img, (cx, cy), (s, int(s * rng.uniform(0.5, 1))), rng.uniform(0, 180), 0, 360, c, -1)
            elif t == 1:
                box = cv2.boxPoints(((cx, cy), (s * 2, s * rng.uniform(0.6, 1.6)), rng.uniform(0, 180))).astype(np.int32)
                cv2.fillPoly(img, [box], c)
            elif t == 2:  # cable
                pts = np.cumsum(rng.normal(0, s / 3, (8, 2)), 0) + (cx, cy)
                cv2.polylines(img, [pts.astype(np.int32)], False, (20, 20, 20), max(2, s // 25))
            else:  # another sheet of paper
                box = cv2.boxPoints(((cx, cy), (s * 2.2, s * 2.9), rng.uniform(0, 180))).astype(np.int32)
                cv2.fillPoly(img, [box], (240, 242, 243))
    g = img.mean(2, keepdims=True)
    img = g + (img - g) * (0.35 if kind not in ("white-on-white",) else 1.0)  # real desks are mostly low-saturation
    return img, kind


# ---------- camera ----------
def camera_quad(rng, page_w, page_h, W, H):
    """Project a page rectangle through a random 3D pose and focal length; fit into the frame."""
    f = rng.uniform(0.65, 1.3) * max(W, H)
    ar = page_h / page_w
    P = np.array([[-0.5, -0.5 * ar, 0], [0.5, -0.5 * ar, 0], [0.5, 0.5 * ar, 0], [-0.5, 0.5 * ar, 0]])
    roll = rng.choice([0, 90, 180, 270], p=[0.6, 0.15, 0.1, 0.15]) + rng.normal(0, 8)
    if rng.random() < 0.15:
        roll = rng.uniform(0, 360)
    tilt = abs(rng.normal(0, 18)); tilt = min(tilt, 50)
    az = rng.uniform(0, 2 * np.pi)
    def R(axis, a):
        c, s = np.cos(a), np.sin(a)
        return {"x": np.array([[1, 0, 0], [0, c, -s], [0, s, c]]), "y": np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]),
                "z": np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])}[axis]
    Rm = R("z", np.radians(roll)) @ R("z", az) @ R("x", np.radians(tilt)) @ R("z", -az)
    Xc = P @ Rm.T + np.array([0, 0, 2.0])
    q = Xc[:, :2] / Xc[:, 2:] * f + np.array([W / 2, H / 2])
    # scale and place
    frac = rng.uniform(0.2, 0.85)
    area = cv2.contourArea(q.astype(np.float32))
    q = (q - q.mean(0)) * np.sqrt(frac * W * H / area)
    out_of_frame = rng.random() < 0.12
    span = q.max(0) - q.min(0)
    lo = -q.min(0); hi = np.array([W, H]) - q.max(0)
    lo2, hi2 = np.minimum(lo, hi), np.maximum(lo, hi)
    if out_of_frame:
        c = np.array([rng.uniform(lo2[0] - 0.12 * span[0], hi2[0] + 0.12 * span[0]), rng.uniform(lo2[1] - 0.12 * span[1], hi2[1] + 0.12 * span[1])])
    else:
        c = np.array([rng.uniform(lo2[0], hi2[0]), rng.uniform(lo2[1], hi2[1])])
    q = q + c
    while not out_of_frame and ((q < 1).any() or (q[:, 0] > W - 1).any() or (q[:, 1] > H - 1).any()):
        q = (q - q.mean(0)) * 0.92 + (q.mean(0) * 0.8 + np.array([W / 2, H / 2]) * 0.2)
    return q.astype(np.float32), float(roll % 360), float(tilt), out_of_frame


def lighting(rng, H0, W0, q0):
    H, W = H0 // 4, W0 // 4; q = q0 / 4
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    L = np.ones((H, W), np.float32); tags = []
    if rng.random() < 0.5:
        a = rng.uniform(0, 2 * np.pi); s = rng.uniform(0.2, 0.6)
        L *= 1 - s / 2 + s * ((x * np.cos(a) + y * np.sin(a)) / np.hypot(W, H) + 0.5); tags.append("gradient")
    if rng.random() < 0.3:
        cx, cy = rng.uniform(0, W), rng.uniform(0, H)
        L *= 0.6 + 0.6 * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * (rng.uniform(0.2, 0.5) * W) ** 2)); tags.append("spot")
    if rng.random() < 0.3:  # hard shadow from a phone/hand/body
        c = q.mean(0) + rng.normal(0, 0.2, 2) * (W, H)
        pts = (c + rng.normal(0, 0.35, (5, 2)) * (W, H)).astype(np.int32)
        m = np.zeros((H, W), np.float32); cv2.fillPoly(m, [cv2.convexHull(pts)], 1)
        m = cv2.GaussianBlur(m, (0, 0), rng.uniform(0.5, 6))
        L *= 1 - rng.uniform(0.3, 0.65) * m; tags.append("hard-shadow")
    exposure = rng.choice([1.0, rng.uniform(0.25, 0.6)], p=[0.75, 0.25])
    if exposure < 1: tags.append("low-light")
    return cv2.resize((L * exposure).astype(np.float32), (W0, H0)), exposure, tags


def degrade(rng, img, exposure):
    H, W = img.shape[:2]; tags = []
    if rng.random() < 0.15:  # glare
        cx, cy = rng.uniform(0.2, 0.8) * W, rng.uniform(0.2, 0.8) * H
        y, x = np.mgrid[0:H:4, 0:W:4].astype(np.float32)
        gl = 255 * rng.uniform(0.3, 0.9) * np.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * (rng.uniform(0.03, 0.12) * W) ** 2))
        img = img + cv2.resize(gl.astype(np.float32), (W, H))[..., None]
        tags.append("glare")
    img = img * rng.uniform(0.9, 1.1, 3).astype(np.float32)  # white balance error
    if rng.random() < 0.5:
        y, x = np.mgrid[0:H:4, 0:W:4].astype(np.float32)
        v = (1 - rng.uniform(0.1, 0.4) * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2) * 2).astype(np.float32)
        img *= cv2.resize(v, (W, H))[..., None]; tags.append("vignette")
    s = rng.choice([0, rng.uniform(0.6, 1.5), rng.uniform(1.5, 3.0)], p=[0.35, 0.45, 0.2])
    if s > 0:
        img = cv2.GaussianBlur(img, (0, 0), s * W / 1600); tags.append("defocus" if s > 1.5 else "soft")
    if rng.random() < 0.2:
        L = int(rng.uniform(4, 14) * W / 1600) | 1
        k = np.zeros((L, L), np.float32); k[L // 2] = 1
        k = cv2.warpAffine(k, cv2.getRotationMatrix2D((L / 2, L / 2), rng.uniform(0, 180), 1), (L, L)); k /= k.sum()
        img = cv2.filter2D(img, -1, k); tags.append("motion-blur")
    gain = 1 / exposure  # camera brightens dark scenes and amplifies noise
    img = img * gain
    sig = rng.uniform(1, 5) * gain
    img = img + rng.standard_normal(img.shape, dtype=np.float32) * np.float32(sig) * np.sqrt(np.clip(img, 1, 255) / 128)
    img = img + cv2.resize(np.float32(sig * 0.7) * rng.standard_normal((H // 3 + 1, W // 3 + 1, 3), dtype=np.float32), (W, H))  # blotchy chroma noise
    if sig > 6: tags.append("noisy")
    img = np.clip(img, 0, 255).astype(np.uint8)
    if rng.random() < 0.3:
        img = cv2.bilateralFilter(img, 7, 30, 5); tags.append("smeary-denoise")
    if rng.random() < 0.35:
        b = cv2.GaussianBlur(img, (0, 0), 2)
        img = cv2.addWeighted(img, 1 + rng.uniform(0.5, 1.5), b, -rng.uniform(0.5, 1.5), 0); tags.append("oversharpen")
    q = int(rng.choice([rng.uniform(15, 40), rng.uniform(40, 75), rng.uniform(75, 95)], p=[0.3, 0.4, 0.3]))
    if q < 40: tags.append("heavy-jpeg")
    return img, q, tags


def occlude(rng, img, q):
    tags = []
    H, W = img.shape[:2]
    if rng.random() < 0.15:  # thumb holding the page
        i = rng.integers(4); p = q[i] * 0.6 + q[(i + 1) % 4] * 0.4
        c = (int(p[0]), int(p[1])); r = int(0.08 * min(H, W))
        cv2.ellipse(img, c, (r, int(r * 1.6)), rng.uniform(0, 180), 0, 360, tuple(float(v) for v in rng.choice([(120, 150, 210), (80, 110, 160), (60, 80, 120)])), -1)
        tags.append("thumb")
    if rng.random() < 0.12:  # pen or pencil across the page
        a, b = q[rng.integers(4)], q.mean(0)
        cv2.line(img, tuple(int(v) for v in a + (b - a) * 0.3), tuple(int(v) for v in b + (b - a) * 0.6), (30, 40, 160) if rng.random() < 0.5 else (20, 20, 20), max(3, W // 150))
        tags.append("pen")
    return img, tags


RES = [(640, 480), (1280, 960), (1600, 1200), (1920, 1080), (2592, 1944)]


def main():
    N = int(sys.argv[1]); start = int(sys.argv[2]) if len(sys.argv) > 2 else 0
    rng = np.random.default_rng(int(sys.argv[3]) if len(sys.argv) > 3 else start + 1)
    maps, bands = ink_maps() if RAW else ([], [])
    MW = hwdata.lines('test')
    printed = [cv2.resize(cv2.imread(f), (1600, 2262), interpolation=cv2.INTER_AREA) for f in PRINTED[:30]]
    lab = open(OUT + "/labels.jsonl", "a")
    for k in range(start, start + N):
        if RAW:
            src = rng.choice(["multiwriter", "composite", "real", "printed", "worksheet"], p=[0.5, 0.15, 0.05, 0.18, 0.12])
        else:  # no private real pages available: use the public sources only
            src = rng.choice(["multiwriter", "printed", "worksheet"], p=[0.7, 0.18, 0.12])
        if src == "printed":
            pi = int(rng.integers(len(printed)))
            page = printed[pi]; pid = f"printed{pi:02d}"; ptag = "printed"
            if not os.path.exists(f"{OUT}/pages/{pid}.png"):
                cv2.imwrite(f"{OUT}/pages/{pid}.png", cv2.resize(cv2.cvtColor(page, cv2.COLOR_BGR2GRAY), (800, 1131)))
        else:
            if src == "real":
                ink = maps[int(rng.integers(len(maps)))]
            elif src == "composite":
                ink = compose_page(rng, maps, bands)
            elif src == "multiwriter":
                ink = hwdata.compose(rng, MW)
            else:
                ink = hwdata.worksheet(rng, cv2.cvtColor(printed[int(rng.integers(len(printed)))], cv2.COLOR_BGR2GRAY), MW)
            page, ptag = paper_style(rng, ink) if src != "worksheet" else (np.clip(255 - ink[..., None] * np.array([215, 220, 225], np.float32), 0, 255).astype(np.uint8), "worksheet")
            pid = f"p{k:05d}"
            # reference = the styled page itself (rulings count as content, like a real scanner keeps them)
            gref = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY).astype(np.float32)
            paper_lvl = np.percentile(gref, 90)
            ref = np.clip(gref / paper_lvl * 255, 0, 255).astype(np.uint8)
            cv2.imwrite(f"{OUT}/pages/{pid}.png", cv2.resize(ref, (800, int(800 * ref.shape[0] / ref.shape[1])), interpolation=cv2.INTER_AREA))
        res = RES[rng.choice(len(RES), p=[0.2, 0.3, 0.25, 0.15, 0.1])]
        W, H = res if rng.random() < 0.5 else res[::-1]
        ph, pw = page.shape[:2]
        q, roll, tilt, oof = camera_quad(rng, pw, ph, W, H)
        bg, bgk = background(rng, H, W, page[ph // 2, 5].tolist() if src != "printed" else (245, 245, 245))
        M = cv2.getPerspectiveTransform(np.float32([[0, 0], [pw, 0], [pw, ph], [0, ph]]), q)
        warped = cv2.warpPerspective(page, M, (W, H), flags=cv2.INTER_AREA)
        mask = cv2.warpPerspective(np.full((ph, pw), 255, np.uint8), M, (W, H), flags=cv2.INTER_AREA).astype(np.float32)[..., None] / 255
        # thin contact shadow under the sheet edge (paper is not flat on the desk)
        sh = cv2.GaussianBlur(mask, (0, 0), max(1, W / 800)); sh = sh[..., None] if sh.ndim == 2 else sh
        bgs = bg * (1 - 0.18 * rng.uniform(0, 1) * np.clip(sh - mask, 0, 1) * 3)
        img = warped.astype(np.float32) * mask + bgs * (1 - mask)
        img, otags = occlude(rng, img, q)
        L, exposure, ltags = lighting(rng, H, W, q)
        img = img * L[..., None]
        img, jq, dtags = degrade(rng, img, exposure)
        cv2.imwrite(f"{OUT}/{k:05d}.jpg", img, [cv2.IMWRITE_JPEG_QUALITY, jq])
        rec = dict(id=f"{k:05d}", page=pid, src=src, paper=ptag, bg=bgk, res=f"{W}x{H}", roll=round(roll, 1), tilt=round(tilt, 1),
                   out_of_frame=bool(oof), jpeg=jq, tags=ltags + dtags + otags, quad=np.round(q, 2).tolist())
        lab.write(json.dumps(rec) + "\n"); lab.flush()


if __name__ == "__main__":
    main()
