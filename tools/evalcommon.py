"""Scoring helpers shared by the evaluation scripts: ink maps, normalised correlation, quad overlap, suite paths."""
import paths as PATHS  # noqa: F401  (sets sys.path and data locations)
import cv2, numpy as np

S = str(PATHS.SUITE) + "/"


def inkmap(g, shape):
    g = cv2.resize(g, shape[::-1], interpolation=cv2.INTER_AREA).astype(np.float32)
    return cv2.GaussianBlur(255 - g, (0, 0), 1.5)


def ncc(a, b):
    a = a - a.mean(); b = b - b.mean(); return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))


def iou(q1, q2, shape):
    if q1 is None: return 0.0
    m1 = np.zeros(shape[:2], np.uint8); m2 = m1.copy()
    cv2.fillPoly(m1, [np.int32(np.round(q1))], 1); cv2.fillPoly(m2, [np.int32(np.round(q2))], 1)
    u = (m1 | m2).sum(); return float((m1 & m2).sum() / u) if u else 0.0
