// Homework scan core. Pure JS, no dependencies. Runs in Node (tests) and in a Worker (the app).
// Image convention for detection: { data: Uint8ClampedArray (RGBA), w, h }

// ---------- small utilities ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const SRGB2LIN = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { k, r };
}

export function gaussBlur(src, w, h, sigma) {
  if (sigma <= 0) return src.slice();
  const { k, r } = gaussKernel(sigma);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
        a += src[row + xx] * k[i + r];
      }
      tmp[row + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) {
        const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
        a += tmp[yy * w + x] * k[i + r];
      }
      out[y * w + x] = a;
    }
  }
  return out;
}

// separable max filter (square window radius r), van-Herk not needed at our sizes
export function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let xx = a; xx <= b; xx++) { const v = src[y * w + xx]; if (v > m) m = v; }
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let yy = a; yy <= b; yy++) { const v = tmp[yy * w + x]; if (v > m) m = v; }
      out[y * w + x] = m;
    }
  }
  return out;
}

// 1-bit morphology by running counts: O(1) per pixel however big the window.
// erode: a pixel stays 1 only if the whole (2r+1) square is 1. dilate: it becomes 1 if any pixel in the square is.
// Outside the image counts as 1 for erode and 0 for dilate, so paper touching the frame is not eaten away.
function morph(src, w, h, r, erode) {
  const win = 2 * r + 1, pad = erode ? 1 : 0, tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w; let c = 0;
    for (let i = -r; i <= r; i++) c += i < 0 || i >= w ? pad : src[o + i];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = erode ? (c === win ? 1 : 0) : (c > 0 ? 1 : 0);
      const a = x + r + 1, b = x - r;
      c += (a >= w ? pad : src[o + a]) - (b < 0 ? pad : src[o + b]);
    }
  }
  const col = new Int32Array(w);
  for (let i = -r; i <= r; i++) { if (i < 0 || i >= h) { for (let x = 0; x < w; x++) col[x] += pad; } else { const o = i * w; for (let x = 0; x < w; x++) col[x] += tmp[o + x]; } }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = erode ? (col[x] === win ? 1 : 0) : (col[x] > 0 ? 1 : 0);
    const a = y + r + 1, b = y - r;
    for (let x = 0; x < w; x++) col[x] += (a >= h ? pad : tmp[a * w + x]) - (b < 0 ? pad : tmp[b * w + x]);
  }
  return out;
}

// ---------- page detection ----------
// Finds the bright paper quadrilateral on a darker surface. Returns
// { quad: [TL,TR,BR,BL] in source pixel coords, confidence }.
export function detectPage(img) {
  const maxSide = 640;
  const sc = Math.min(1, maxSide / Math.max(img.w, img.h));
  const w = Math.max(8, Math.round(img.w * sc)), h = Math.max(8, Math.round(img.h * sc));
  // box downsample luminance
  const L = new Float32Array(w * h);
  const cnt = new Float32Array(w * h);
  for (let y = 0; y < img.h; y++) {
    const ty = Math.min(h - 1, Math.floor(y * sc));
    for (let x = 0; x < img.w; x++) {
      const tx = Math.min(w - 1, Math.floor(x * sc));
      const i = (y * img.w + x) * 4;
      L[ty * w + tx] += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
      cnt[ty * w + tx]++;
    }
  }
  for (let i = 0; i < L.length; i++) L[i] = cnt[i] ? L[i] / cnt[i] : 0;
  const B = gaussBlur(L, w, h, 1.5);

  // Already-cropped check: if even the darkest part of the border ring is
  // paper-bright relative to the page, there is no surface around it.
  {
    const hAll = new Uint32Array(256), hRing = new Uint32Array(256); let nAll = 0, nRing = 0;
    const rw = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    for (let y = 0; y < h; y++) {
      const edgeRow = y < rw || y >= h - rw;
      for (let x = 0; x < w; x++) {
        let b = B[y * w + x] | 0; if (b > 255) b = 255; else if (b < 0) b = 0;
        hAll[b]++; nAll++;
        if (edgeRow || x < rw || x >= w - rw) { hRing[b]++; nRing++; }
      }
    }
    const pct = (hist, n, p) => { let acc = 0; const target = n * p; for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc > target) return b; } return 255; };
    const ringP10 = pct(hRing, nRing, 0.10), pageP90 = pct(hAll, nAll, 0.90);    if (ringP10 >= 0.55 * pageP90) {
      return { quad: [[0, 0], [img.w, 0], [img.w, img.h], [0, img.h]], confidence: 1, threshold: 0, fullFrame: true };
    }
  }

  // Otsu
  const hist = new Float64Array(256);
  for (let i = 0; i < B.length; i++) hist[clamp(Math.round(B[i]), 0, 255)]++;
  let total = B.length, sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  // Segment the paper: threshold, open (cut thin bridges to glare), keep the
  // largest blob, then re-threshold relative to that blob's own brightness.
  const openR = Math.max(2, Math.round(w / 120));
  const segment = (t) => {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = B[i] > t ? 1 : 0;
    const mask = morph(morph(m, w, h, openR, true), w, h, openR, false);   // opening: erode, then dilate
    const label = new Int32Array(w * h);
    let bestLabel = 0, bestSize = 0, cur = 0;
    const stack = new Int32Array(w * h);
    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || label[s]) continue;
      cur++;
      let sp = 0, size = 0;
      stack[sp++] = s; label[s] = cur;
      while (sp) {
        const p = stack[--sp]; size++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = cur; }
    }
    return { label, bestLabel, bestSize };
  };
  let seg = segment(thr);
  for (let iter = 0; iter < 2; iter++) {
    const hh = new Uint32Array(256); let cnt = 0;
    for (let i = 0; i < B.length; i++) if (seg.label[i] === seg.bestLabel) { let b = B[i] | 0; if (b > 255) b = 255; hh[b]++; cnt++; }
    let acc = 0, paperMed = 200; for (let b = 0; b < 256; b++) { acc += hh[b]; if (acc >= cnt / 2) { paperMed = b; break; } }
    const t2 = Math.max(thr, paperMed * 0.84);
    seg = segment(t2);
  }
  const { label, bestLabel, bestSize } = seg;
  // extreme points along the 4 diagonals
  let tl = null, tr = null, br = null, bl = null;
  let vTL = Infinity, vTR = -Infinity, vBR = -Infinity, vBL = Infinity;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (label[y * w + x] !== bestLabel) continue;
    const s = x + y, d = x - y;
    if (s < vTL) { vTL = s; tl = [x, y]; }
    if (d > vTR) { vTR = d; tr = [x, y]; }
    if (s > vBR) { vBR = s; br = [x, y]; }
    if (d < vBL) { vBL = d; bl = [x, y]; }
  }
  const up = (p) => [(p[0] + 0.5) / sc, (p[1] + 0.5) / sc];
  const quad = [tl, tr, br, bl].map(up);
  const fill = bestSize / (w * h);
  // paper fills the frame: image is already cropped (e.g. Apple's scanner output)
  const fullFrame = fill > 0.82;
  return { quad, confidence: fill, threshold: thr, fullFrame };
}

