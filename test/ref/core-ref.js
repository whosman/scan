// Homework scan cleanup core. Pure JS, no dependencies.
// Runs unchanged in Node (test harness) and in a browser / WKWebView.
//
// Image convention: { data: Uint8ClampedArray (RGBA), w, h }

export const DEFAULTS = {
  dpi: 300,
  pageW: 8.5,           // inches
  pageH: 11,
  cropMargin: 0.006,    // fraction trimmed inside detected page edge
  floorK: 4.0,         // noise floor, in sigmas of paper noise
  strongK: 7.0,         // "definitely ink" threshold, in sigmas
  gate: 0.85,           // 0..1 how strongly isolated specks are suppressed
  gateRadius: 14,       // px at 300 dpi
  denoise: 0.8,         // gaussian sigma (px at 300 dpi) applied to ink density
  deblur: 2.5,          // camera-blur compensation strength (unsharp on density)
  deblurSigma: 2.5,     // px at 300 dpi
  edgeTrim: 18,         // px at 300 dpi zeroed at the page border
  gamma: 1.1,         // <1 lifts faint pencil, >1 thins it
  inkRef: 0.99,         // percentile of ink density mapped to full black
  inkMin: 0.10,         // never treat anything lighter than this as "full black"
  sharpen: 0.0,         // extra edge crispness on the final alpha
  weight: 0.0,          // -1 thinner .. +1 bolder
  isoFloor: 0.22,       // extra threshold (fraction of full black) for marks far from strong ink
  ruleSuppress: 1.0,    // 0 keeps coloured faint ruling, 1 removes it
};

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
    const ring = [], all = [];
    const rw = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = B[y * w + x];
      all.push(v);
      if (x < rw || y < rw || x >= w - rw || y >= h - rw) ring.push(v);
    }
    all.sort((a, b) => a - b); ring.sort((a, b) => a - b);
    const ringP10 = ring[Math.floor(ring.length * 0.10)], pageP90 = all[Math.floor(all.length * 0.90)];
    if (ringP10 >= 0.55 * pageP90) {
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
    const m = new Float32Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = B[i] > t ? 1 : 0;
    // erode = 1 - max(1 - m); then dilate back (opening)
    const inv = m.map((v) => 1 - v);
    const er = maxFilter(inv, w, h, openR).map((v) => 1 - v);
    const op = maxFilter(er, w, h, openR);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = op[i] > 0.5 ? 1 : 0;
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
    const vals = [];
    for (let i = 0; i < B.length; i++) if (seg.label[i] === seg.bestLabel) vals.push(B[i]);
    vals.sort((a, b) => a - b);
    const paperMed = vals[vals.length >> 1] || 200;
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

export function warpToRect(img, quad, outW, outH, margin = 0) {
  // inset quad toward its centre by `margin` fraction on each side
  const cx = quad.reduce((a, p) => a + p[0], 0) / 4, cy = quad.reduce((a, p) => a + p[1], 0) / 4;
  const q = quad.map((p) => [p[0] + (cx - p[0]) * margin * 2, p[1] + (cy - p[1]) * margin * 2]);
  // inverse map: dst rect -> src quad
  const dst = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
  const H = solveHomography(dst, q);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sw = img.w, sh = img.h, sd = img.data;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const px = x + 0.5, py = y + 0.5;
      const dn = H[6] * px + H[7] * py + 1;
      const sx = (H[0] * px + H[1] * py + H[2]) / dn - 0.5;
      const sy = (H[3] * px + H[4] * py + H[5]) / dn - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      const fx = sx - x0, fy = sy - y0;
      const xa = clamp(x0, 0, sw - 1), xb = clamp(x0 + 1, 0, sw - 1);
      const ya = clamp(y0, 0, sh - 1), yb = clamp(y0 + 1, 0, sh - 1);
      const i00 = (ya * sw + xa) * 4, i10 = (ya * sw + xb) * 4, i01 = (yb * sw + xa) * 4, i11 = (yb * sw + xb) * 4;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[o + c] = (sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx) * (1 - fy) + (sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { data: out, w: outW, h: outH };
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

export function rectifyPage(img, opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  let det = opts.quad ? { quad: opts.quad, confidence: 1 } : detectPage(img);
  let lowConfidence = false;
  if (!opts.quad && !det.fullFrame && !quadLooksValid(det.quad, img)) {
    // detection failed (e.g. strong shadow, light desk): fall back to the whole frame
    det = { quad: [[0, 0], [img.w, 0], [img.w, img.h], [0, img.h]], confidence: 0, fullFrame: true };
    lowConfidence = true;
  }
  if (det.fullFrame) {
    // already cropped: keep native resolution (capped at the target dpi), no inset
    const full = [[0, 0], [img.w, 0], [img.w, img.h], [0, img.h]];
    const cap = Math.round(Math.max(p.pageW, p.pageH) * p.dpi);
    const k = Math.min(1, cap / Math.max(img.w, img.h));
    const ow = Math.round(img.w * k), oh = Math.round(img.h * k);
    const warped = k === 1 ? img : warpToRect(img, full, ow, oh, 0);
    // effective resolution assuming the sheet is page-sized (letter by default)
    return { image: warped, quad: full, confidence: det.confidence, fullFrame: true, lowConfidence, dpi: Math.max(ow, oh) / Math.max(p.pageW, p.pageH) };
  }
  const [tl, tr, br, bl] = det.quad;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const wEst = (d(tl, tr) + d(bl, br)) / 2, hEst = (d(tl, bl) + d(tr, br)) / 2;
  let ratio = hEst / wEst;
  const letter = p.pageH / p.pageW;
  // snap to the paper ratio when close (perspective skews the raw estimate)
  if (Math.abs(ratio - letter) / letter < 0.12) ratio = letter;
  else if (Math.abs(1 / ratio - letter) / letter < 0.12) ratio = 1 / letter;
  let outW = Math.round(p.pageW * p.dpi), outH = Math.round(outW * ratio);
  if (ratio < 1) { outH = Math.round(p.pageW * p.dpi); outW = Math.round(outH / ratio); }
  const warped = warpToRect(img, det.quad, outW, outH, p.cropMargin);
  return { image: warped, quad: det.quad, confidence: det.confidence, dpi: Math.max(outW, outH) / Math.max(p.pageW, p.pageH) };
}

// ---------- ink extraction ----------
// Stage 1 (heavy, once per page): paper model, flat-field, density, gate.
// Input: rectified RGBA page. Output: analysis object reused by shapeInk().
export function analyzeInk(page, opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  const { w, h, data } = page;
  const n = w * h;
  const scale = p.dpi / 300;

  // 1. paper model per channel: block percentile -> 3x3 max -> blur -> bilinear upsample
  const BS = 16;
  const gw = Math.ceil(w / BS), gh = Math.ceil(h / BS);
  const paperLin = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const hist = new Uint32Array(256);
  const paperLevel = [255, 255, 255];
  for (let c = 0; c < 3; c++) {
    const grid = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      hist.fill(0);
      let cntv = 0;
      const x0 = gx * BS, y0 = gy * BS, x1 = Math.min(w, x0 + BS), y1 = Math.min(h, y0 + BS);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[data[(y * w + x) * 4 + c]]++; cntv++; }
      const target = cntv * 0.88; let acc = 0, v = 255;
      for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) { v = i; break; } }
      grid[gy * gw + gx] = v;
    }
    let g2 = maxFilter(grid, gw, gh, 1);
    g2 = gaussBlur(g2, gw, gh, 1.4);
    paperLevel[c] = Array.from(g2).sort((a, b) => a - b)[g2.length >> 1];
    const P = paperLin[c];
    for (let y = 0; y < h; y++) {
      const fy = clamp((y + 0.5) / BS - 0.5, 0, gh - 1), ya = Math.floor(fy), yb = Math.min(gh - 1, ya + 1), ty = fy - ya;
      for (let x = 0; x < w; x++) {
        const fx = clamp((x + 0.5) / BS - 0.5, 0, gw - 1), xa = Math.floor(fx), xb = Math.min(gw - 1, xa + 1), tx = fx - xa;
        const v = (g2[ya * gw + xa] * (1 - tx) + g2[ya * gw + xb] * tx) * (1 - ty) + (g2[yb * gw + xa] * (1 - tx) + g2[yb * gw + xb] * tx) * ty;
        P[y * w + x] = SRGB2LIN[clamp(Math.round(v), 0, 255)];
      }
    }
  }

  // 2. ink density in linear light, flat-fielded per channel, luma-weighted
  let dens = new Float32Array(n);
  // Channel weights: graphite is neutral, so weight each channel by how much
  // signal it has (a dark warm-lit blue channel is mostly noise).
  const wts = paperLevel.map((v) => Math.pow(Math.max(v, 8), 1.5));
  { const s = wts[0] + wts[1] + wts[2]; for (let c = 0; c < 3; c++) wts[c] /= s; }
  // colour-ness of ink: spread of the per-channel reflectance ratios
  // (graphite is neutral; ruled lines, graph paper and coloured pens are not)
  let chroma = new Float32Array(n);
  let sat = 0;
  for (let i = 0; i < n; i++) {
    let d = 0, rr = 0, gg = 0, bb = 0;
    for (let c = 0; c < 3; c++) {
      const r = SRGB2LIN[data[i * 4 + c]] / Math.max(paperLin[c][i], 1e-4);
      d += wts[c] * (1 - r);
      if (c === 0) rr = r; else if (c === 1) gg = r; else bb = r;
    }
    dens[i] = d;
    chroma[i] = Math.max(rr, gg, bb) - Math.min(rr, gg, bb);
    if (data[i * 4] > 252 && data[i * 4 + 1] > 252 && data[i * 4 + 2] > 252) sat++;
  }
  chroma = gaussBlur(chroma, w, h, 1.6 * scale);

  // valid-area mask: page border excluded from statistics and zeroed on output
  const edge = Math.round(p.edgeTrim * scale);
  const valid = new Uint8Array(n);
  for (let y = edge; y < h - edge; y++) valid.fill(1, y * w + edge, y * w + w - edge);

  // 3. noise-adaptive denoise, then undo camera blur (unsharp on density)
  //    so strokes keep their true width. Dim / noisy captures get more smoothing
  //    and less sharpening automatically.
  const lightBlur = gaussBlur(dens, w, h, 1.2 * scale);
  const nstep = Math.max(1, Math.floor(n / 150000));
  const hf = [];
  for (let i = 0; i < n; i += nstep) if (valid[i]) hf.push(Math.abs(dens[i] - lightBlur[i]));
  hf.sort((a, b) => a - b);
  const noise0 = 1.4826 * hf[hf.length >> 1];
  const nk = clamp(noise0 / 0.025, 1, 5);
  dens = gaussBlur(dens, w, h, p.denoise * scale * nk);
  // denoised but not sharpened density: honest measure of how faint a mark really is
  const dens0 = new Uint8Array(n);
  for (let i = 0; i < n; i++) dens0[i] = clamp(Math.round(dens[i] * 255), 0, 255);
  const deblur = p.deblur / Math.sqrt(nk);
  if (deblur > 0) {
    const bl = gaussBlur(dens, w, h, p.deblurSigma * scale * Math.min(1.6, Math.sqrt(nk)));
    for (let i = 0; i < n; i++) dens[i] += deblur * (dens[i] - bl[i]);
  }

  // 4. paper statistics: median + MAD on a subsample
  const sample = [];
  const step = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += step) if (valid[i]) sample.push(dens[i]);
  sample.sort((a, b) => a - b);
  const med = sample[sample.length >> 1];
  const dev = sample.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  const sigma = Math.max(1e-4, 1.4826 * dev[dev.length >> 1]);
  const tStrong = med + p.strongK * sigma;

  // reference for "full black": high percentile of ink density
  const inkVals = [];
  for (let i = 0; i < n; i += step) if (valid[i] && dens[i] > tStrong) inkVals.push(dens[i]);
  inkVals.sort((a, b) => a - b);
  const dRefRaw = inkVals.length ? inkVals[Math.min(inkVals.length - 1, Math.floor(inkVals.length * p.inkRef))] - med : 0.3;

  // 5. hysteresis-style gate: weak pixels survive only near strong ink
  const strong = new Float32Array(n);
  for (let i = 0; i < n; i++) strong[i] = dens[i] > tStrong ? 1 : 0;
  const near = gaussBlur(maxFilter(strong, w, h, Math.round(p.gateRadius * scale * 0.5)), w, h, p.gateRadius * scale * 0.35);
  // pre-bake the gate into a 0..1 factor so shaping is a single cheap pass
  for (let i = 0; i < n; i++) near[i] = Math.min(1, near[i] * 1.6);

  // quantise chroma to 8 bit to keep the cached analysis small
  const chroma8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) chroma8[i] = clamp(Math.round(chroma[i] * 255), 0, 255);

  return { w, h, dens, dens0, near, valid, chroma: chroma8, stats: { med, sigma, tStrong, dRefRaw, noise0, noiseK: nk, satFrac: sat / n, paperLuma: 0.3 * paperLevel[0] + 0.55 * paperLevel[1] + 0.15 * paperLevel[2] } };
}

