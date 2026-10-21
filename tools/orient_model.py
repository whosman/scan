"""Up/down orientation from text-line patches.

Inference (used by hwscan2): find text-line blobs, normalise each to 32 px height, cut 32x96 windows,
compute an OpenCV HOG descriptor per window, score with a linear model, sum the log-odds over the page.
The model is a weight vector (numpy only at inference). Training data: multi-writer handwriting
(IAM lines, MathWriting expressions; even indices only) and printed text in several fonts.
"""
import numpy as np, cv2

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