// ---------- homography + warp ----------
function solveHomography(src, dst) {
  // maps src[i] -> dst[i]; returns 3x3 as array of 9
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return [...x, 1];
}


// Sanity checks on a detected page quadrilateral.
export function quadLooksValid(q, img) {
  const [tl, tr, br, bl] = q;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const top = d(tl, tr), bot = d(bl, br), lef = d(tl, bl), rig = d(tr, br);
  const area = Math.abs((tl[0] * tr[1] - tr[0] * tl[1]) + (tr[0] * br[1] - br[0] * tr[1]) + (br[0] * bl[1] - bl[0] * br[1]) + (bl[0] * tl[1] - tl[0] * bl[1])) / 2;
  if (area < 0.28 * img.w * img.h) return false;
  const minSide = Math.min(top, bot, lef, rig), maxSide = Math.max(top, bot, lef, rig);
  if (minSide < 0.2 * Math.max(img.w, img.h)) return false;
  if (Math.max(top, bot) / Math.min(top, bot) > 1.6 || Math.max(lef, rig) / Math.min(lef, rig) > 1.6) return false;
  const ratio = ((lef + rig) / 2) / ((top + bot) / 2);
  if (ratio < 0.5 || ratio > 2.0) return false;
  // convexity: consistent cross-product signs
  const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  const s = [cr(tl, tr, br), cr(tr, br, bl), cr(br, bl, tl), cr(bl, tl, tr)];
  return s.every((v) => v > 0) || s.every((v) => v < 0);
}


// ===== Fast pipeline (v2) =====
// Design rules, from measuring the first version and from the limits of old iPhones:
//  - one illumination field for the whole page, not one per colour channel
//  - the warp writes a single linear-light plane, so later stages touch 1 channel, not 3
//  - box-blur cascades (running sums) in place of true gaussians
//  - side maps (colour, gate) live at 1/4 resolution
//  - the stored analysis is 3 bytes per pixel, so many pages fit in an old phone's memory
//  - nothing here needs a canvas, so it all runs in a Worker (iOS 12 has no OffscreenCanvas)
//  - plain loops over typed arrays, no allocation in hot paths, ES2018 syntax only

export const DEFAULTS = {
  pageW: 8.5, pageH: 11,
  cropMargin: 0.006,
  floorK: 4.0, strongK: 7.0, gate: 0.85, gateRadius: 14,
  denoise: 0.8, deblur: 2.5, deblurSigma: 2.5, edgeTrim: 18,
  gamma: 1.1, inkRef: 0.99, inkMin: 0.10, weight: 0.0, isoFloor: 0.22, ruleSuppress: 1.0,
};

const SRGB_LIN = (() => { const t = new Float32Array(256); for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); } return t; })();
const noop = () => {};

