#!/usr/bin/env python3
"""hwscan 2: phone photos of homework -> one clean, scanner-style PDF.

Built for bad photos from old phones: low resolution, blur, noise, low light, shadows, glare,
white paper on a light desk, pages cut off by the frame, and thumbs or pens on the page.

Pipeline per page
  1. load            EXIF rotation; EXIF focal length if present; PDF pages rendered at 300 dpi
  2. find the page   colour edges -> line hypotheses -> every 4-line quad, plus quads from paper-like
                     regions; ranked by edge support, overshoot, inside/outside colour separation,
                     two-sidedness of each edge, paper-likeness and paper aspect ratio
                     (linear ranker fitted on SmartDoc 2015 + a synthetic stress suite)
  3. refine corners  each side re-fitted to the strongest gradient at full resolution
  4. rectify         true aspect ratio from single-view rectangle geometry (Zhang & He), snapped
                     to letter or A4 when close; out-of-frame parts filled white
  5. clean           denoise when noisy, remove uneven light, per-page tone curve, remove specks
  6. orient          axis from the page shape (or stroke direction), up/down from the layout and a
                     small text-patch model; then residual skew when no page edge was found
  7. check           warnings for blur, low resolution, glare, cut-off page, low contrast
  8. write           letter or A4 page at the chosen dpi, gray JPEG or 1-bit G4

Usage
  python3 hwscan2.py IN [IN ...] -o OUT.pdf [--paper letter|a4] [--mode gray|bw] [--dpi 300]
                     [--bleed low|normal|high] [--rotate 3:180] [--no-autorotate] [--debug DIR] [--json]
IN can be image files, folders of images, or PDFs.
"""
import argparse, io, itertools, json, os, re, sys, warnings
import numpy as np
import cv2
from PIL import Image, ImageOps

warnings.filterwarnings("ignore", category=RuntimeWarning)
PAPER = {"letter": (8.5, 11.0), "a4": (8.27, 11.69)}
IMG_EXT = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp", ".heic", ".heif"}


# ======================= 1. input =======================
def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def _focal_px(pil, W, H):
    """Focal length in pixels from EXIF FocalLengthIn35mmFilm (tag 41989), or None."""
    try:
        f35 = pil.getexif().get_ifd(0x8769).get(41989)
        if f35:
            return float(f35) / 36.0 * max(W, H)
    except Exception:
        pass
    return None


def load_pages(paths, dpi=300):
    """Yield (label, BGR image, focal length in px or None) for each page in argument order."""
    for p in paths:
        if os.path.isdir(p):
            files = sorted((f for f in os.listdir(p) if os.path.splitext(f)[1].lower() in IMG_EXT), key=natural_key)
            yield from load_pages([os.path.join(p, f) for f in files], dpi)
        elif p.lower().endswith(".pdf"):
            import pypdfium2 as pdfium
            doc = pdfium.PdfDocument(p)
            for i in range(len(doc)):
                pil = doc[i].render(scale=dpi / 72).to_pil().convert("RGB")
                yield f"{os.path.basename(p)}#{i+1}", cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR), None
        else:
            if os.path.splitext(p)[1].lower() in (".heic", ".heif"):
                try:
                    import pillow_heif
                    pillow_heif.register_heif_opener()
                except ImportError:
                    sys.exit("HEIC input needs: pip install pillow-heif")
            pil = Image.open(p)
            f = _focal_px(pil, *pil.size)
            pil = ImageOps.exif_transpose(pil).convert("RGB")
            yield os.path.basename(p), cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR), f


# ======================= 2. page detection =======================
PAPER_RATIOS = (11 / 8.5, 297 / 210)  # letter, A4 (long/short)
WORK = 480
NLINES = 22
NLINES_HOUGH = 22
TOPK = 60  # long side of the working image; step edges are scale invariant