// Stage 2 (cheap, per slider move): pressure curve, gate, line weight.
// Returns { alpha: Float32Array 0..1, w, h, stats }
export function shapeInk(an, opts = {}) {
  const p = { ...DEFAULTS, ...opts };
  const { w, h, dens, dens0, near, valid, chroma } = an;
  const n = w * h;
  const { med, sigma, dRefRaw } = an.stats;
  const t0 = med + p.floorK * sigma;
  const dRef = Math.max(dRefRaw, p.inkMin);
  const span = Math.max(1e-4, dRef - (t0 - med));
  const wg = p.weight !== 0 ? Math.pow(2, -p.weight * 1.2) : 1;
  const alpha = new Float32Array(n);
  const gA = 1 - p.gate, gB = p.gate;
  const isoAdd = p.isoFloor * dRef;           // extra floor for marks not attached to strong ink
  const supp = p.ruleSuppress;                // 0..1 strength of coloured-ruling removal
  const cLo = 0.2, cHi = 0.6;               // colour-ness ramp (chroma / density)
  const dLo = 0.26, dHi = 0.46;               // only faint marks (raw density) count as ruling
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const d = dens[i] - med;
    const nr = near[i];
    let a = (dens[i] - t0 - (1 - nr) * isoAdd) / span;
    if (a <= 0) continue;
    a = Math.pow(a > 1.6 ? 1.6 : a, p.gamma);
    a *= gA + gB * nr;
    if (supp > 0 && d > 0) {
      const d0 = dens0[i] / 255;
      const col = (chroma[i] / 255) / (d0 + 0.04);
      if (col > cLo) {
        const cs = col >= cHi ? 1 : (col - cLo) / (cHi - cLo);
        const fs = d0 <= dLo ? 1 : d0 >= dHi ? 0 : 1 - (d0 - dLo) / (dHi - dLo);
        a *= 1 - supp * cs * fs;
      }
    }
    if (a > 1) a = 1;
    alpha[i] = wg !== 1 ? Math.pow(a, wg) : a;
  }
  return { alpha, w, h, stats: { ...an.stats, t0, dRef } };
}