// ---------- box blur cascade ----------
function boxRadii(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  if (wl < 1) wl = 1;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const out = [];
  for (let i = 0; i < n; i++) out.push(((i < m ? wl : wu) - 1) / 2);
  return out;
}
function blurH(src, dst, w, h, r) {
  if (r < 1) { dst.set(src); return; }
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w, last = src[o + w - 1], first = src[o];
    let acc = first * (r + 1);
    for (let i = 1; i <= r; i++) acc += src[o + (i < w ? i : w - 1)];
    let x = 0;
    const lim1 = Math.min(r, w);
    for (; x < lim1; x++) { dst[o + x] = acc * inv; acc += (x + r + 1 < w ? src[o + x + r + 1] : last) - first; }
    const lim2 = w - r - 1;
    for (; x < lim2; x++) { dst[o + x] = acc * inv; acc += src[o + x + r + 1] - src[o + x - r]; }
    for (; x < w; x++) { dst[o + x] = acc * inv; acc += last - src[o + x - r]; }
  }
}
function blurV(src, dst, w, h, r, col) {
  if (r < 1) { dst.set(src); return; }
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) col[x] = src[x] * (r + 1);
  for (let i = 1; i <= r; i++) { const o = (i < h ? i : h - 1) * w; for (let x = 0; x < w; x++) col[x] += src[o + x]; }
  for (let y = 0; y < h; y++) {
    const o = y * w, a = (y + r + 1 < h ? y + r + 1 : h - 1) * w, s = (y - r >= 0 ? y - r : 0) * w;
    for (let x = 0; x < w; x++) { dst[o + x] = col[x] * inv; col[x] += src[a + x] - src[s + x]; }
  }
}
// blurs `a` in place; `tmp` is scratch. `step(i,n)` reports progress.
function blur3(a, tmp, w, h, sigma) {   // separable 3-tap gaussian for sigma below one pixel
  const e = Math.exp(-1 / (2 * sigma * sigma)), s = 1 + 2 * e, c = 1 / s, sd = e / s;
  for (let y = 0; y < h; y++) {
    const o = y * w; tmp[o] = a[o] * (c + sd) + a[o + 1] * sd;
    for (let x = 1; x < w - 1; x++) tmp[o + x] = a[o + x - 1] * sd + a[o + x] * c + a[o + x + 1] * sd;
    tmp[o + w - 1] = a[o + w - 1] * (c + sd) + a[o + w - 2] * sd;
  }
  for (let x = 0; x < w; x++) a[x] = tmp[x] * (c + sd) + tmp[w + x] * sd;
  for (let y = 1; y < h - 1; y++) { const o = y * w; for (let x = 0; x < w; x++) a[o + x] = tmp[o - w + x] * sd + tmp[o + x] * c + tmp[o + w + x] * sd; }
  const l = (h - 1) * w; for (let x = 0; x < w; x++) a[l + x] = tmp[l + x] * (c + sd) + tmp[l - w + x] * sd;
}
function gaussBox(a, tmp, w, h, sigma, col, step) {
  if (sigma < 0.3) return;
  if (sigma < 0.9) { blur3(a, tmp, w, h, sigma); if (step) step(1, 1); return; }
  const radii = boxRadii(sigma, 3);
  for (let i = 0; i < radii.length; i++) { blurH(a, tmp, w, h, radii[i]); blurV(tmp, a, w, h, radii[i], col); if (step) step(i + 1, radii.length); }
}

// ---------- geometry ----------
export function pageGeometry(sw, sh, quadN, dpi, opts) {
  const p = Object.assign({}, DEFAULTS, opts || {});
  if (!quadN) {   // already a cropped page: keep native resolution, capped at the target
    const cap = Math.round(Math.max(p.pageW, p.pageH) * dpi);
    const k = Math.min(1, cap / Math.max(sw, sh));
    const w = Math.max(16, Math.round(sw * k)), h = Math.max(16, Math.round(sh * k));
    return { quad: [[0, 0], [sw, 0], [sw, sh], [0, sh]], w, h, dpi: Math.max(w, h) / Math.max(p.pageW, p.pageH), inset: 0, fullFrame: true };
  }
  const quad = quadN.map((q) => [q[0] * sw, q[1] * sh]);
  const [tl, tr, br, bl] = quad;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wEst = (d(tl, tr) + d(bl, br)) / 2, hEst = (d(tl, bl) + d(tr, br)) / 2;
  let ratio = hEst / wEst; const letter = p.pageH / p.pageW;
  if (Math.abs(ratio - letter) / letter < 0.12) ratio = letter; else if (Math.abs(1 / ratio - letter) / letter < 0.12) ratio = 1 / letter;
  let w = Math.round(p.pageW * dpi), h = Math.round(w * ratio);
  if (ratio < 1) { h = Math.round(p.pageW * dpi); w = Math.round(h / ratio); }
  return { quad, w, h, dpi, inset: p.cropMargin, fullFrame: false };
}

function insetQuad(quad, m) {
  const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4, cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
  return quad.map((p) => [p[0] + (cx - p[0]) * m * 2, p[1] + (cy - p[1]) * m * 2]);
}
// inverse homography: output pixel -> source pixel. Returns [h0..h7].
function inverseMap(quad, outW, outH) {
  const H = solveHomography([[0, 0], [outW, 0], [outW, outH], [0, outH]], quad);
  return H;
}