def _edges(small):
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab = cv2.GaussianBlur(lab, (0, 0), 1.0)
    jxx = jyy = jxy = 0
    for c in range(3):
        ch = lab[..., c]
        gx = cv2.Sobel(ch, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(ch, cv2.CV_32F, 0, 1, ksize=3)
        # Normalise by the channel's own gradient noise so a clean small step in b* counts like a big step in L*.
        noise = np.median(np.hypot(gx, gy)) + 1e-3
        gx, gy = gx / noise, gy / noise
        jxx, jyy, jxy = jxx + gx * gx, jyy + gy * gy, jxy + gx * gy
    # largest eigenvalue and its direction of the summed tensor (Di Zenzo colour gradient)
    tr, det = jxx + jyy, jxx * jyy - jxy * jxy
    lam = tr / 2 + np.sqrt(np.maximum(tr * tr / 4 - det, 0))
    mag = np.sqrt(lam)
    theta = 0.5 * np.arctan2(2 * jxy, jxx - jyy)  # gradient direction
    return mag, theta


def _nms(mag, theta):
    """Thin edges to one pixel along the gradient direction."""
    H, W = mag.shape
    dx, dy = np.cos(theta), np.sin(theta)
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    m1 = cv2.remap(mag, xs + dx, ys + dy, cv2.INTER_LINEAR)
    m2 = cv2.remap(mag, xs - dx, ys - dy, cv2.INTER_LINEAR)
    return np.where((mag >= m1) & (mag >= m2), mag, 0)


def _lines(binary, n, H, W):
    out = []
    thr = int(0.12 * min(H, W))
    L = cv2.HoughLines(binary, 1, np.pi / 360, thr)
    if L is None:
        return out
    for r, t in L[:, 0]:
        if all(abs(r - r2) > 6 or abs(t - t2) > np.radians(3) for r2, t2 in out):
            out.append((float(r), float(t)))
        if len(out) >= n:
            break
    return out



def _merge_lines(lines, n):
    out = []
    for r, t in lines:
        dup = False
        for r2, t2 in out:
            dt, dr = abs(t - t2), abs(r - r2)
            if dt > np.pi / 2:
                dt, dr = np.pi - dt, abs(r + r2)
            if dt < np.radians(2.5) and dr < 4:
                dup = True; break
        if not dup:
            out.append((r, t))
        if len(out) >= n:
            break
    return out



def _region_quads(lab, H, W):
    """Quads from bright, low-colour regions (paper) on several maps, with slow light falloff removed."""
    L = lab[..., 0].astype(np.float32)
    chroma = np.hypot(lab[..., 1].astype(np.float32) - 128, lab[..., 2].astype(np.float32) - 128)
    Ln = L / (cv2.GaussianBlur(L, (0, 0), max(H, W) / 6) + 1)
    out = []
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    for m in (L, Ln, L - 2 * chroma, -chroma):
        m8 = cv2.normalize(cv2.GaussianBlur(m, (0, 0), 2), None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        _, b = cv2.threshold(m8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        b = cv2.morphologyEx(b, cv2.MORPH_OPEN, k, iterations=2)
        b = cv2.morphologyEx(b, cv2.MORPH_CLOSE, k, iterations=3)
        n, lab_, st, _ = cv2.connectedComponentsWithStats(b, 8)
        comps = [j for j in np.argsort(-st[1:, 4]) + 1 if st[j, 4] > 0.05 * H * W][:2]
        for j in comps:
            cs, _ = cv2.findContours((lab_ == j).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not cs:
                continue
            c = max(cs, key=cv2.contourArea)
            hull = cv2.convexHull(c)
            peri = cv2.arcLength(hull, True)
            quad = None
            for eps in (0.02, 0.03, 0.045, 0.06, 0.08):
                a = cv2.approxPolyDP(hull, eps * peri, True)
                if len(a) == 4:
                    quad = a.reshape(4, 2).astype(np.float32); break
            if quad is None:
                quad = cv2.boxPoints(cv2.minAreaRect(c)).astype(np.float32)
            out.append(_order(quad))
    return out


def _quad_support(q, edge, H, W):
    """Same contour features as the line candidates, by sampling along the four sides."""
    sup = np.full(4, np.nan)
    for k in range(4):
        a, b = q[k], q[(k + 1) % 4]
        P = _side_samples(a, b)
        x, y = P[:, 0], P[:, 1]
        on_frame = (np.minimum(np.minimum(x, y), np.minimum(W - 1 - x, H - 1 - y)) < 3).mean() > 0.8
        v = _support(P, edge, H, W)
        if not on_frame and np.isfinite(v).mean() >= 0.2:
            sup[k] = np.nanmean(v)
    fs = int(np.isnan(sup).sum())
    vals = sup[np.isfinite(sup)]
    smin = float(vals.min()) if vals.size else 0.0
    ct = (0.5 * smin + 0.5 * float(vals.mean()) - 0.12 * fs) if vals.size and fs <= 2 else -9.0
    x, y = q[:, 0], q[:, 1]
    area = 0.5 * abs(float((x * np.roll(y, -1) - np.roll(x, -1) * y).sum())) / (H * W)
    return (q, ct, smin, sup, fs, area)


def _intersect(l1, l2):
    (r1, t1), (r2, t2) = l1, l2
    A = np.array([[np.cos(t1), np.sin(t1)], [np.cos(t2), np.sin(t2)]])
    d = np.linalg.det(A)
    if abs(d) < 1e-6:
        return None
    return np.linalg.solve(A, [r1, r2])


def aspect_ratio(q, W, H, f=None):
    """Long/short ratio of the real rectangle behind image quad q (tl,tr,br,bl), after Zhang & He (2007).
    Principal point at the image centre and square pixels. Returns (ratio, f)."""
    u0, v0 = W / 2, H / 2
    m1, m2, m4, m3 = [np.array([p[0], p[1], 1.0]) for p in q]  # Zhang's order: m1 tl, m2 tr, m3 bl, m4 br
    k2 = np.dot(np.cross(m1, m4), m3) / np.dot(np.cross(m2, m4), m3)
    k3 = np.dot(np.cross(m1, m4), m2) / np.dot(np.cross(m3, m4), m2)
    n2, n3 = k2 * m2 - m1, k3 * m3 - m1
    if f is None:
        if abs(n2[2]) > 1e-9 and abs(n3[2]) > 1e-9:
            f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0)
                   + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / (n2[2] * n3[2])
            f = np.sqrt(f2) if f2 > 0 else None
        if f is None or not (0.3 * max(W, H) < f < 5 * max(W, H)):
            f = 0.8 * max(W, H)  # typical phone camera: about 26 mm equivalent
    Ai = np.linalg.inv(np.array([[f, 0, u0], [0, f, v0], [0, 0, 1.0]]))
    w2 = n2 @ Ai.T @ Ai @ n2
    h2 = n3 @ Ai.T @ Ai @ n3
    if w2 <= 0 or h2 <= 0:
        return None, f
    r = np.sqrt(w2 / h2)  # width / height
    return (max(r, 1 / r), r >= 1), f


def _side_samples(a, b, step=2.0):
    n = max(2, int(np.linalg.norm(b - a) / step))
    t = np.linspace(0, 1, n)[:, None]
    return a + (b - a) * t


def _support(pts, edge, H, W):
    """Fraction of sample points with an edge nearby; points outside the frame return nan."""
    x, y = np.round(pts[:, 0]).astype(int), np.round(pts[:, 1]).astype(int)
    inside = (x >= 2) & (y >= 2) & (x < W - 2) & (y < H - 2)
    v = np.full(len(pts), np.nan)
    v[inside] = edge[y[inside], x[inside]]
    return v


def _fisher(labf, q, H, W):
    """Colour separation between a band just inside and a band just outside the quad:
    per-channel squared mean difference over summed variances (Fisher criterion), mapped to 0..1.
    Smooth in the pixel values, so it does not depend on the JPEG decoder or histogram bin edges."""
    c = q.mean(0)
    m_in = np.zeros((H, W), np.uint8); m_q = m_in.copy(); m_out = m_in.copy()
    cv2.fillPoly(m_in, [np.int32((q - c) * 0.88 + c)], 1)
    cv2.fillPoly(m_q, [np.int32(q)], 1)
    cv2.fillPoly(m_out, [np.int32((q - c) * 1.12 + c)], 1)
    bi = (m_q == 1) & (m_in == 0)
    bo = (m_out == 1) & (m_q == 0)
    if bi.sum() < 50 or bo.sum() < 50:
        return 0.0
    a, b = labf[bi], labf[bo]
    d = np.sqrt(np.sum((a.mean(0) - b.mean(0)) ** 2 / (a.var(0) + b.var(0) + 4.0)))
    return float(d / (1 + d))


def _order(q):
    q = np.asarray(q, np.float32).reshape(4, 2)
    s, d = q.sum(1), np.diff(q, axis=1).ravel()
    return np.array([q[s.argmin()], q[d.argmin()], q[s.argmax()], q[d.argmax()]], np.float32)



def _line_profiles(lines, edge, H, W):
    """For each line: start point, direction, and cumulative edge hits / visible counts along it (1 px steps)."""
    D = int(np.hypot(H, W)) + 2
    t = np.arange(-D, D + 1, dtype=np.float32)
    P = []
    for r, th in lines:
        p0 = np.array([r * np.cos(th), r * np.sin(th)], np.float32)
        d = np.array([-np.sin(th), np.cos(th)], np.float32)
        x = np.round(p0[0] + d[0] * t).astype(int); y = np.round(p0[1] + d[1] * t).astype(int)
        vis = (x >= 2) & (y >= 2) & (x < W - 2) & (y < H - 2)
        hit = np.zeros(len(t), np.float32)
        hit[vis] = edge[y[vis], x[vis]]
        P.append((p0, d, np.concatenate([[0], np.cumsum(hit)]), np.concatenate([[0], np.cumsum(vis)])))
    return P, D


def _seg(cum, a, b, D):
    """Sum over [a, b) of a cumulative profile, a and b are arrays of line parameters."""
    lo = np.clip(np.minimum(a, b) + D, 0, 2 * D + 1).astype(int)
    hi = np.clip(np.maximum(a, b) + D, 0, 2 * D + 1).astype(int)
    return cum[hi] - cum[lo]


def candidates(img):
    H0, W0 = img.shape[:2]
    s = WORK / max(H0, W0)
    small = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    H, W = small.shape[:2]
    mag, theta = _edges(small)
    thin = _nms(mag, theta)
    local = cv2.blur(mag, (W // 8 | 1, W // 8 | 1)) + np.median(mag) + 1e-3
    rel = thin / local                                   # contrast relative to the neighbourhood
    nz = rel[rel > 0]
    thr = np.percentile(nz, 80) if nz.size else 1
    strong = (rel > thr).astype(np.uint8)
    edge_soft = cv2.dilate((rel > 0.6 * thr).astype(np.uint8), np.ones((3, 3), np.uint8)).astype(np.float32)
    gdir = np.abs(np.cos(theta))
    vert = (strong & (gdir > 0.7)).astype(np.uint8) * 255
    horz = (strong & (gdir < 0.7)).astype(np.uint8) * 255
    hl, vl = _lines(horz, NLINES_HOUGH, H, W), _lines(vert, NLINES_HOUGH, H, W)
    hl, vl = _merge_lines(hl, NLINES), _merge_lines(vl, NLINES)
    nh_real, nv_real = len(hl), len(vl)
    hl += [(0.0, np.pi / 2), (float(H - 1), np.pi / 2)]
    vl += [(0.0, 0.0), (float(W - 1), 0.0)]
    PH, D = _line_profiles(hl, edge_soft, H, W)
    PV, _ = _line_profiles(vl, edge_soft, H, W)
    nh, nv = len(hl), len(vl)
    # intersection points and the line parameter of each point on both lines
    X = np.full((nh, nv, 2), np.nan, np.float32)
    for i, a in enumerate(hl):
        for j, b in enumerate(vl):
            p = _intersect(a, b)
            if p is not None:
                X[i, j] = p
    th = np.stack([np.einsum('jk,k->j', X[i] - PH[i][0], PH[i][1]) for i in range(nh)])          # (nh, nv)
    tv = np.stack([np.einsum('ik,k->i', X[:, j] - PV[j][0], PV[j][1]) for j in range(nv)], 1)    # (nh, nv)
    hi_ = np.array(list(itertools.combinations(range(nh), 2)))
    vj_ = np.array(list(itertools.combinations(range(nv), 2)))
    I1, I2 = np.repeat(hi_[:, 0], len(vj_)), np.repeat(hi_[:, 1], len(vj_))
    J1, J2 = np.tile(vj_[:, 0], len(hi_)), np.tile(vj_[:, 1], len(hi_))
    corners = np.stack([X[I1, J1], X[I1, J2], X[I2, J2], X[I2, J1]], 1)  # (N,4,2) not yet ordered
    ok = np.isfinite(corners).all((1, 2))
    # make each quad's line pair ordered top/bottom and left/right
    swap_h = corners[:, :, 1].mean(1) * 0 + (X[I1, J1, 1] + X[I1, J2, 1]) > (X[I2, J1, 1] + X[I2, J2, 1])
    I1, I2 = np.where(swap_h, I2, I1), np.where(swap_h, I1, I2)
    swap_v = (X[I1, J1, 0] + X[I2, J1, 0]) > (X[I1, J2, 0] + X[I2, J2, 0])
    J1, J2 = np.where(swap_v, J2, J1), np.where(swap_v, J1, J2)
    Q = np.stack([X[I1, J1], X[I1, J2], X[I2, J2], X[I2, J1]], 1)  # tl, tr, br, bl
    # geometry filters
    x, y = Q[..., 0], Q[..., 1]
    area = 0.5 * np.abs((x * np.roll(y, -1, 1) - np.roll(x, -1, 1) * y).sum(1)) / (H * W)
    cross = []
    for k in range(4):
        a, b, c = Q[:, k], Q[:, (k + 1) % 4], Q[:, (k + 2) % 4]
        cross.append((b[:, 0] - a[:, 0]) * (c[:, 1] - b[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - b[:, 0]))
    cross = np.stack(cross, 1)
    convex = (cross > 0).all(1) | (cross < 0).all(1)
    inb = (x > -0.25 * W).all(1) & (x < 1.25 * W).all(1) & (y > -0.25 * H).all(1) & (y < 1.25 * H).all(1)
    frame_h = (I1 >= nh_real).astype(int) + (I2 >= nh_real)
    frame_v = (J1 >= nv_real).astype(int) + (J2 >= nv_real)
    fs = frame_h + frame_v
    ok &= convex & inb & (area > 0.05) & (area < 1.3) & (fs <= 2)
    idx = np.nonzero(ok)[0]
    if idx.size == 0:
        idx = np.zeros(0, int)
    # side support from cumulative profiles: top on h I1 between J1,J2; bottom on h I2; left on v J1 between I1,I2; right on v J2
    def side(P, line_idx, ta, tb):
        hits = np.zeros(len(line_idx)); vis = np.zeros(len(line_idx))
        for li in np.unique(line_idx):
            m = line_idx == li
            hits[m] = _seg(P[li][2], ta[m], tb[m], D)
            vis[m] = _seg(P[li][3], ta[m], tb[m], D)
        return hits, vis
    I1, I2, J1, J2 = I1[idx], I2[idx], J1[idx], J2[idx]
    sup, frame_side = [], []
    for P, li, ta, tb, isframe in (
            (PH, I1, th[I1, J1], th[I1, J2], I1 >= nh_real), (PH, I2, th[I2, J1], th[I2, J2], I2 >= nh_real),
            (PV, J1, tv[I1, J1], tv[I2, J1], J1 >= nv_real), (PV, J2, tv[I1, J2], tv[I2, J2], J2 >= nv_real)):
        hits, vis = side(P, li, ta, tb)
        length = np.abs(tb - ta) + 1
        visible = vis / length
        f = isframe | (visible < 0.2)
        sup.append(np.where(f, np.nan, hits / np.maximum(vis, 1)))
        frame_side.append(f)
    sup = np.stack(sup, 1); fsd = np.stack(frame_side, 1).sum(1)
    keep = fsd <= 2
    supmin = np.nanmin(np.where(np.isnan(sup), np.inf, sup), 1)
    with np.errstate(all='ignore'):
        supmean = np.nanmean(sup, 1)
    contour = 0.5 * supmin + 0.5 * supmean - 0.12 * fsd
    contour = np.where(keep & np.isfinite(contour), contour, -9)
    order = np.argsort(-contour)[:TOPK] if idx.size else np.zeros(0, int)
    lab = cv2.cvtColor(small, cv2.COLOR_BGR2LAB)
    Lc = lab[..., 0]
    chroma = np.hypot(lab[..., 1].astype(np.float32) - 128, lab[..., 2].astype(np.float32) - 128)
    tL, _ = cv2.threshold(Lc, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    paper_px = ((Lc >= tL) & (chroma <= np.percentile(chroma, 60) + 4)).astype(np.uint8)
    labf = cv2.GaussianBlur(lab.astype(np.float32), (0, 0), 1.2)
    labf_raw = lab.astype(np.float32)
    pool = []
    for o in order:
        if contour[o] < -1:
            break
        pool.append((Q[idx[o]], float(contour[o]), float(supmin[o]) if np.isfinite(supmin[o]) else 0.0, sup[o], int(fsd[o]), float(area[idx[o]])))
    for q in _region_quads(lab, H, W):  # region candidates: robust where edges are weak, noisy or broken
        pool.append(_quad_support(q, edge_soft, H, W))
    out = []
    for q, ct, sm, sup_o, fs_o, ar in pool:
        over = []
        for k in range(4):
            a, b = q[k], q[(k + 1) % 4]
            d = (b - a) / (np.linalg.norm(b - a) + 1e-9)
            ext = 0.15 * np.linalg.norm(b - a)
            for p, sg in ((a, -1), (b, 1)):
                v = _support(_side_samples(p + sg * d * 4, p + sg * d * ext), edge_soft, H, W)
                if np.isfinite(v).mean() > 0.5:
                    over.append(np.nanmean(v))
        overshoot = float(np.mean(over)) if over else 0.0
        contrast = _fisher(labf_raw, q, H, W)
        r, f = aspect_ratio(q / s, W0, H0)
        geo = 0.0
        if r is not None and fs_o == 0:
            geo = max(0.0, 1 - min(abs(r[0] - pr) / pr for pr in PAPER_RATIOS) / 0.15)
        # two-sidedness: a page edge has paper on one side and something else on the other;
        # a ruled line, grid line, drawn box or cable has the same colour on both sides
        sc = []
        cq = q.mean(0)
        for k in range(4):
            a, b = q[k], q[(k + 1) % 4]
            if not np.isfinite(sup_o[k]):
                continue
            d = (b - a) / (np.linalg.norm(b - a) + 1e-9)
            nrm = np.array([-d[1], d[0]], np.float32)
            if np.dot((a + b) / 2 - cq, nrm) < 0:
                nrm = -nrm
            P = _side_samples(a + (b - a) * 0.1, a + (b - a) * 0.9, 3.0)
            pin, pout = P - nrm * 3.5, P + nrm * 3.5
            ok_ = ((pin >= 1) & (pin < [W - 1, H - 1]) & (pout >= 1) & (pout < [W - 1, H - 1])).all(1)
            if ok_.sum() < 5:
                continue
            li = labf[pin[ok_, 1].astype(int), pin[ok_, 0].astype(int)]
            lo_ = labf[pout[ok_, 1].astype(int), pout[ok_, 0].astype(int)]
            sc.append(float(np.log1p(np.median(np.linalg.norm(li - lo_, axis=1)))) / 4)
        side_min = min(sc) if sc else 0.0
        side_mean = float(np.mean(sc)) if sc else 0.0
        c = q.mean(0); m = np.zeros((H, W), np.uint8)
        cv2.fillPoly(m, [np.int32((q - c) * 0.9 + c)], 1)
        paper = float(paper_px[m > 0].mean()) if m.any() else 0.0
        feats = np.array([ct, sm, overshoot, contrast, geo, paper, fs_o, ar, float(ar > 0.93),
                          side_min, side_mean], np.float32)
        out.append((q / s, feats))
    return out


FEATURES = ["contour", "supmin", "overshoot", "contrast", "geo", "paper", "frame_sides", "area", "huge", "side_min", "side_mean"]
WEIGHTS = np.array([0.9519, -0.2815, -1.5712, 2.4994, 0.4418, 0.1595, -0.5782, 1.0066, -5.0674, 1.2009, -1.0813], np.float32)  # fitted: fit_rank2.py


def find_page(img, weights=None):
    w = WEIGHTS if weights is None else weights
    cands = candidates(img)
    if not cands:
        return None, "no candidate"
    k = int(np.argmax([float(f @ w) for _, f in cands]))
    q, f = cands[k]
    if f[0] < 0.35 or f[8] or (f[3] < 0.15 and f[0] < 0.8):
        return None, "full frame (no paper edge)"
    return q, f"edges {f[0]:.0%}, contrast {f[3]:.2f}"


# ======================= 3-4. corner refinement and rectification =======================
def refine_corners(gray, q, search=None):
    """Move each side to the strongest gradient within a few pixels, at full resolution."""
    H, W = gray.shape
    g = cv2.GaussianBlur(gray, (0, 0), 1.2).astype(np.float32)
    gx, gy = cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1)
    mag = cv2.magnitude(gx, gy)
    R = search or max(3, int(round(max(H, W) / WORK * 1.5)))
    lines = []
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        d = (b - a) / (np.linalg.norm(b - a) + 1e-9)
        nrm = np.array([-d[1], d[0]])
        pts = []
        for t in np.linspace(0.08, 0.92, 40):
            p = a + (b - a) * t
            offs = np.arange(-R, R + 1, dtype=np.float32)
            xy = p[None] + offs[:, None] * nrm[None]
            x, y = xy[:, 0], xy[:, 1]
            if x.min() < 1 or y.min() < 1 or x.max() > W - 2 or y.max() > H - 2:
                continue
            prof = cv2.remap(mag, x.reshape(1, -1).astype(np.float32), y.reshape(1, -1).astype(np.float32), cv2.INTER_LINEAR).ravel()
            k = int(np.argmax(prof))
            if prof[k] > 2 * np.median(prof) + 1:
                pts.append(xy[k])
        if len(pts) >= 8:
            vx, vy, x0, y0 = cv2.fitLine(np.float32(pts), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
            lines.append((np.array([x0, y0]), np.array([vx, vy])))
        else:
            lines.append((a, d))  # side outside the frame or too weak: keep it
    out = []
    for i in range(4):
        (p1, d1), (p2, d2) = lines[i - 1], lines[i]
        A = np.array([d1, -d2]).T
        if abs(np.linalg.det(A)) < 1e-6:
            out.append(q[i]); continue
        t = np.linalg.solve(A, p2 - p1)
        c = p1 + d1 * t[0]
        out.append(c if np.linalg.norm(c - q[i]) < 3 * R else q[i])
    return np.float32(out)


def rectify(img, q, paper, focal=None):
    """Warp quad q (tl, tr, br, bl) to a rectangle with the page's true aspect ratio."""
    H0, W0 = img.shape[:2]
    tl, tr, br, bl = q
    w_px = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    h_px = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    r, _ = aspect_ratio(q, W0, H0, focal)
    ratio_used = "edges"
    if r is not None:
        long_short, wide = r
        target = PAPER[paper][1] / PAPER[paper][0]
        other = [x for x in PAPER_RATIOS if abs(x - target) > 1e-3]
        for pr in [target] + other:
            if abs(long_short - pr) / pr < 0.07:
                long_short, ratio_used = pr, "paper"
                break
        else:
            ratio_used = "geometry"
        # keep the measured resolution of the longer visible dimension
        if wide:
            w = int(max(w_px, h_px * long_short)); h = int(w / long_short)
        else:
            h = int(max(h_px, w_px * long_short)); w = int(h / long_short)
    else:
        w, h = int(w_px), int(h_px)
    dst = np.float32([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]])
    M = cv2.getPerspectiveTransform(np.float32(q), dst)
    page = cv2.warpPerspective(img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    valid = cv2.warpPerspective(np.full((H0, W0), 255, np.uint8), M, (w, h), flags=cv2.INTER_NEAREST) > 0
    return page, valid, ratio_used


# ======================= 7. quality checks =======================
def quality(page_gray, glare, dpi_eff, frame_sides):
    """Warnings a student can act on: retake the photo when these fire."""
    warn = []
    if dpi_eff < 90:
        warn.append("The photo is too small to read well. Move the phone closer.")
    g = cv2.resize(page_gray, (800, int(800 * page_gray.shape[0] / page_gray.shape[1])), interpolation=cv2.INTER_AREA)
    lap = cv2.Laplacian(g, cv2.CV_32F)
    ink = g < np.percentile(g, 3)
    if ink.mean() > 0.001:
        sharp = np.percentile(np.abs(lap[cv2.dilate(ink.astype(np.uint8), np.ones((5, 5))) > 0]), 90)
        if sharp < 12:
            warn.append("The photo is blurry. Hold still and tap the screen to focus.")
    if glare > 0.03:
        warn.append("There is glare on the page. Tilt the phone or move the light.")
    if frame_sides:
        warn.append("Part of the page is cut off. Keep all four corners in view.")
    return warn


# ======================= 5-6. cleanup and orientation =======================
def flatten(gray):
    return cv2.divide(gray, flatten_bg(gray), scale=255)


def flatten_bg(gray):
    """Paper-shade estimate, uint8 and at least 1. flatten() divides by it. The shade varies slowly, so it is estimated on a ~500 px wide copy:
    max-pool (keeps the paper level, drops thin ink), close, median, blur, then scale back up. This is the same
    result as a full-resolution estimate for practical purposes, and fast enough for old phones."""
    H, W = gray.shape
    f = max(1, int(round(W / 500)))
    src = gray
    if f > 1:
        src = cv2.dilate(gray, cv2.getStructuringElement(cv2.MORPH_RECT, (f, f)))
        src = cv2.resize(src, (max(1, W // f), max(1, H // f)), interpolation=cv2.INTER_AREA)
    k = int(0.02 * W / f) | 1
    bg = cv2.morphologyEx(src, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    bg = cv2.medianBlur(bg, min(255, int(0.01 * W / f) | 1))
    bg = cv2.GaussianBlur(bg, (0, 0), max(0.5, 0.004 * W / f))
    if f > 1:
        bg = cv2.resize(bg, (W, H), interpolation=cv2.INTER_LINEAR)
    return np.maximum(bg, 1)


def tone(n, bleed):
    """Per-page white and black points from measured paper noise and ink level."""
    paper = n[n > 200]
    p_med = np.median(paper) if paper.size else 250
    sigma = 1.4826 * np.median(np.abs(paper - p_med)) if paper.size else 3
    margin = {"low": 10, "normal": 20, "high": 30}[bleed]
    hi = float(np.clip(p_med - max(margin, 4 * sigma), 180, 248))
    ink = n[n < hi - 25]
    ink_med = np.median(ink) if ink.size > 500 else 100
    lo = float(np.clip(ink_med + 10, 40, hi - 35))  # faint pencil needs a black point well above 150
    out = np.clip((n.astype(np.float32) - lo) / (hi - lo), 0, 1) ** 1.2
    return (out * 255).astype(np.uint8), {"white": round(hi), "black": round(lo)}


def despeckle(g, dpi):
    """Remove small ink blobs that have no other ink nearby."""
    ink = (g < 160).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(ink, 8)
    max_area = int(40 * (dpi / 300) ** 2)
    small = np.zeros(n, bool)
    small[1:] = st[1:, cv2.CC_STAT_AREA] <= max_area
    big = (~small[lab]) & (ink > 0)
    r = int(8 * dpi / 300)  # about 0.7 mm: a decimal point sits closer than this to its digits
    near = cv2.dilate(big.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))) > 0
    keep_small = np.zeros(n, bool)
    ids = np.unique(lab[near & small[lab]])
    keep_small[ids] = True
    kill = small[lab] & ~keep_small[lab]
    g = g.copy()
    g[kill] = 255
    return g, int(small[1:].sum() - keep_small[1:].sum())


def clear_border(g, frac=0.012):
    """Whiten a thin frame, then erase long thin lines in the outer 2.5% (paper-edge shadows)."""
    m = int(frac * max(g.shape))
    g = g.copy()
    g[:m] = 255; g[-m:] = 255; g[:, :m] = 255; g[:, -m:] = 255
    H, W = g.shape
    band = int(0.025 * max(H, W))
    n, lab, st, _ = cv2.connectedComponentsWithStats((g < 200).astype(np.uint8), 8)
    for j in range(1, n):
        x, y, w, h, _ = st[j]
        horiz = w > 0.1 * W and h < 0.012 * H and (y + h < band or y > H - band)
        vert = h > 0.1 * H and w < 0.012 * W and (x + w < band or x > W - band)
        if horiz or vert:
            g[lab == j] = 255
    return g


# ---------- 6. orientation and skew ----------
def horiz_score(ink):
    k = max(15, ink.shape[1] // 60)
    h = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1))).sum()
    v = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, k))).sum()
    return (h + 1) / (v + 1)


def upright_score(ink):
    """>0 means upright: work starts at the top and lines start at the left."""
    H, W = ink.shape
    ys, _ = np.nonzero(ink)
    if ys.size < 200:
        return 0.0
    top = 0.5 - ys.mean() / H
    lines = cv2.dilate(ink, cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, W // 25), 3)))
    n, _, st, _ = cv2.connectedComponentsWithStats(lines)
    st = st[1:][st[1:, 4] > 50]
    left = 0.0
    if len(st) >= 3:
        left = (1 - (st[:, 0] + st[:, 2]) / W).mean() - (st[:, 0] / W).mean()
    return top + 0.3 * left


ROT = {0: None, 90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}


def rot(img, a):
    return img if ROT[a] is None else cv2.rotate(img, ROT[a])


# ---- learned up/down model (HOG of text-line patches -> small MLP); trained only on open-licence fonts ----
PH, PW = 32, 96


def line_patches(ink, max_patches=400):
    """ink: uint8, 255 = ink. Returns array (n, 32, 96) of upright-as-given patches."""
    m = (ink > 110).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    hs = st[1:, 3][(st[1:, 4] > 6) & (st[1:, 3] > 3)]
    if len(hs) < 5:
        return np.zeros((0, PH, PW), np.uint8)
    h = float(np.median(hs))
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(3, int(2.0 * h)), max(1, int(0.25 * h))))
    blobs = cv2.dilate(m, k)
    nb, _, sb, _ = cv2.connectedComponentsWithStats(blobs, 8)
    out = []
    for x, y, w, hh, a in sb[1:]:
        if w < 2.5 * hh or hh < 0.8 * h or hh > 6 * h:
            continue
        crop = ink[y:y + hh, x:x + w]
        s = PH / hh
        crop = cv2.resize(crop, (max(PW, int(w * s)), PH), interpolation=cv2.INTER_AREA)
        for x0 in range(0, crop.shape[1] - PW + 1, PW // 2):
            p = crop[:, x0:x0 + PW]
            if (p > 110).mean() > 0.04:
                out.append(p)
    if len(out) > max_patches:
        idx = np.linspace(0, len(out) - 1, max_patches).astype(int)
        out = [out[i] for i in idx]
    return np.array(out, np.uint8) if out else np.zeros((0, PH, PW), np.uint8)


def features(patches):
    """Simple HOG, written so it is easy to reproduce exactly in other languages (JavaScript port):
    central-difference gradients, 9 unsigned orientation bins with hard assignment weighted by magnitude,
    8x8 cells, 2x2-cell blocks with stride 1 cell, L2 normalisation per block. 3 x 11 blocks x 36 = 1188 values."""
    if len(patches) == 0:
        return np.zeros((0, 1188), np.float32)
    if len(patches) > 1000:
        return np.concatenate([features(patches[i:i + 1000]) for i in range(0, len(patches), 1000)])
    P = patches.astype(np.float32)
    gx = np.zeros_like(P); gy = np.zeros_like(P)
    gx[:, :, 1:-1] = P[:, :, 2:] - P[:, :, :-2]
    gy[:, 1:-1, :] = P[:, 2:, :] - P[:, :-2, :]
    mag = np.sqrt(gx * gx + gy * gy)
    ang = np.mod(np.arctan2(gy, gx), np.pi) / np.pi * 9 - 0.5   # bin centres at 0.5, 1.5, ... 8.5
    b0 = np.floor(ang).astype(np.int32)
    w1 = (ang - b0).astype(np.float32)                         # linear vote split between two bins
    b1 = np.mod(b0 + 1, 9); b0 = np.mod(b0, 9)
    n = len(P)
    cy = np.arange(PH) // 8; cx = np.arange(PW) // 8
    base = ((cy[:, None] * 12 + cx[None, :]) * 9)[None]
    flat = np.zeros((n, 4 * 12 * 9), np.float32)
    for i in range(n):
        flat[i] = np.bincount((base[0] + b0[i]).ravel(), weights=(mag[i] * (1 - w1[i])).ravel(), minlength=432) \
                + np.bincount((base[0] + b1[i]).ravel(), weights=(mag[i] * w1[i]).ravel(), minlength=432)
    cells = flat.reshape(n, 4, 12, 9)
    blocks = np.concatenate([cells[:, :-1, :-1], cells[:, :-1, 1:], cells[:, 1:, :-1], cells[:, 1:, 1:]], axis=3)  # (n,3,11,36)
    blocks = blocks / (np.sqrt((blocks ** 2).sum(3, keepdims=True)) + 1e-3)
    blocks = np.minimum(blocks, 0.2)                           # L2-Hys: clip, then normalise again
    blocks = blocks / (np.sqrt((blocks ** 2).sum(3, keepdims=True)) + 1e-3)
    return blocks.reshape(n, -1).astype(np.float32)


class UpDown:
    """Linear model (w, b) or one-hidden-layer MLP (W1, b1, W2, b2) on standardised HOG features."""
    def __init__(self, path):
        d = np.load(path)
        self.mu, self.sd = d["mu"], d["sd"]
        self.mlp = "W1" in d
        if self.mlp:
            self.W1, self.b1, self.W2, self.b2 = d["W1"], d["b1"], d["W2"], float(d["b2"])
        else:
            self.w, self.b = d["w"], float(d["b"])

    def patch_logodds(self, F):
        Z = (F - self.mu) / self.sd
        if self.mlp:
            return np.maximum(Z @ self.W1 + self.b1, 0) @ self.W2 + self.b2
        return Z @ self.w + self.b

    def logodds(self, ink):
        """Sum of per-patch log-odds that the page is upright. ink: uint8 with 255 = ink."""
        F = features(line_patches(ink))
        if len(F) == 0:
            return 0.0, 0
        return float(np.clip(self.patch_logodds(F), -4, 4).sum()), len(F)


_UPDOWN = None


def _updown():
    global _UPDOWN
    if _UPDOWN is None:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hwscan_updown.npz")
        _UPDOWN = UpDown(p) if os.path.exists(p) else False
    return _UPDOWN


ORIENT_W = np.array([10.1532, 0.6510, 17.0498, 0.2722, 0.7958, 2.0949, 3.2146])  # fit_orient.py: logistic regression on synthetic scenes 0-799


def _margin_line(ink):
    """Long vertical rule near the left (+) or right (-) edge: notebook margin lines are on the left."""
    H, W = ink.shape
    v = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, H // 3)))
    col = v.sum(0).astype(np.float32) / H
    return float(col[: W // 4].max() - col[-W // 4:].max())


def orient_features(g, a):
    """Up/down evidence for the page turned by a (all features change sign when the page is turned 180)."""
    small = cv2.resize(g, None, fx=600 / g.shape[1], fy=600 / g.shape[1], interpolation=cv2.INTER_AREA)
    ink = rot((small < 128).astype(np.uint8), a)
    soft = rot((small < 215).astype(np.uint8), a)
    H, W = ink.shape
    ys, xs = np.nonzero(ink)
    if ys.size < 50:
        return np.zeros(7)
    u = upright_score(ink)
    lo, n = 0.0, 0
    m = _updown()
    if m:
        big = rot(255 - g, a)
        big = cv2.resize(big, (1600, int(1600 * big.shape[0] / big.shape[1])), interpolation=cv2.INTER_AREA)
        lo, n = m.logodds(big)
    rows = np.nonzero(ink.sum(1) > 2)[0]
    gap = (rows[0] / H - (H - 1 - rows[-1]) / H) if rows.size else 0.0
    return np.array([u, 0.5 - ys.mean() / H, 0.5 - xs.mean() / W, lo / 400, (lo / n if n else 0.0), _margin_line(soft), -gap])


def auto_orient(g, page_found=False):
    """Returns (rotation, confidence, h/v ratio).
    Axis: when the page edges were found, the page shape decides (homework is written along the long side of
    a portrait sheet); otherwise the stroke direction decides. Up/down: a fitted combination of the layout
    (work starts top left), header gap, notebook margin line and the text-patch model."""
    small = cv2.resize(g, None, fx=600 / g.shape[1], fy=600 / g.shape[1], interpolation=cv2.INTER_AREA)
    hs = horiz_score((small < 128).astype(np.uint8))
    portrait = g.shape[0] >= g.shape[1]
    if page_found:
        base = [0, 180] if portrait else [90, 270]
    elif hs >= 1.3:
        base = [0, 180]
    elif hs <= 0.77:
        base = [90, 270]
    else:
        base = [0, 180] if portrait else [90, 270]
    score = float(orient_features(g, base[0]) @ ORIENT_W)
    best = base[0] if score >= 0 else base[1]
    return best, round(abs(score), 3), round(float(hs), 2)


def _stroke_angles(g, vertical=False):
    """Angles of long thin strokes: fraction bars and underlines, or (vertical=True) plates and box sides."""
    if vertical:
        g = cv2.rotate(g, cv2.ROTATE_90_CLOCKWISE)
    m = (g < 160).astype(np.uint8)
    H, W = m.shape
    n, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for j in range(1, n):
        x, y, w, h, a = st[j]
        if w > max(W, H) / 25 and h < 0.2 * w and a < w * max(4, 0.004 * max(W, H)):
            ys, xs = np.nonzero(lab[y:y + h, x:x + w] == j)
            vx, vy = cv2.fitLine(np.column_stack([xs, ys]).astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()[:2]
            out.append((float(np.degrees(np.arctan2(vy, vx))), int(w)))
    return out


def _wmedian(v):
    a = np.array([x for x, _ in v]); w = np.array([y for _, y in v])
    o = np.argsort(a); c = np.cumsum(w[o])
    return float(a[o][np.searchsorted(c, c[-1] / 2)])


def skew_from_strokes(g):
    """Residual skew in degrees, or None. Hand-drawn lines wander about 2 degrees, so the rule is strict:
    horizontal and vertical strokes must agree, or there must be many horizontal strokes and a clear tilt."""
    hz, vt = _stroke_angles(g), _stroke_angles(g, True)
    if len(hz) < 4:
        return None
    ah = _wmedian(hz)
    if len(vt) >= 2:
        av = _wmedian(vt)
        if abs(ah - av) <= 1.5:
            a = (ah * len(hz) + av * len(vt)) / (len(hz) + len(vt))
            return a if abs(a) >= 1.5 else None
    return ah if len(hz) >= 6 and abs(ah) >= 3.5 else None


def rotate_small(g, deg):
    M = cv2.getRotationMatrix2D((g.shape[1] / 2, g.shape[0] / 2), deg, 1)
    return cv2.warpAffine(g, M, (g.shape[1], g.shape[0]), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255, 255) if g.ndim == 3 else 255)


# ======================= 8. layout and driver =======================
def fit_to_paper(g, paper, dpi, margin_in=0.25):
    Wp, Hp = int(PAPER[paper][0] * dpi), int(PAPER[paper][1] * dpi)
    m = int(margin_in * dpi)
    s = min((Wp - 2 * m) / g.shape[1], (Hp - 2 * m) / g.shape[0])
    g = cv2.resize(g, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    page = np.full((Hp, Wp) + g.shape[2:], 255, np.uint8)
    y, x = (Hp - g.shape[0]) // 2, (Wp - g.shape[1]) // 2
    page[y:y + g.shape[0], x:x + g.shape[1]] = g
    return page


def colour_page(page, bg, n, valid, levels):
    """Colour version of the clean page. Each channel gets the grey page's shade removal and tone curve. A colour cast
    in the paper is removed with one gain a channel (the paper's median in that channel). Returns BGR."""
    hi, lo = float(levels["white"]), float(levels["black"])
    lut = (np.clip((np.arange(256) - lo) / (hi - lo), 0, 1) ** 1.2 * 255).astype(np.uint8)
    paper = (n > 200) & valid
    pg = float(np.median(n[paper])) if paper.any() else 250.0
    chans = []
    for c in cv2.split(page):
        nc = cv2.divide(c, bg, scale=255)
        pc = float(np.median(nc[paper])) if paper.any() else pg
        chans.append(cv2.LUT(cv2.convertScaleAbs(nc, alpha=pg / max(pc, 1.0)), lut))
    col = cv2.merge(chans)
    col[~valid] = 255
    return col


def process(img, args, focal=None, forced_rot=None, debug_prefix=None):
    info = {}
    dpi = args.dpi
    quad = getattr(args, "quad", None)  # corners chosen by the student: tl, tr, br, bl in image pixels
    if quad is not None:
        q, how = np.float32(quad), "manual"
    else:
        q, how = find_page(img)
    frame_sides = 0
    if q is not None:
        if quad is None:
            gray0 = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            q = refine_corners(gray0, q)
        H0, W0 = img.shape[:2]
        frame_sides = int(sum(min(c[0], c[1], W0 - 1 - c[0], H0 - 1 - c[1]) < -2 for c in q) > 0)
        page, valid, ratio_used = rectify(img, q, args.paper, focal)
        info["page"] = f"{how}; aspect from {ratio_used}"
        if debug_prefix:
            d = img.copy()
            cv2.polylines(d, [q.astype(np.int32)], True, (0, 0, 255), max(2, img.shape[1] // 400))
            cv2.imwrite(debug_prefix + "_1_edges.jpg", cv2.resize(d, None, fx=0.5, fy=0.5))
    else:
        page, valid = img, np.ones(img.shape[:2], bool)
        info["page"] = how
        # a photo (not a scan): the frame edge is desk, not paper -> tell the student how to fix it
        g0 = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        b = max(2, int(0.03 * max(g0.shape)))
        ring = np.concatenate([g0[:b].ravel(), g0[-b:].ravel(), g0[:, :b].ravel(), g0[:, -b:].ravel()])
        if np.median(ring) < 200:
            info.setdefault("warn", []).append("The page edges are hard to see. Use a darker table and keep all four corners in view.")
    gray = cv2.cvtColor(page, cv2.COLOR_BGR2GRAY)
    # glare = clipped highlights on a page whose paper is otherwise below white (a phone photo, not a scan)
    gv = gray[valid] if valid.any() else gray.ravel()
    glare = float((gv >= 250).mean()) if np.percentile(gv, 60) < 238 else 0.0
    long_in = PAPER[args.paper][1]
    dpi_eff = max(gray.shape) / long_in
    # denoise at native resolution when the paper is noisy (low light on old sensors)
    n0 = flatten(gray)
    pp = n0[n0 > 200]
    sigma = 1.4826 * np.median(np.abs(pp - np.median(pp))) if pp.size else 0
    if sigma > 3.0:
        gray = cv2.bilateralFilter(gray, 5, float(min(60, 3 * sigma)), 3)  # available in every OpenCV build, incl. OpenCV.js
        info["denoise"] = round(float(sigma), 1)
    colour = getattr(args, "mode", "gray") == "color"
    s = (long_in * dpi) / max(gray.shape)
    if abs(s - 1) > 0.05:
        gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
        if colour:
            page = cv2.resize(page, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
        valid = cv2.resize(valid.astype(np.uint8), (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    bg = flatten_bg(gray)
    n = cv2.divide(gray, bg, scale=255)
    g, levels = tone(n, args.bleed)
    g[~valid] = 255
    info.update(levels)
    g_pre = g
    g = clear_border(g, 0.005 if q is not None else 0.003)
    g, info["specks"] = despeckle(g, dpi)
    col = None
    if colour:
        col = colour_page(page, bg, n, valid, levels)
        col[(g == 255) & (g_pre != 255)] = 255
    if forced_rot is not None:
        a = forced_rot; info["orient"] = f"{a} (forced)"
    elif args.no_autorotate:
        a = 0; info["orient"] = "off"
    else:
        a, conf, hs = auto_orient(g, q is not None)
        info["orient"] = f"{a} (conf {conf}, h/v {hs})"
        if conf < 1.0:
            info.setdefault("warn", []).append("We could not tell which way is up. Please check this page.")
    g = rot(g, a)
    col = rot(col, a) if colour else None
    sk = skew_from_strokes(g) if q is None else None
    if sk is not None and abs(sk) <= 15:
        g = rotate_small(g, sk); info["skew"] = round(sk, 2)
        if colour:
            col = rotate_small(col, sk)
    if colour:
        g = col  # colour mode: the returned page is BGR

    info.setdefault("warn", []).extend(quality(rot(n, a), glare, dpi_eff, frame_sides))
    if not info["warn"]:
        del info["warn"]
    if debug_prefix:
        cv2.imwrite(debug_prefix + "_2_clean.png", g)
    return fit_to_paper(g, args.paper, dpi), g, info


def parse_rot(s):
    out = {}
    for part in filter(None, (s or "").split(",")):
        k, v = part.split(":")
        if int(v) % 360 not in ROT:
            sys.exit(f"--rotate angle must be 0, 90, 180 or 270: {part}")
        out[int(k)] = int(v) % 360
    return out


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("-o", "--output", required=True)
    ap.add_argument("--paper", choices=PAPER, default="letter")
    ap.add_argument("--mode", choices=["gray", "bw", "color"], default="gray", help="bw gives 1-bit pages and small files; color keeps colour")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--bleed", choices=["low", "normal", "high"], default="normal",
                    help="raise if text from the back of the sheet still shows")
    ap.add_argument("--rotate", help="force page rotation, e.g. 2:180,4:90 (1-based page numbers)")
    ap.add_argument("--no-autorotate", action="store_true")
    ap.add_argument("--debug", help="folder for edge overlays and per-page images")
    ap.add_argument("--json", action="store_true", help="print one JSON line per page")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    forced = parse_rot(args.rotate)
    if args.debug:
        os.makedirs(args.debug, exist_ok=True)
    blobs = []
    for i, (label, img, focal) in enumerate(load_pages(args.inputs, args.dpi), 1):
        dbg = os.path.join(args.debug, f"p{i:02d}") if args.debug else None
        page, _, info = process(img, args, focal, forced.get(i), dbg)
        if args.json:
            print(json.dumps({"page": i, "file": label, **info}))
        else:
            w = info.pop("warn", [])
            print(f"page {i:2d}  {label:28s} " + "  ".join(f"{k}={v}" for k, v in info.items()))
            for x in w:
                print(f"         WARNING: {x}")
        buf = io.BytesIO()
        if args.mode == "bw":
            Image.fromarray(page).point(lambda v: 255 if v > 150 else 0).convert("1").save(buf, "TIFF", compression="group4", dpi=(args.dpi, args.dpi))
        elif args.mode == "color":
            Image.fromarray(page[:, :, ::-1]).save(buf, "JPEG", quality=85, dpi=(args.dpi, args.dpi))
        else:
            Image.fromarray(page).save(buf, "JPEG", quality=85, dpi=(args.dpi, args.dpi))
        blobs.append(buf.getvalue())
    if not blobs:
        sys.exit("no pages found in input")
    import img2pdf  # only the command line needs it; loaded late so tools that import this module stay light
    title = os.path.splitext(os.path.basename(args.output))[0]
    with open(args.output, "wb") as f:
        f.write(img2pdf.convert(blobs, layout_fun=img2pdf.get_fixed_dpi_layout_fun((args.dpi, args.dpi)), title=title))
    print(f"wrote {args.output}: {len(blobs)} pages, {os.path.getsize(args.output) / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