export function extractInk(page, opts = {}) {
  return shapeInk(analyzeInk(page, opts), opts);
}

// "Photo mode": flat-fielded grayscale (shadows removed, tones kept) for pages with
// diagrams, shading or anything that should not be turned into pure ink.
export function renderPhotoGray(an) {
  const { dens, valid, w, h } = an;
  const n = w * h;
  const floor = an.stats.med + 2.0 * an.stats.sigma;
  const out = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    const d = dens[i] - floor;
    if (d <= 0) continue;
    const r = 1 - (d > 1 ? 1 : d);
    out[i] = Math.round(255 * Math.pow(r, 1 / 2.2));
  }
  return out;
}

// alpha -> 8-bit gray (black ink on white)
export function renderGray(ink) {
  const { alpha, w, h } = ink;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = 255 - Math.round(alpha[i] * 255);
  return { data: out, w, h };
}

// ---------- quality checks ----------
// Cheap sanity metrics on the final alpha, used to warn before upload.
export function pageQuality(ink, an) {
  const { alpha, w, h } = ink;
  const n = w * h;
  let inkPx = 0;
  for (let i = 0; i < n; i += 7) if (alpha[i] > 0.35) inkPx++;
  const inkFrac = inkPx / (n / 7);
  // ink touching the trimmed border suggests clipped writing
  const edge = 40;
  let edgeInk = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if ((x < edge || x >= w - edge || y < edge || y >= h - edge) && alpha[y * w + x] > 0.35) edgeInk++;
  }
  // signal-to-noise: dark strokes vs paper noise
  const snr = (an.stats.dRefRaw) / an.stats.sigma;
  return {
    inkFrac,
    blank: inkFrac < 0.0008,
    clippedEdge: edgeInk > 150,
    lowContrast: snr < 8,
    veryNoisy: an.stats.noiseK > 3,
    tooDark: an.stats.paperLuma < 70,
    glare: an.stats.satFrac > 0.02 && an.stats.satFrac < 0.6,
    overexposed: an.stats.satFrac >= 0.6,
    snr,
  };
}