// 80th percentile of each channel over a sparse grid inside the page: the colour of the paper
function paperColour(src, sw, sh, quad) {
  const R = [], G = [], B = [];
  const nu = 28, nv = 36;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const u = 0.04 + 0.92 * (i / (nu - 1)), v = 0.04 + 0.92 * (j / (nv - 1));
    const x = (1 - v) * ((1 - u) * quad[0][0] + u * quad[1][0]) + v * ((1 - u) * quad[3][0] + u * quad[2][0]);
    const y = (1 - v) * ((1 - u) * quad[0][1] + u * quad[1][1]) + v * ((1 - u) * quad[3][1] + u * quad[2][1]);
    const xi = Math.min(sw - 1, Math.max(0, x | 0)), yi = Math.min(sh - 1, Math.max(0, y | 0));
    const o = (yi * sw + xi) * 4; R.push(src[o]); G.push(src[o + 1]); B.push(src[o + 2]);
  }
  const q = (a) => { a.sort((p1, p2) => p1 - p2); return a[Math.floor(0.82 * (a.length - 1))]; };
  return [q(R), q(G), q(B)];
}

// small colour copy of the straightened page, for "hold to compare"
export function warpPreview(src, sw, sh, geom, maxW) {
  const k = Math.min(1, maxW / geom.w);
  const ow = Math.max(8, Math.round(geom.w * k)), oh = Math.max(8, Math.round(geom.h * k));
  const quad = geom.inset ? insetQuad(geom.quad, geom.inset) : geom.quad;
  const H = inverseMap(quad, ow, oh);
  const out = new Uint8Array(ow * oh * 4), s = src;
  for (let y = 0; y < oh; y++) {
    const py = y + 0.5;
    for (let x = 0; x < ow; x++) {
      const px = x + 0.5, dn = H[6] * px + H[7] * py + 1;
      let sx = (H[0] * px + H[1] * py + H[2]) / dn - 0.5, sy = (H[3] * px + H[4] * py + H[5]) / dn - 0.5;
      sx = sx < 0 ? 0 : sx > sw - 1.001 ? sw - 1.001 : sx; sy = sy < 0 ? 0 : sy > sh - 1.001 ? sh - 1.001 : sy;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i = (y0 * sw + x0) * 4, rs = sw * 4, o = (y * ow + x) * 4;
      for (let c = 0; c < 3; c++) { const a = s[i + c], b = s[i + 4 + c], cc = s[i + rs + c], d = s[i + rs + 4 + c]; const t = a + (b - a) * fx, bt = cc + (d - cc) * fx; out[o + c] = t + (bt - t) * fy + 0.5; }
      out[o + 3] = 255;
    }
  }
  return { data: out, w: ow, h: oh };
}

// ---------- stage 1: straighten, flatten the light, measure the ink ----------
// src: RGBA bytes (Uint8Array/Uint8ClampedArray) of size sw*sh*4.
// Returns a compact analysis that shape() turns into pixels. `prog(frac, label)` is called often.
export function analyze(src, sw, sh, geom, opts, prog, release) {
  prog = prog || noop;
  const p = Object.assign({}, DEFAULTS, opts || {});
  const W = geom.w, H = geom.h, n = W * H, dpi = geom.dpi, scale = dpi / 300;
  let s8 = src instanceof Uint8Array ? src : new Uint8Array(src.buffer, src.byteOffset, src.length);
  const quad = geom.inset ? insetQuad(geom.quad, geom.inset) : geom.quad;

  // paper colour -> channel coefficients. Each channel is weighted by how much light it has,
  // and divided by the paper's own value, so a colour cast cancels.
  const pc = paperColour(s8, sw, sh, geom.quad);
  const wt = pc.map((v) => Math.pow(Math.max(v, 8), 1.5)); const wsum = wt[0] + wt[1] + wt[2];
  const kR = SRGB_LIN[pc[0] | 0] || 1e-3, kG = SRGB_LIN[pc[1] | 0] || 1e-3, kB = SRGB_LIN[pc[2] | 0] || 1e-3;
  const cR = wt[0] / wsum / kR, cG = wt[1] / wsum / kG, cB = wt[2] / wsum / kB;
  const iR = 1 / kR, iG = 1 / kG, iB = 1 / kB;
  const paperLuma = 0.3 * pc[0] + 0.55 * pc[1] + 0.15 * pc[2];

  const L = new Float32Array(n);       // becomes the density plane
  const cw = (W + 3) >> 2, ch = (H + 3) >> 2;
  const chromaF = new Float32Array(cw * ch);
  let sat = 0, satN = 0;

  // -- pass 1, over the photo: collapse red, green and blue into one linear-light plane (16 bit) --
  //    and keep a colour-ness sample every 4th pixel. After this the photo itself can be freed.
  const sw2 = (sw + 1) >> 1, sh2 = (sh + 1) >> 1, chromaS = new Float32Array(sw2 * sh2), P16 = new Uint16Array(sw * sh);
  const SC = 40000;
  for (let y = 0; y < sh; y++) {
    let o = y * sw * 4; const row = y * sw, coarse = (y & 3) === 0, crow = (y >> 1) * sw2;
    for (let x = 0; x < sw; x++, o += 4) {
      const r = s8[o], g = s8[o + 1], bl = s8[o + 2];
      const lr = SRGB_LIN[r], lg = SRGB_LIN[g], lb = SRGB_LIN[bl];
      const l = (cR * lr + cG * lg + cB * lb) * SC; P16[row + x] = l > 65535 ? 65535 : l;
      const rr = lr * iR, gg = lg * iG, bb = lb * iB;   // how far from neutral: the sum over a 2x2 cell is kept
      chromaS[crow + (x >> 1)] += (rr > gg ? (rr > bb ? rr : bb) : (gg > bb ? gg : bb)) - (rr < gg ? (rr < bb ? rr : bb) : (gg < bb ? gg : bb));
      if (coarse && (x & 3) === 0) { satN++; if (r > 252 && g > 252 && bl > 252) sat++; }
    }
    if ((y & 127) === 0) prog(0.08 * (y / sh), 'Reading the photo');
  }
  s8 = null; if (release) release();   // free the photo's pixels before the heavy stages
  prog(0.08, 'Straightening the page');

  // -- pass 2: straighten. One channel to interpolate. The exact position is computed every 8 pixels. --
  const Hm = inverseMap(quad, W, H);
  const h0 = Hm[0], h1 = Hm[1], h2 = Hm[2], h3 = Hm[3], h4 = Hm[4], h5 = Hm[5], h6 = Hm[6], h7 = Hm[7];
  const maxX = sw - 1.001, maxY = sh - 1.001, NODE = 8, invSC = 1 / SC;
  for (let y = 0; y < H; y++) {
    const py = y + 0.5, hy1 = h1 * py + h2, hy4 = h4 * py + h5, hy7 = h7 * py + 1;
    const row = y * W, coarseRow = (y & 3) === 0, crow = (y >> 2) * cw;
    let x1n = 0, dsx = 0, dsy = 0, sxc = 0, syc = 0;
    for (let x = 0; x < W; x++) {
      if (x === x1n) {   // next node: exact position here and at the far end, then step linearly
        x1n = x + NODE < W ? x + NODE : W;
        const pxA = x + 0.5, dnA = h6 * pxA + hy7, pxB = x1n + 0.5, dnB = h6 * pxB + hy7;
        sxc = (h0 * pxA + hy1) / dnA - 0.5; syc = (h3 * pxA + hy4) / dnA - 0.5;
        const sxB = (h0 * pxB + hy1) / dnB - 0.5, syB = (h3 * pxB + hy4) / dnB - 0.5, span = x1n - x;
        dsx = (sxB - sxc) / span; dsy = (syB - syc) / span;
      }
      let sx = sxc, sy = syc; sxc += dsx; syc += dsy;
      sx = sx < 0 ? 0 : sx > maxX ? maxX : sx; sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0, i = y0 * sw + x0;
      const a = P16[i], b = P16[i + 1], c = P16[i + sw], d = P16[i + sw + 1];
      const t = a + (b - a) * fx;
      L[row + x] = (t + ((c + (d - c) * fx) - t) * fy) * invSC;
      if (coarseRow && (x & 3) === 0) {   // colour-ness at this spot: bilinear read of the 2x2-cell sums
        let cu = (sx - 0.5) * 0.5, cv = (sy - 0.5) * 0.5; if (cu < 0) cu = 0; if (cv < 0) cv = 0; if (cu > sw2 - 1.001) cu = sw2 - 1.001; if (cv > sh2 - 1.001) cv = sh2 - 1.001;
        const iu = cu | 0, iv = cv | 0, fu = cu - iu, fv = cv - iv, ci = iv * sw2 + iu;
        const c0 = chromaS[ci] + (chromaS[ci + 1] - chromaS[ci]) * fu, c1 = chromaS[ci + sw2] + (chromaS[ci + sw2 + 1] - chromaS[ci + sw2]) * fu;
        chromaF[crow + (x >> 2)] = (c0 + (c1 - c0) * fv) * 0.25;
      }
    }
    if ((y & 63) === 0) prog(0.08 + 0.22 * (y / H), 'Straightening the page');
  }
  prog(0.30, 'Lifting the shadows');

  // -- illumination field: 88th percentile per block, max-filtered and smoothed --
  const BS = Math.max(10, Math.round(16 * scale));
  const gw = Math.ceil(W / BS), gh = Math.ceil(H / BS);
  const grid = new Float32Array(gw * gh), top = new Float32Array(BS * BS);
  for (let gy = 0; gy < gh; gy++) {
    const y0 = gy * BS, y1 = Math.min(H, y0 + BS);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * BS, x1 = Math.min(W, x0 + BS); let k = 0;
      for (let y = y0; y < y1; y += 2) { const o = y * W; for (let x = x0; x < x1; x += 2) k++; }
      const K = Math.max(1, k - Math.floor(0.88 * (k - 1)));   // the K-th largest sample is the 88th percentile
      for (let i = 0; i < K; i++) top[i] = -9;
      for (let y = y0; y < y1; y += 2) {
        const o = y * W;
        for (let x = x0; x < x1; x += 2) {
          const v = L[o + x];
          if (v > top[0]) { let j = 0; while (j + 1 < K && top[j + 1] < v) { top[j] = top[j + 1]; j++; } top[j] = v; }
        }
      }
      grid[gy * gw + gx] = top[0];
    }
  }
  let g2 = maxFilter(grid, gw, gh, 1); g2 = gaussBlur(g2, gw, gh, 1.4);
  prog(0.36, 'Lifting the shadows');

  // -- density = 1 - light / paper, computed in place. The paper's inverse is interpolated per row. --
  const xa = new Int32Array(W), tx = new Float32Array(W), rowInv = new Float32Array(gw);
  for (let x = 0; x < W; x++) { const f = Math.min(gw - 1, Math.max(0, (x + 0.5) / BS - 0.5)); const a = Math.floor(f); xa[x] = Math.min(gw - 2 < 0 ? 0 : gw - 2, a); tx[x] = f - xa[x]; }
  for (let y = 0; y < H; y++) {
    const f = Math.min(gh - 1, Math.max(0, (y + 0.5) / BS - 0.5)), ya = Math.floor(f), yb = Math.min(gh - 1, ya + 1), ty = f - ya;
    for (let gx = 0; gx < gw; gx++) { const pv = g2[ya * gw + gx] * (1 - ty) + g2[yb * gw + gx] * ty; rowInv[gx] = 1 / (pv > 0.02 ? pv : 0.02); }
    const row = y * W;
    for (let x = 0; x < W; x++) { const a = xa[x], t2 = tx[x]; const ip = rowInv[a] * (1 - t2) + rowInv[a + 1 > gw - 1 ? gw - 1 : a + 1] * t2; L[row + x] = 1 - L[row + x] * ip; }
  }
  prog(0.42, 'Measuring the noise');

  // -- noise level from the Laplacian on a sparse sample (median absolute deviation) --
  const nb = new Uint32Array(1200); let nCnt = 0;
  for (let y = 1; y < H - 1; y += 3) { const o = y * W; for (let x = 1; x < W - 1; x += 3) { const i = o + x; let v = L[i] - 0.25 * (L[i - 1] + L[i + 1] + L[i - W] + L[i + W]); if (v < 0) v = -v; let b = (v * 4000) | 0; if (b > 1199) b = 1199; nb[b]++; nCnt++; } }
  let acc = 0, mb = 0; for (; mb < 1200; mb++) { acc += nb[mb]; if (acc >= nCnt / 2) break; }
  const noise0 = (mb / 4000) * 1.4826 / 1.118 * 1.0;
  const nk = Math.min(5, Math.max(1, noise0 / 0.025));

  // -- denoise, remember the un-sharpened density (it tells faint ruling from pencil), then undo camera blur --
  const tmp = new Float32Array(n), col = new Float32Array(W);
  const sig1 = p.denoise * scale * nk;
  gaussBox(L, tmp, W, H, sig1, col, (i, m) => prog(0.42 + 0.14 * (i / m), 'Cleaning the ink'));
  const dens0 = new Uint8Array(n), densQ = new Int16Array(n);
  const deb = p.deblur / Math.sqrt(nk), doDeblur = deb > 0.05;
  for (let i = 0; i < n; i++) { const v = L[i]; const q = (v * 255 + 0.5) | 0; dens0[i] = q < 0 ? 0 : q > 255 ? 255 : q; if (doDeblur) tmp[i] = v; }
  if (doDeblur) {
    const scratch = new Float32Array(n);      // second scratch for the cascade
    gaussBox(tmp, scratch, W, H, p.deblurSigma * scale * Math.min(1.6, Math.sqrt(nk)), col, (i, m) => prog(0.56 + 0.2 * (i / m), 'Sharpening the strokes'));
  }
  // one pass: sharpen, keep the float for the statistics, store the 16-bit copy
  for (let i = 0; i < n; i++) {
    let v = L[i]; if (doDeblur) { v += deb * (v - tmp[i]); L[i] = v; }
    let f = v * 4096; if (f > 32767) f = 32767; else if (f < -32767) f = -32767; densQ[i] = f;
  }
  prog(0.78, 'Measuring the ink');

  // -- statistics on a sparse sample, by histogram --
  const edge = Math.round(p.edgeTrim * scale);
  const NB = 4400, LO = -0.6, RES = 2000;   // 1/RES per bin
  const hist = new Uint32Array(NB); let total = 0;
  for (let y = edge; y < H - edge; y += 3) { const o = y * W; for (let x = edge; x < W - edge; x += 3) { let b = ((L[o + x] - LO) * RES) | 0; if (b < 0) b = 0; else if (b >= NB) b = NB - 1; hist[b]++; total++; } }
  let c2 = 0, medBin = 0; for (; medBin < NB; medBin++) { c2 += hist[medBin]; if (c2 >= total / 2) break; }
  const med = LO + (medBin + 0.5) / RES;
  const dh = new Uint32Array(2200); c2 = 0;
  for (let b = 0; b < NB; b++) { if (!hist[b]) continue; const dv = Math.abs(LO + (b + 0.5) / RES - med); let k = (dv * RES) | 0; if (k > 2199) k = 2199; dh[k] += hist[b]; }
  let mad = 0; c2 = 0; for (; mad < 2200; mad++) { c2 += dh[mad]; if (c2 >= total / 2) break; }
  const sigma = Math.max(1e-4, 1.4826 * (mad + 0.5) / RES);
  const tStrong = med + p.strongK * sigma;
  let sBin = Math.max(0, Math.floor((tStrong - LO) * RES)), strongTotal = 0;
  for (let b = sBin; b < NB; b++) strongTotal += hist[b];
  let dRefRaw = 0.3;
  if (strongTotal > 0) { const target = strongTotal * p.inkRef; let a2 = 0; for (let b = sBin; b < NB; b++) { a2 += hist[b]; if (a2 >= target) { dRefRaw = LO + (b + 0.5) / RES - med; break; } } }

  // -- gate: where is there strong ink? computed on a 1/4-resolution grid --
  const gcw = cw, gch = ch, strongC = new Float32Array(gcw * gch), cm = new Float32Array(gcw);
  for (let y = 0; y < H; y++) {
    if ((y & 3) === 0) cm.fill(-9);
    if ((y & 1) === 0) { const o = y * W; for (let x = 0; x < W; x += 2) { const v = L[o + x]; const c = x >> 2; if (v > cm[c]) cm[c] = v; } }
    if ((y & 3) === 3 || y === H - 1) { const base = (y >> 2) * gcw; for (let c = 0; c < gcw; c++) strongC[base + c] = cm[c] > tStrong ? 1 : 0; }
  }
  const rc = Math.max(1, Math.round(p.gateRadius * scale * 0.5 / 4));
  let gate = gaussBlur(maxFilter(strongC, gcw, gch, rc), gcw, gch, Math.max(0.5, p.gateRadius * scale * 0.35 / 4));
  const gateQ = new Uint8Array(gcw * gch); for (let i = 0; i < gateQ.length; i++) { const v = gate[i] * 1.6; gateQ[i] = v >= 1 ? 255 : (v * 255) | 0; }
  const chromaB = gaussBlur(chromaF, cw, ch, 0.5), chromaQ = new Uint8Array(cw * ch);
  for (let i = 0; i < chromaQ.length; i++) { const v = (chromaB[i] * 255 + 0.5) | 0; chromaQ[i] = v > 255 ? 255 : v < 0 ? 0 : v; }
  // the page's own colour noise: its median. Only colour above this counts as ruling.
  const ch256 = new Uint32Array(256); for (let i = 0; i < chromaQ.length; i++) ch256[chromaQ[i]]++;
  let chromaBase = 0; { let acc = 0; for (let b = 0; b < 256; b++) { acc += ch256[b]; if (acc >= chromaQ.length / 2) { chromaBase = b; break; } } }

  prog(1, 'Done');
  return { w: W, h: H, dpi, scale, densQ, dens0, gateQ, chromaQ, chromaBase, cw, ch, edge,
    stats: { med, sigma, tStrong, dRefRaw, noise0, noiseK: nk, satFrac: satN ? sat / satN : 0, paperLuma } };
}

// ---------- stage 2: turn density into black ink on white. Fast enough to run on every slider tick. ----------
// out: Uint8Array(w*h) gray (255 = paper). Returns quality flags.
export function shape(an, opts, out, mode) {
  const p = Object.assign({}, DEFAULTS, opts || {});
  const { w, h, densQ, dens0, gateQ, chromaQ, cw, ch, edge } = an;
  if (mode === 'gray') return shapePhoto(an, out);
  const { med, sigma, dRefRaw } = an.stats;
  const t0 = med + p.floorK * sigma, dRef = Math.max(dRefRaw, p.inkMin), span = Math.max(1e-4, dRef - (t0 - med));
  const t0Q = Math.floor(t0 * 4096), isoAdd = p.isoFloor * dRef, invSpan = 1 / span;
  const supp = p.ruleSuppress, gA = 1 - p.gate, gB = p.gate;
  const wg = p.weight !== 0 ? Math.pow(2, -p.weight * 1.2) : 1;
  // power curves as tables
  const NT = 1024, LT = 1.6 / (NT - 1);
  const g1 = new Float32Array(NT), g2 = new Float32Array(NT);
  for (let i = 0; i < NT; i++) g1[i] = Math.pow(i * LT, p.gamma);
  const NT2 = 1024; for (let i = 0; i < NT2; i++) g2[i] = wg === 1 ? i / (NT2 - 1) : Math.pow(i / (NT2 - 1), wg);
  out.fill(255);
  const q4 = 1 / 4096, inv255 = 1 / 255;
  let inkPx = 0, edgeInk = 0; const band = Math.round(40 * an.scale), edgeLimit = Math.round(600 * an.scale * an.scale);
  const cLo = 0.14, cHi = 0.5, dLo = 0.26, dHi = 0.46;
  const gcw = cw, gch = ch, cBase = an.chromaBase;
  for (let y = edge; y < h - edge; y++) {
    const o = y * w;
    const gy = Math.min(gch - 1, Math.max(0, (y + 0.5) / 4 - 0.5)), gya = gy | 0, gyb = gya + 1 < gch ? gya + 1 : gya, gty = gy - gya;
    for (let x = edge; x < w - edge; x++) {
      const dq = densQ[o + x];
      if (dq <= t0Q) continue;
      const d = dq * q4;
      // gate (bilinear from the 1/4-res grid)
      const gx = Math.min(gcw - 1, Math.max(0, (x + 0.5) / 4 - 0.5)), gxa = gx | 0, gxb = gxa + 1 < gcw ? gxa + 1 : gxa, gtx = gx - gxa;
      const gt = (gateQ[gya * gcw + gxa] * (1 - gtx) + gateQ[gya * gcw + gxb] * gtx) * (1 - gty) + (gateQ[gyb * gcw + gxa] * (1 - gtx) + gateQ[gyb * gcw + gxb] * gtx) * gty;
      const nr = gt * inv255;
      let a = (d - t0 - (1 - nr) * isoAdd) * invSpan;
      if (a <= 0) continue;
      a = g1[((a > 1.6 ? 1.6 : a) / LT + 0.5) | 0];
      a *= gA + gB * nr;
      if (supp > 0) {
        let cqi = chromaQ[(y >> 2) * cw + (x >> 2)] - cBase; if (cqi < 0) cqi = 0;
        const cq = cqi * inv255, d0 = dens0[o + x] * inv255;
        const colr = cq / (d0 + 0.04);
        if (colr > cLo) { const cs = colr >= cHi ? 1 : (colr - cLo) / (cHi - cLo); const fs = d0 <= dLo ? 1 : d0 >= dHi ? 0 : 1 - (d0 - dLo) / (dHi - dLo); a *= 1 - supp * cs * fs; }
      }
      if (a > 1) a = 1;
      if (a <= 0) continue;
      a = g2[(a * (NT2 - 1) + 0.5) | 0];
      if (a > 0.35) { inkPx++; if (x < band || x >= w - band || y < band || y >= h - band) edgeInk++; }
      out[o + x] = 255 - ((a * 255 + 0.5) | 0);
    }
  }
  const st = an.stats, snr = st.dRefRaw / st.sigma;
  return { inkFrac: inkPx / (w * h), blank: inkPx / (w * h) < 0.0008, clippedEdge: edgeInk > edgeLimit, lowContrast: snr < 8, veryNoisy: st.noiseK > 3, tooDark: st.paperLuma < 70, glare: st.satFrac > 0.02 && st.satFrac < 0.6, overexposed: st.satFrac >= 0.6, snr };
}
function shapePhoto(an, out) {
  const { w, h, densQ, edge } = an; const floor = an.stats.med + 2.0 * an.stats.sigma;
  const enc = new Uint8Array(1025); for (let i = 0; i <= 1024; i++) enc[i] = Math.round(255 * Math.pow(i / 1024, 1 / 2.2));
  out.fill(255);
  for (let y = edge; y < h - edge; y++) { const o = y * w; for (let x = edge; x < w - edge; x++) { const d = densQ[o + x] / 4096 - floor; if (d <= 0) continue; const r = 1 - (d > 1 ? 1 : d); out[o + x] = enc[(r * 1024 + 0.5) | 0]; } }
  return { inkFrac: 0.01, blank: false, clippedEdge: false, lowContrast: false, veryNoisy: false, tooDark: false, glare: false, overexposed: false, snr: 99 };
}

// area-average resize of a gray page (used for the "small" size)
export function resizeGray(g, w, h, nw, nh) {
  const out = new Uint8Array(nw * nh), sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = y * sy, y1 = Math.min(h, y0 + sy), ia = Math.floor(y0), ib = Math.min(h - 1, Math.ceil(y1) - 1);
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx, x1 = Math.min(w, x0 + sx), ja = Math.floor(x0), jb = Math.min(w - 1, Math.ceil(x1) - 1);
      let acc = 0, wsum = 0;
      for (let yy = ia; yy <= ib; yy++) { const wy = Math.min(yy + 1, y1) - Math.max(yy, y0); for (let xx = ja; xx <= jb; xx++) { const wx = Math.min(xx + 1, x1) - Math.max(xx, x0); const ww = wx * wy; acc += g[yy * w + xx] * ww; wsum += ww; } }
      out[y * nw + x] = (acc / wsum + 0.5) | 0;
    }
  }
  return out;
}

// darken a pre-rendered text mask into the page (the name and page number stamp)
export function applyStamp(g, w, h, mask) {
  const x0 = w - mask.w - mask.right, y0 = mask.top;
  for (let y = 0; y < mask.h; y++) { const yy = y0 + y; if (yy < 0 || yy >= h) continue; for (let x = 0; x < mask.w; x++) { const xx = x0 + x; if (xx < 0 || xx >= w) continue; const m = mask.data[y * mask.w + x]; if (m) { const v = 255 - m; if (v < g[yy * w + xx]) g[yy * w + xx] = v; } } }
}
