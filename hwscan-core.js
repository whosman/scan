/* hwscan-core.js - on-device port of hwscan2.py (same algorithm, same constants).
 * Needs OpenCV.js 4.10 (core, imgproc). No network, no other libraries.
 * Usage: const core = HWScan.create(cv, model); const r = core.processRGBA(width, height, rgbaBytes, opts);
 * r = { page: Uint8Array gray (paper-fit), width, height, info }.
 * Licence: MIT. */
(function (root) {
  'use strict';
  const PAPER = { letter: [8.5, 11.0], a4: [8.27, 11.69] };
  const PAPER_RATIOS = [11 / 8.5, 297 / 210];
  const WORK = 480, NLINES = 22, NLINES_HOUGH = 22, TOPK = 60;
  const WEIGHTS_DEFAULT = [0.9519, -0.2815, -1.5712, 2.4994, 0.4418, 0.1595, -0.5782, 1.0066, -5.0674, 1.2009, -1.0813];  // fitted on SmartDoc + synthetic suite

  function create(cv, model, weights) {
    const W8 = weights || WEIGHTS_DEFAULT;

    // ---------------- small numeric helpers (numpy semantics) ----------------
    function kth(a, k) { // quickselect on a Float64Array copy (in place), returns the k-th smallest value
      let lo = 0, hi = a.length - 1;
      while (lo < hi) {
        const pv = a[(lo + hi) >> 1]; let i = lo, j = hi;
        while (i <= j) { while (a[i] < pv) i++; while (a[j] > pv) j--; if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; } }
        if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
      }
      return a[k];
    }
    function percentile(arr, p) { // numpy default 'linear' interpolation, O(n)
      const n = arr.length; if (!n) return NaN;
      const a = Float64Array.from(arr), pos = (n - 1) * p / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
      const vlo = kth(a, lo); if (hi === lo) return vlo;
      let vhi = Infinity; for (let i = lo + 1; i < n; i++) if (a[i] < vhi) vhi = a[i]; // after select, a[lo+1..] >= a[lo]
      return vlo + (vhi - vlo) * (pos - lo);
    }
    function median(arr) { return percentile(arr, 50); }
    function histMedian(hist, total) { // median of integer values given a histogram (numpy: mean of the two middle values)
      if (!total) return NaN;
      const k1 = Math.floor((total - 1) / 2), k2 = Math.floor(total / 2);
      let c = 0, v1 = -1, v2 = -1;
      for (let v = 0; v < hist.length; v++) {
        const nc = c + hist[v];
        if (v1 < 0 && k1 < nc) v1 = v;
        if (v2 < 0 && k2 < nc) { v2 = v; break; }
        c = nc;
      }
      return (v1 + v2) / 2;
    }
    function clip(x, a, b) { return x < a ? a : x > b ? b : x; }
    function matF32(rows, cols, data) { const m = new cv.Mat(rows, cols, cv.CV_32F); if (data) m.data32F.set(data); return m; }
    function matU8(rows, cols, data) { const m = new cv.Mat(rows, cols, cv.CV_8U); if (data) m.data.set(data); return m; }
    function del(...ms) { for (const m of ms) if (m && !m.isDeleted()) m.delete(); }
    function ellipse(k) { return cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)); }
    function rect(w, h) { return cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(w, h)); }
    function bilinear(data, W, H, x, y) { // cv2.remap INTER_LINEAR with BORDER_CONSTANT 0
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const x1 = x0 + 1, y1 = y0 + 1, xa = x0 >= 0 && x0 < W, xb = x1 >= 0 && x1 < W, ya = y0 >= 0 && y0 < H, yb = y1 >= 0 && y1 < H;
      const a = xa && ya ? data[y0 * W + x0] : 0, b = xb && ya ? data[y0 * W + x1] : 0, c = xa && yb ? data[y1 * W + x0] : 0, d = xb && yb ? data[y1 * W + x1] : 0;
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    function resizeArea(src, w, h) { const d = new cv.Mat(); cv.resize(src, d, new cv.Size(w, h), 0, 0, cv.INTER_AREA); return d; }

    // ---------------- 2. page detection ----------------
    function edges(small) { // Di Zenzo colour gradient on noise-normalised Lab channels
      const H = small.rows, W = small.cols, N = H * W;
      const lab8 = new cv.Mat(); cv.cvtColor(small, lab8, cv.COLOR_RGB2Lab);
      const labf = new cv.Mat(); lab8.convertTo(labf, cv.CV_32F);
      const labb = new cv.Mat(); cv.GaussianBlur(labf, labb, new cv.Size(0, 0), 1.0, 1.0, cv.BORDER_DEFAULT);
      const ch = new cv.MatVector(); cv.split(labb, ch);
      const jxx = new Float32Array(N), jyy = new Float32Array(N), jxy = new Float32Array(N);
      const gx = new cv.Mat(), gy = new cv.Mat();
      for (let c = 0; c < 3; c++) {
        const m = ch.get(c);
        cv.Sobel(m, gx, cv.CV_32F, 1, 0, 3); cv.Sobel(m, gy, cv.CV_32F, 0, 1, 3);
        const X = gx.data32F, Y = gy.data32F, hyp = new Float32Array(N);
        for (let i = 0; i < N; i++) hyp[i] = Math.sqrt(X[i] * X[i] + Y[i] * Y[i]);
        const noise = median(hyp) + 1e-3;
        for (let i = 0; i < N; i++) { const a = X[i] / noise, b = Y[i] / noise; jxx[i] += a * a; jyy[i] += b * b; jxy[i] += a * b; }
        m.delete();
      }
      const mag = new Float32Array(N), theta = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const tr = jxx[i] + jyy[i], det = jxx[i] * jyy[i] - jxy[i] * jxy[i];
        const lam = tr / 2 + Math.sqrt(Math.max(tr * tr / 4 - det, 0));
        mag[i] = Math.sqrt(lam); theta[i] = 0.5 * Math.atan2(2 * jxy[i], jxx[i] - jyy[i]);
      }
      del(lab8, labf, labb, gx, gy); ch.delete();
      return { mag, theta };
    }
    function nms(mag, theta, W, H) {
      const out = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, dx = Math.cos(theta[i]), dy = Math.sin(theta[i]);
        const m1 = bilinear(mag, W, H, x + dx, y + dy), m2 = bilinear(mag, W, H, x - dx, y - dy);
        out[i] = (mag[i] >= m1 && mag[i] >= m2) ? mag[i] : 0;
      }
      return out;
    }
    function houghLines(bin, n, H, W) {
      const out = [], L = new cv.Mat(), thr = Math.floor(0.12 * Math.min(H, W));
      cv.HoughLines(bin, L, 1, Math.PI / 360, thr, 0, 0, 0, Math.PI);
      const LD = L.data32F;
      for (let i = 0; i < L.rows; i++) {
        const r = LD[2 * i], t = LD[2 * i + 1];
        if (out.every(([r2, t2]) => Math.abs(r - r2) > 6 || Math.abs(t - t2) > 3 * Math.PI / 180)) out.push([r, t]);
        if (out.length >= n) break;
      }
      L.delete(); return out;
    }
    function mergeLines(lines, n) {
      const out = [];
      for (const [r, t] of lines) {
        let dup = false;
        for (const [r2, t2] of out) {
          let dt = Math.abs(t - t2), dr = Math.abs(r - r2);
          if (dt > Math.PI / 2) { dt = Math.PI - dt; dr = Math.abs(r + r2); }
          if (dt < 2.5 * Math.PI / 180 && dr < 4) { dup = true; break; }
        }
        if (!dup) out.push([r, t]);
        if (out.length >= n) break;
      }
      return out;
    }
    function intersect([r1, t1], [r2, t2]) {
      const a = Math.cos(t1), b = Math.sin(t1), c = Math.cos(t2), d = Math.sin(t2), det = a * d - b * c;
      if (Math.abs(det) < 1e-6) return null;
      return [(r1 * d - b * r2) / det, (a * r2 - c * r1) / det];
    }
    function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
    function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    function aspectRatio(q, W, H, f) { // Zhang & He single-view rectangle geometry; q = tl,tr,br,bl
      const u0 = W / 2, v0 = H / 2;
      const m1 = [q[0][0], q[0][1], 1], m2 = [q[1][0], q[1][1], 1], m4 = [q[2][0], q[2][1], 1], m3 = [q[3][0], q[3][1], 1];
      const k2 = dot3(cross3(m1, m4), m3) / dot3(cross3(m2, m4), m3);
      const k3 = dot3(cross3(m1, m4), m2) / dot3(cross3(m3, m4), m2);
      const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
      const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
      if (!f) {
        f = null;
        if (Math.abs(n2[2]) > 1e-9 && Math.abs(n3[2]) > 1e-9) {
          const f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0)
            + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / (n2[2] * n3[2]);
          f = f2 > 0 ? Math.sqrt(f2) : null;
        }
        const M = Math.max(W, H);
        if (f === null || !(0.3 * M < f && f < 5 * M)) f = 0.8 * M;
      }
      const ai = v => [(v[0] - u0 * v[2]) / f, (v[1] - v0 * v[2]) / f, v[2]]; // A^-1 v
      const a2 = ai(n2), a3 = ai(n3), w2 = dot3(a2, a2), h2 = dot3(a3, a3);
      if (w2 <= 0 || h2 <= 0) return null;
      const r = Math.sqrt(w2 / h2);
      return { ratio: Math.max(r, 1 / r), wide: r >= 1 };
    }
    function sideSamples(a, b, step) {
      const n = Math.max(2, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / (step || 2.0))), pts = [];
      for (let i = 0; i < n; i++) { const t = n === 1 ? 0 : i / (n - 1); pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
      return pts;
    }
    function support(pts, edge, H, W) { // returns [mean over visible, visible fraction]
      let s = 0, n = 0;
      for (const [px, py] of pts) {
        const x = Math.round(px), y = Math.round(py); // np.round: half to even; negligible difference
        if (x >= 2 && y >= 2 && x < W - 2 && y < H - 2) { s += edge[y * W + x]; n++; }
      }
      return [n ? s / n : NaN, n / pts.length];
    }
    function fillQuad(H, W, q, scale, c) {
      const m = cv.Mat.zeros(H, W, cv.CV_8U);
      const pts = []; for (const p of q) pts.push(Math.trunc((p[0] - c[0]) * scale + c[0]), Math.trunc((p[1] - c[1]) * scale + c[1]));
      const mv = new cv.MatVector(), pm = cv.matFromArray(4, 1, cv.CV_32SC2, pts);
      mv.push_back(pm); cv.fillPoly(m, mv, new cv.Scalar(1)); pm.delete(); mv.delete();
      return m;
    }
    function chi2(smallData, q, H, W) {
      const c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
      const mi = fillQuad(H, W, q, 0.88, c), mq = fillQuad(H, W, q, 1.0, c), mo = fillQuad(H, W, q, 1.12, c);
      const h1 = new Float64Array(512), h2 = new Float64Array(512); let n1 = 0, n2 = 0;
      const MQ = mq.data, MI = mi.data, MO = mo.data;
      // only the bounding box of the outer band can contribute
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (const p of q) { const ox = (p[0] - c[0]) * 1.12 + c[0], oy = (p[1] - c[1]) * 1.12 + c[1];
        x0 = Math.min(x0, ox); y0 = Math.min(y0, oy); x1 = Math.max(x1, ox); y1 = Math.max(y1, oy); }
      x0 = Math.max(0, Math.floor(x0) - 1); y0 = Math.max(0, Math.floor(y0) - 1); x1 = Math.min(W - 1, Math.ceil(x1) + 1); y1 = Math.min(H - 1, Math.ceil(y1) + 1);
      for (let yy = y0; yy <= y1; yy++) for (let i = yy * W + x0, e = yy * W + x1; i <= e; i++) {
        const inQ = MQ[i] === 1;
        let tgt = null;
        if (inQ && MI[i] === 0) { tgt = h1; n1++; } else if (!inQ && MO[i] === 1) { tgt = h2; n2++; }
        if (tgt) { const r = smallData[3 * i] >> 5, g = smallData[3 * i + 1] >> 5, b = smallData[3 * i + 2] >> 5; tgt[(r * 8 + g) * 8 + b]++; }
      }
      del(mi, mq, mo);
      if (n1 < 50 || n2 < 50) return 0;
      let s = 0;
      for (let k = 0; k < 512; k++) { const a = h1[k] / n1, b = h2[k] / n2, t = a + b; if (t > 0) s += (a - b) * (a - b) / t; }
      return 0.5 * s;
    }
    function fisher(lab, q, H, W) { // Fisher colour separation of the bands inside / outside the quad, 0..1
      const c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
      const mi = fillQuad(H, W, q, 0.88, c), mq = fillQuad(H, W, q, 1.0, c), mo = fillQuad(H, W, q, 1.12, c);
      const MQ = mq.data, MI = mi.data, MO = mo.data;
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      for (const p of q) { const ox = (p[0] - c[0]) * 1.12 + c[0], oy = (p[1] - c[1]) * 1.12 + c[1];
        x0 = Math.min(x0, ox); y0 = Math.min(y0, oy); x1 = Math.max(x1, ox); y1 = Math.max(y1, oy); }
      x0 = Math.max(0, Math.floor(x0) - 1); y0 = Math.max(0, Math.floor(y0) - 1); x1 = Math.min(W - 1, Math.ceil(x1) + 1); y1 = Math.min(H - 1, Math.ceil(y1) + 1);
      const sa = [0, 0, 0], qa = [0, 0, 0], sb = [0, 0, 0], qb = [0, 0, 0]; let na = 0, nb = 0;
      for (let yy = y0; yy <= y1; yy++) for (let i = yy * W + x0, e = yy * W + x1; i <= e; i++) {
        const inQ = MQ[i] === 1;
        if (inQ && MI[i] === 0) { na++; for (let k = 0; k < 3; k++) { const v = lab[3 * i + k]; sa[k] += v; qa[k] += v * v; } }
        else if (!inQ && MO[i] === 1) { nb++; for (let k = 0; k < 3; k++) { const v = lab[3 * i + k]; sb[k] += v; qb[k] += v * v; } }
      }
      del(mi, mq, mo);
      if (na < 50 || nb < 50) return 0;
      let d2 = 0;
      for (let k = 0; k < 3; k++) {
        const ma = sa[k] / na, mb = sb[k] / nb, va = qa[k] / na - ma * ma, vb = qb[k] / nb - mb * mb;
        d2 += (ma - mb) * (ma - mb) / (va + vb + 4.0);
      }
      const d = Math.sqrt(d2); return d / (1 + d);
    }
    function order4(pts) {
      let iS = 0, aS = 0, iD = 0, aD = 0;
      const s = pts.map(p => p[0] + p[1]), d = pts.map(p => p[1] - p[0]);
      for (let i = 1; i < 4; i++) { if (s[i] < s[iS]) iS = i; if (s[i] > s[aS]) aS = i; if (d[i] < d[iD]) iD = i; if (d[i] > d[aD]) aD = i; }
      return [pts[iS], pts[iD], pts[aS], pts[aD]];
    }
    function regionQuads(lab, H, W) { // same as detect7._region_quads: paper-like regions on 4 maps
      const N = H * W, L = new Float32Array(N), ch = new Float32Array(N);
      for (let i = 0; i < N; i++) { L[i] = lab[3 * i]; ch[i] = Math.hypot(lab[3 * i + 1] - 128, lab[3 * i + 2] - 128); }
      const Lm = matF32(H, W, L), Lb = new cv.Mat(), sg = Math.max(H, W) / 6;
      cv.GaussianBlur(Lm, Lb, new cv.Size(0, 0), sg, sg, cv.BORDER_DEFAULT);
      const LB = Lb.data32F.slice(); del(Lm, Lb);
      const maps = [L, new Float32Array(N), new Float32Array(N), new Float32Array(N)];
      for (let i = 0; i < N; i++) { maps[1][i] = L[i] / (LB[i] + 1); maps[2][i] = L[i] - 2 * ch[i]; maps[3][i] = -ch[i]; }
      const out = [], k5 = rect(5, 5), anchor = new cv.Point(-1, -1), bv = cv.morphologyDefaultBorderValue();
      for (const m of maps) {
        const mm = matF32(H, W, m), mb = new cv.Mat(); cv.GaussianBlur(mm, mb, new cv.Size(0, 0), 2, 2, cv.BORDER_DEFAULT); mm.delete();
        const B = mb.data32F; let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < N; i++) { if (B[i] < lo) lo = B[i]; if (B[i] > hi) hi = B[i]; }
        const u8 = new Uint8Array(N), sc = hi > lo ? 255 / (hi - lo) : 0;
        for (let i = 0; i < N; i++) u8[i] = Math.trunc((B[i] - lo) * sc);
        mb.delete();
        const m8 = matU8(H, W, u8), bin = new cv.Mat(); cv.threshold(m8, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); m8.delete();
        const op = new cv.Mat(), cl = new cv.Mat();
        cv.morphologyEx(bin, op, cv.MORPH_OPEN, k5, anchor, 2, cv.BORDER_CONSTANT, bv);
        cv.morphologyEx(op, cl, cv.MORPH_CLOSE, k5, anchor, 3, cv.BORDER_CONSTANT, bv); del(bin, op);
        const { n, S, L: lb } = ccStats(cl); cl.delete();
        const comps = [];
        for (let j = 1; j < n; j++) comps.push([S[5 * j + 4], j]);
        comps.sort((a, b) => b[0] - a[0]);
        for (const [area, j] of comps.slice(0, 2)) {
          if (area <= 0.05 * H * W) continue;
          const one = new Uint8Array(N); for (let i = 0; i < N; i++) one[i] = lb[i] === j ? 1 : 0;
          const om = matU8(H, W, one), cs = new cv.MatVector(), hier = new cv.Mat();
          cv.findContours(om, cs, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE); om.delete(); hier.delete();
          let best = null, ba = -1;
          for (let t = 0; t < cs.size(); t++) { const c = cs.get(t), a = cv.contourArea(c); if (a > ba) { if (best) best.delete(); best = c; ba = a; } else c.delete(); }
          cs.delete();
          if (!best) continue;
          const hull = new cv.Mat(); cv.convexHull(best, hull, false, true);
          const peri = cv.arcLength(hull, true); let quad = null;
          for (const eps of [0.02, 0.03, 0.045, 0.06, 0.08]) {
            const ap = new cv.Mat(); cv.approxPolyDP(hull, ap, eps * peri, true);
            if (ap.rows === 4) { const d = ap.data32S; quad = [[d[0], d[1]], [d[2], d[3]], [d[4], d[5]], [d[6], d[7]]]; ap.delete(); break; }
            ap.delete();
          }
          if (!quad) { const rr = cv.minAreaRect(best); quad = cv.RotatedRect.points(rr).map(p => [p.x, p.y]); }
          del(hull, best);
          out.push(order4(quad));
        }
      }
      k5.delete();
      return out;
    }
    function quadSupport(q, edge, H, W) { // same contour features as line candidates, by sampling
      const sup = [NaN, NaN, NaN, NaN];
      for (let k = 0; k < 4; k++) {
        const P = sideSamples(q[k], q[(k + 1) % 4]);
        let nf = 0; for (const [x, y] of P) if (Math.min(x, y, W - 1 - x, H - 1 - y) < 3) nf++;
        const [m, vf] = support(P, edge, H, W);
        if (!(nf / P.length > 0.8) && vf >= 0.2) sup[k] = m;
      }
      const vals = sup.filter(v => !isNaN(v)), fs = 4 - vals.length;
      const smin = vals.length ? Math.min(...vals) : 0;
      const ct = (vals.length && fs <= 2) ? 0.5 * smin + 0.5 * vals.reduce((a, b) => a + b, 0) / vals.length - 0.12 * fs : -9;
      let ar = 0; for (let k = 0; k < 4; k++) { const p = q[k], r = q[(k + 1) % 4]; ar += p[0] * r[1] - r[0] * p[1]; }
      return { Q: q, contour: ct, smin, sup, fsd: fs, ar: Math.abs(ar) / 2 / (H * W) };
    }
    function lineProfiles(lines, edge, H, W) {
      const D = Math.floor(Math.hypot(H, W)) + 2, L = 2 * D + 1, P = [];
      for (const [r, th] of lines) {
        const p0 = [r * Math.cos(th), r * Math.sin(th)], d = [-Math.sin(th), Math.cos(th)];
        const hit = new Float64Array(L + 1), vis = new Float64Array(L + 1);
        for (let k = 0; k < L; k++) {
          const t = k - D, x = Math.round(p0[0] + d[0] * t), y = Math.round(p0[1] + d[1] * t);
          const v = (x >= 2 && y >= 2 && x < W - 2 && y < H - 2);
          hit[k + 1] = hit[k] + (v ? edge[y * W + x] : 0); vis[k + 1] = vis[k] + (v ? 1 : 0);
        }
        P.push({ p0, d, hit, vis });
      }
      return { P, D };
    }
    function seg(cum, a, b, D) {
      const lo = Math.trunc(clip(Math.min(a, b) + D, 0, 2 * D + 1)), hi = Math.trunc(clip(Math.max(a, b) + D, 0, 2 * D + 1));
      return cum[hi] - cum[lo];
    }

    function candidates(rgb) { // rgb: cv.Mat 8UC3 (RGB)
      const H0 = rgb.rows, W0 = rgb.cols, s = WORK / Math.max(H0, W0);
      const small = new cv.Mat(); cv.resize(rgb, small, new cv.Size(0, 0), s, s, cv.INTER_AREA);
      const H = small.rows, W = small.cols, N = H * W;
      const { mag, theta } = edges(small);
      const thin = nms(mag, theta, W, H);
      const magM = matF32(H, W, mag), loc = new cv.Mat();
      const kb = (Math.floor(W / 8) | 1); cv.blur(magM, loc, new cv.Size(kb, kb));
      const medMag = median(mag) + 1e-3;
      const rel = new Float32Array(N), nz = [];
      const LOC = loc.data32F; for (let i = 0; i < N; i++) { rel[i] = thin[i] / (LOC[i] + medMag); if (rel[i] > 0) nz.push(rel[i]); }
      del(magM, loc);
      const thr = nz.length ? percentile(nz, 80) : 1;
      const soft8 = new Uint8Array(N), horz = new Uint8Array(N), vert = new Uint8Array(N);
      for (let i = 0; i < N; i++) {
        soft8[i] = rel[i] > 0.6 * thr ? 1 : 0;
        if (rel[i] > thr) { if (Math.abs(Math.cos(theta[i])) > 0.7) vert[i] = 255; else horz[i] = 255; }
      }
      const sm = matU8(H, W, soft8), sd = new cv.Mat(), k3 = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(sm, sd, k3); const edge = Float32Array.from(sd.data); del(sm, sd, k3);
      const hM = matU8(H, W, horz), vM = matU8(H, W, vert);
      let hl = mergeLines(houghLines(hM, NLINES_HOUGH, H, W), NLINES), vl = mergeLines(houghLines(vM, NLINES_HOUGH, H, W), NLINES);
      del(hM, vM);
      const nhR = hl.length, nvR = vl.length;
      hl = hl.concat([[0, Math.PI / 2], [H - 1, Math.PI / 2]]); vl = vl.concat([[0, 0], [W - 1, 0]]);
      const PHp = lineProfiles(hl, edge, H, W), PVp = lineProfiles(vl, edge, H, W), D = PHp.D;
      const nh = hl.length, nv = vl.length;
      const X = [], th = [], tv = [];
      for (let i = 0; i < nh; i++) { X.push([]); th.push([]); tv.push([]);
        for (let j = 0; j < nv; j++) {
          const p = intersect(hl[i], vl[j]); X[i].push(p);
          if (p) { const a = PHp.P[i], b = PVp.P[j];
            th[i].push((p[0] - a.p0[0]) * a.d[0] + (p[1] - a.p0[1]) * a.d[1]);
            tv[i].push((p[0] - b.p0[0]) * b.d[0] + (p[1] - b.p0[1]) * b.d[1]); } else { th[i].push(NaN); tv[i].push(NaN); }
        } }
      const cands = [];
      for (let a1 = 0; a1 < nh; a1++) for (let a2 = a1 + 1; a2 < nh; a2++) for (let b1 = 0; b1 < nv; b1++) for (let b2 = b1 + 1; b2 < nv; b2++) {
        let I1 = a1, I2 = a2, J1 = b1, J2 = b2;
        if (!X[I1][J1] || !X[I1][J2] || !X[I2][J1] || !X[I2][J2]) continue;
        if (X[I1][J1][1] + X[I1][J2][1] > X[I2][J1][1] + X[I2][J2][1]) { const t = I1; I1 = I2; I2 = t; }
        if (X[I1][J1][0] + X[I2][J1][0] > X[I1][J2][0] + X[I2][J2][0]) { const t = J1; J1 = J2; J2 = t; }
        const Q = [X[I1][J1], X[I1][J2], X[I2][J2], X[I2][J1]];
        let ar = 0; for (let k = 0; k < 4; k++) { const p = Q[k], r = Q[(k + 1) % 4]; ar += p[0] * r[1] - r[0] * p[1]; }
        ar = Math.abs(ar) / 2 / (H * W);
        let pos = 0, neg = 0, inb = true;
        for (let k = 0; k < 4; k++) {
          const a = Q[k], b = Q[(k + 1) % 4], c = Q[(k + 2) % 4];
          const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
          if (cr > 0) pos++; else if (cr < 0) neg++;
          if (!(a[0] > -0.25 * W && a[0] < 1.25 * W && a[1] > -0.25 * H && a[1] < 1.25 * H)) inb = false;
        }
        const fs = (I1 >= nhR) + (I2 >= nhR) + (J1 >= nvR) + (J2 >= nvR);
        if (!((pos === 4 || neg === 4) && inb && ar > 0.05 && ar < 1.3 && fs <= 2)) continue;
        const sides = [[PHp.P[I1], th[I1][J1], th[I1][J2], I1 >= nhR], [PHp.P[I2], th[I2][J1], th[I2][J2], I2 >= nhR],
                       [PVp.P[J1], tv[I1][J1], tv[I2][J1], J1 >= nvR], [PVp.P[J2], tv[I1][J2], tv[I2][J2], J2 >= nvR]];
        const sup = []; let fsd = 0;
        for (const [P, ta, tb, isf] of sides) {
          const hits = seg(P.hit, ta, tb, D), vis = seg(P.vis, ta, tb, D), len = Math.abs(tb - ta) + 1;
          if (isf || vis / len < 0.2) { sup.push(NaN); fsd++; } else sup.push(hits / Math.max(vis, 1));
        }
        if (fsd > 2) continue;
        const vals = sup.filter(v => !isNaN(v));
        const smin = vals.length ? Math.min(...vals) : Infinity, smean = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : NaN;
        const contour = 0.5 * smin + 0.5 * smean - 0.12 * fsd;
        if (!isFinite(contour)) continue;
        cands.push({ Q, contour, smin, sup, fsd, ar });
      }
      cands.sort((a, b) => b.contour - a.contour);
      const top = cands.filter(c => c.contour >= -1).slice(0, TOPK);  // region candidates are added below
      // features for the top candidates
      const lab8 = new cv.Mat(); cv.cvtColor(small, lab8, cv.COLOR_RGB2Lab);
      const Lc = new Uint8Array(N), chroma = new Float32Array(N);
      const LBD = lab8.data; for (let i = 0; i < N; i++) { Lc[i] = LBD[3 * i]; const ca = LBD[3 * i + 1] - 128, cb = LBD[3 * i + 2] - 128; chroma[i] = Math.sqrt(ca * ca + cb * cb); }
      const LcM = matU8(H, W, Lc), tmp = new cv.Mat();
      const tL = cv.threshold(LcM, tmp, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); del(LcM, tmp);
      const c60 = percentile(chroma, 60) + 4;
      const paperPx = new Uint8Array(N); for (let i = 0; i < N; i++) paperPx[i] = (Lc[i] >= tL && chroma[i] <= c60) ? 1 : 0;
      const labF = new cv.Mat(); lab8.convertTo(labF, cv.CV_32F);
      const labB = new cv.Mat(); cv.GaussianBlur(labF, labB, new cv.Size(0, 0), 1.2, 1.2, cv.BORDER_DEFAULT);
      const LB = labB.data32F.slice(); const LABRAW = lab8.data.slice(); del(lab8, labF);
      for (const rq of regionQuads(LABRAW, H, W)) top.push(quadSupport(rq, edge, H, W)); // copy: wasm heap growth detaches views
      const smallData = small.data.slice();
      const out = [];
      for (const cd of top) {
        const q = cd.Q;
        const over = [];
        for (let k = 0; k < 4; k++) {
          const a = q[k], b = q[(k + 1) % 4], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const d = [(b[0] - a[0]) / (len + 1e-9), (b[1] - a[1]) / (len + 1e-9)], ext = 0.15 * len;
          for (const [p, sg] of [[a, -1], [b, 1]]) {
            const [m, vf] = support(sideSamples([p[0] + sg * d[0] * 4, p[1] + sg * d[1] * 4], [p[0] + sg * d[0] * ext, p[1] + sg * d[1] * ext]), edge, H, W);
            if (vf > 0.5) over.push(m);
          }
        }
        const overshoot = over.length ? over.reduce((x, y) => x + y, 0) / over.length : 0;
        const contrast = fisher(LABRAW, q, H, W);
        const qf = q.map(p => [p[0] / s, p[1] / s]);
        const r = aspectRatio(qf, W0, H0, null);
        let geo = 0;
        if (r && cd.fsd === 0) geo = Math.max(0, 1 - Math.min(...PAPER_RATIOS.map(pr => Math.abs(r.ratio - pr) / pr)) / 0.15);
        const cq = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
        const sc = [];
        for (let k = 0; k < 4; k++) {
          if (isNaN(cd.sup[k])) continue;
          const a = q[k], b = q[(k + 1) % 4], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const d = [(b[0] - a[0]) / (len + 1e-9), (b[1] - a[1]) / (len + 1e-9)];
          let nrm = [-d[1], d[0]];
          if (((a[0] + b[0]) / 2 - cq[0]) * nrm[0] + ((a[1] + b[1]) / 2 - cq[1]) * nrm[1] < 0) nrm = [-nrm[0], -nrm[1]];
          const P = sideSamples([a[0] + (b[0] - a[0]) * 0.1, a[1] + (b[1] - a[1]) * 0.1], [a[0] + (b[0] - a[0]) * 0.9, a[1] + (b[1] - a[1]) * 0.9], 3.0);
          const dists = [];
          for (const p of P) {
            const ix = p[0] - nrm[0] * 3.5, iy = p[1] - nrm[1] * 3.5, ox = p[0] + nrm[0] * 3.5, oy = p[1] + nrm[1] * 3.5;
            if (!(ix >= 1 && iy >= 1 && ix < W - 1 && iy < H - 1 && ox >= 1 && oy >= 1 && ox < W - 1 && oy < H - 1)) continue;
            const i1 = (Math.trunc(iy) * W + Math.trunc(ix)) * 3, i2 = (Math.trunc(oy) * W + Math.trunc(ox)) * 3;
            dists.push(Math.hypot(LB[i1] - LB[i2], LB[i1 + 1] - LB[i2 + 1], LB[i1 + 2] - LB[i2 + 2]));
          }
          if (dists.length < 5) continue;
          sc.push(Math.log1p(median(dists)) / 4);
        }
        const sideMin = sc.length ? Math.min(...sc) : 0, sideMean = sc.length ? sc.reduce((x, y) => x + y, 0) / sc.length : 0;
        const mk = fillQuad(H, W, q, 0.9, cq); let pin = 0, pn = 0;
        const MK = mk.data; for (let i = 0; i < N; i++) if (MK[i]) { pn++; pin += paperPx[i]; } mk.delete();
        const paper = pn ? pin / pn : 0;
        const smv = isFinite(cd.smin) ? cd.smin : 0;
        const f = [cd.contour, smv, overshoot, contrast, geo, paper, cd.fsd, cd.ar, cd.ar > 0.93 ? 1 : 0, sideMin, sideMean];
        out.push({ q: qf, f });
      }
      del(small, labB);
      return out;
    }
    function findPage(rgb) {
      const c = candidates(rgb);
      if (!c.length) return { q: null, how: 'no candidate' };
      let best = 0, bs = -Infinity;
      c.forEach((x, k) => { const v = x.f.reduce((acc, fv, i) => acc + fv * W8[i], 0); if (v > bs) { bs = v; best = k; } });
      const { q, f } = c[best];
      if (f[0] < 0.35 || f[8] || (f[3] < 0.15 && f[0] < 0.8)) return { q: null, how: 'full frame (no paper edge)', f };
      return { q, f, how: `edges ${Math.round(f[0] * 100)}%, contrast ${f[3].toFixed(2)}` };
    }

    // ---------------- 3-4. corner refinement and rectification ----------------
    function fitLineHuber(pts) {
      const m = cv.matFromArray(pts.length, 1, cv.CV_32FC2, pts.flat()), l = new cv.Mat();
      cv.fitLine(m, l, cv.DIST_HUBER, 0, 0.01, 0.01);
      const r = Array.from(l.data32F); del(m, l); return r; // vx, vy, x0, y0
    }
    function refineCorners(gray, q) {
      const H = gray.rows, W = gray.cols;
      const g = new cv.Mat(); cv.GaussianBlur(gray, g, new cv.Size(0, 0), 1.2, 1.2, cv.BORDER_DEFAULT);
      const gf = new cv.Mat(); g.convertTo(gf, cv.CV_32F);
      const gx = new cv.Mat(), gy = new cv.Mat(), mg = new cv.Mat();
      cv.Sobel(gf, gx, cv.CV_32F, 1, 0, 3); cv.Sobel(gf, gy, cv.CV_32F, 0, 1, 3); cv.magnitude(gx, gy, mg);
      const M = mg.data32F.slice(), R = Math.max(3, Math.round(Math.max(H, W) / WORK * 1.5));
      const lines = [];
      for (let i = 0; i < 4; i++) {
        const a = q[i], b = q[(i + 1) % 4], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const d = [(b[0] - a[0]) / (len + 1e-9), (b[1] - a[1]) / (len + 1e-9)], nrm = [-d[1], d[0]];
        const pts = [];
        for (let k = 0; k < 40; k++) {
          const t = 0.08 + (0.92 - 0.08) * k / 39, p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const xs = [], ys = []; let bad = false;
          for (let o = -R; o <= R; o++) { const x = p[0] + o * nrm[0], y = p[1] + o * nrm[1]; xs.push(x); ys.push(y); if (x < 1 || y < 1 || x > W - 2 || y > H - 2) bad = true; }
          if (bad) continue;
          const prof = xs.map((x, j) => bilinear(M, W, H, x, ys[j]));
          let kk = 0; for (let j = 1; j < prof.length; j++) if (prof[j] > prof[kk]) kk = j;
          if (prof[kk] > 2 * median(prof) + 1) pts.push([xs[kk], ys[kk]]);
        }
        if (pts.length >= 8) { const [vx, vy, x0, y0] = fitLineHuber(pts); lines.push([[x0, y0], [vx, vy]]); }
        else lines.push([a, d]);
      }
      del(g, gf, gx, gy, mg);
      const out = [];
      for (let i = 0; i < 4; i++) {
        const [p1, d1] = lines[(i + 3) % 4], [p2, d2] = lines[i];
        const det = d1[0] * (-d2[1]) - (-d2[0]) * d1[1];
        if (Math.abs(det) < 1e-6) { out.push(q[i]); continue; }
        const rx = p2[0] - p1[0], ry = p2[1] - p1[1];
        const t0 = (rx * (-d2[1]) - (-d2[0]) * ry) / det;
        const c = [p1[0] + d1[0] * t0, p1[1] + d1[1] * t0];
        out.push(Math.hypot(c[0] - q[i][0], c[1] - q[i][1]) < 3 * R ? c : q[i]);
      }
      return out;
    }
    function rectify(rgb, q, paper, focal) {
      const H0 = rgb.rows, W0 = rgb.cols, [tl, tr, br, bl] = q, L = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      const wpx = Math.max(L(tr, tl), L(br, bl)), hpx = Math.max(L(bl, tl), L(br, tr));
      const r = aspectRatio(q, W0, H0, focal);
      let used = 'edges', w, h;
      if (r) {
        let ls = r.ratio; const target = PAPER[paper][1] / PAPER[paper][0];
        const list = [target].concat(PAPER_RATIOS.filter(x => Math.abs(x - target) > 1e-3));
        used = 'geometry';
        for (const pr of list) if (Math.abs(ls - pr) / pr < 0.07) { ls = pr; used = 'paper'; break; }
        if (r.wide) { w = Math.trunc(Math.max(wpx, hpx * ls)); h = Math.trunc(w / ls); }
        else { h = Math.trunc(Math.max(hpx, wpx * ls)); w = Math.trunc(h / ls); }
      } else { w = Math.trunc(wpx); h = Math.trunc(hpx); }
      const sp = cv.matFromArray(4, 1, cv.CV_32FC2, [tl, tr, br, bl].flat());
      const dp = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1]);
      const M = cv.getPerspectiveTransform(sp, dp);
      const page = new cv.Mat(); cv.warpPerspective(rgb, page, M, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
      const ones = new cv.Mat(H0, W0, cv.CV_8U, new cv.Scalar(255)), valid = new cv.Mat();
      cv.warpPerspective(ones, valid, M, new cv.Size(w, h), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
      del(sp, dp, M, ones);
      return { page, valid, used };
    }

    // ---------------- 5. cleanup ----------------
    function flatten(gray) { // divide by the paper shade; returns new 8U Mat
      const bg = flattenBg(gray), n = new cv.Mat(); cv.divide(gray, bg, n, 255, -1); bg.delete(); return n;
    }
    function flattenBg(gray) { // paper-shade estimate on a ~500 px copy (same as hwscan2.flatten_bg); returns new 8U Mat, at least 1
      const H = gray.rows, W = gray.cols, f = Math.max(1, Math.round(W / 500));
      let src = gray, own = [];
      if (f > 1) {
        const kr = rect(f, f), dl = new cv.Mat(); cv.dilate(gray, dl, kr); kr.delete();
        src = new cv.Mat(); cv.resize(dl, src, new cv.Size(Math.max(1, Math.trunc(W / f)), Math.max(1, Math.trunc(H / f))), 0, 0, cv.INTER_AREA);
        dl.delete(); own.push(src);
      }
      const k = (Math.trunc(0.02 * W / f) | 1), ke = ellipse(k), bg = new cv.Mat(); cv.morphologyEx(src, bg, cv.MORPH_CLOSE, ke); ke.delete();
      const bm = new cv.Mat(); cv.medianBlur(bg, bm, Math.min(255, Math.trunc(0.01 * W / f) | 1));
      const sg = Math.max(0.5, 0.004 * W / f); let bgs = new cv.Mat(); cv.GaussianBlur(bm, bgs, new cv.Size(0, 0), sg, sg, cv.BORDER_DEFAULT);
      if (f > 1) { const up = new cv.Mat(); cv.resize(bgs, up, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR); bgs.delete(); bgs = up; }
      const one = new cv.Mat(bgs.rows, bgs.cols, cv.CV_8U, new cv.Scalar(1)), bmax = new cv.Mat(); cv.max(bgs, one, bmax);
      del(bg, bm, bgs, one, ...own); return bmax;
    }
    function colourPage(page, bg, n, valid, hi, lo) { // colour version of the clean page (see colour_page in hwscan2.py); RGB in, RGB out
      const lutA = new Uint8Array(256); for (let v = 0; v < 256; v++) lutA[v] = Math.trunc(Math.pow(clip((v - lo) / (hi - lo), 0, 1), 1.2) * 255);
      const lut = matU8(1, 256, lutA), N = n.rows * n.cols, nd = n.data, vd = valid.data, paper = new Uint8Array(N); let np_ = 0;
      for (let i = 0; i < N; i++) if (nd[i] > 200 && vd[i]) { paper[i] = 1; np_++; }
      const medOver = (m) => { const h = new Float64Array(256), d = m.data; for (let i = 0; i < N; i++) if (paper[i]) h[d[i]]++; return histMedian(h, np_); };
      const pg = np_ ? medOver(n) : 250, mv = new cv.MatVector(), outs = new cv.MatVector(); cv.split(page, mv);
      for (let c = 0; c < 3; c++) {
        const ch = mv.get(c), nc = new cv.Mat(); cv.divide(ch, bg, nc, 255, -1);
        const pc = np_ ? medOver(nc) : pg, adj = new cv.Mat(), o = new cv.Mat();
        cv.convertScaleAbs(nc, adj, pg / Math.max(pc, 1)); cv.LUT(adj, lut, o);
        outs.push_back(o); del(ch, nc, adj, o);
      }
      const col = new cv.Mat(); cv.merge(outs, col); del(mv, outs, lut);
      const cd = col.data, vd2 = valid.data; for (let i = 0; i < N; i++) if (!vd2[i]) cd[3 * i] = cd[3 * i + 1] = cd[3 * i + 2] = 255;
      return col;
    }
    function hist8(data, mask) { const h = new Float64Array(256); for (let i = 0; i < data.length; i++) if (!mask || mask[i]) h[data[i]]++; return h; }
    function tone(n, bleed) { // in place on 8U Mat n -> returns levels
      const d = n.data, hAll = hist8(d);
      const hp = new Float64Array(256); let np_ = 0; for (let v = 201; v < 256; v++) { hp[v] = hAll[v]; np_ += hAll[v]; }
      let pmed = 250, sigma = 3;
      if (np_) {
        pmed = histMedian(hp, np_);
        const devs = new Map(); // |v - pmed| values are multiples of 0.5
        const hd = new Float64Array(512);
        for (let v = 201; v < 256; v++) if (hp[v]) hd[Math.round(Math.abs(v - pmed) * 2)] += hp[v];
        sigma = 1.4826 * histMedian(hd, np_) / 2;
      }
      const margin = { low: 10, normal: 20, high: 30 }[bleed || 'normal'];
      const hi = clip(pmed - Math.max(margin, 4 * sigma), 180, 248);
      const hi_ink = hi - 25; let ni = 0; const hi2 = new Float64Array(256);
      for (let v = 0; v < 256; v++) if (v < hi_ink) { hi2[v] = hAll[v]; ni += hAll[v]; }
      const inkMed = ni > 500 ? histMedian(hi2, ni) : 100;
      const lo = clip(inkMed + 10, 40, Math.min(150, hi - 60));
      const lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) lut[v] = Math.trunc(Math.pow(clip((v - lo) / (hi - lo), 0, 1), 1.2) * 255);
      for (let i = 0; i < d.length; i++) d[i] = lut[d[i]];
      return { white: Math.round(hi), black: Math.round(lo) };
    }
    function ccStats(binMat) {
      const lab = new cv.Mat(), st = new cv.Mat(), ce = new cv.Mat();
      const n = cv.connectedComponentsWithStats(binMat, lab, st, ce, 8, cv.CV_32S);
      const S = st.data32S.slice(), L = lab.data32S.slice(); del(lab, st, ce);
      return { n, S, L }; // S row: x, y, w, h, area
    }
    function despeckle(g, dpi) {
      const N = g.rows * g.cols, d = g.data, ink = new Uint8Array(N);
      for (let i = 0; i < N; i++) ink[i] = d[i] < 160 ? 1 : 0;
      const im = matU8(g.rows, g.cols, ink), { n, S, L } = ccStats(im); im.delete();
      const maxA = Math.trunc(40 * (dpi / 300) ** 2), small = new Uint8Array(n);
      for (let j = 1; j < n; j++) small[j] = S[5 * j + 4] <= maxA ? 1 : 0;
      const big = new Uint8Array(N); for (let i = 0; i < N; i++) big[i] = (ink[i] && !small[L[i]]) ? 1 : 0;
      const r = Math.trunc(8 * dpi / 300), bm = matU8(g.rows, g.cols, big), near = new cv.Mat(), ke = ellipse(2 * r + 1);
      cv.dilate(bm, near, ke); del(bm, ke);
      const keep = new Uint8Array(n);
      const ND = near.data; for (let i = 0; i < N; i++) if (ND[i] && small[L[i]]) keep[L[i]] = 1;
      near.delete();
      let killed = 0; for (let j = 1; j < n; j++) if (small[j] && !keep[j]) killed++;
      const d2 = g.data; // re-acquire: allocations above may have moved the wasm heap
      for (let i = 0; i < N; i++) if (small[L[i]] && !keep[L[i]]) d2[i] = 255;
      return killed;
    }
    function clearBorder(g, frac) {
      const H = g.rows, W = g.cols, d = g.data, m = Math.trunc(frac * Math.max(H, W));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (y < m || y >= H - m || x < m || x >= W - m) d[y * W + x] = 255;
      const band = Math.trunc(0.025 * Math.max(H, W)), b = new Uint8Array(H * W);
      for (let i = 0; i < H * W; i++) b[i] = d[i] < 200 ? 1 : 0;
      const bm = matU8(H, W, b), { n, S, L } = ccStats(bm); bm.delete();
      const kill = new Uint8Array(n);
      for (let j = 1; j < n; j++) {
        const x = S[5 * j], y = S[5 * j + 1], w = S[5 * j + 2], h = S[5 * j + 3];
        const hz = w > 0.1 * W && h < 0.012 * H && (y + h < band || y > H - band);
        const vt = h > 0.1 * H && w < 0.012 * W && (x + w < band || x > W - band);
        if (hz || vt) kill[j] = 1;
      }
      const d2 = g.data;
      for (let i = 0; i < H * W; i++) if (kill[L[i]]) d2[i] = 255;
    }

    // ---------------- 6. orientation and skew ----------------
    const ROT = { 0: null, 90: cv.ROTATE_90_CLOCKWISE, 180: cv.ROTATE_180, 270: cv.ROTATE_90_COUNTERCLOCKWISE };
    function rot(m, a) { const o = new cv.Mat(); if (ROT[a] === null) m.copyTo(o); else cv.rotate(m, o, ROT[a]); return o; }
    function sumMat(m) { let s = 0; const d = m.data; for (let i = 0; i < d.length; i++) s += d[i]; return s; }
    function horizScore(ink) {
      const k = Math.max(15, Math.trunc(ink.cols / 60)), a = new cv.Mat(), b = new cv.Mat(), kh = rect(k, 1), kv = rect(1, k);
      cv.morphologyEx(ink, a, cv.MORPH_OPEN, kh); cv.morphologyEx(ink, b, cv.MORPH_OPEN, kv);
      const r = (sumMat(a) + 1) / (sumMat(b) + 1); del(a, b, kh, kv); return r;
    }
    function uprightScore(ink) {
      const H = ink.rows, W = ink.cols, d = ink.data; let sy = 0, c = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[y * W + x]) { sy += y; c++; }
      if (c < 200) return 0;
      const top = 0.5 - sy / c / H;
      const ke = rect(Math.max(3, Math.trunc(W / 25)), 3), li = new cv.Mat(); cv.dilate(ink, li, ke); ke.delete();
      const { n, S } = ccStats(li); li.delete();
      const rows = []; for (let j = 1; j < n; j++) if (S[5 * j + 4] > 50) rows.push([S[5 * j], S[5 * j + 2]]);
      let left = 0;
      if (rows.length >= 3) {
        let a = 0, b = 0; for (const [x, w] of rows) { a += 1 - (x + w) / W; b += x / W; }
        left = a / rows.length - b / rows.length;
      }
      return top + 0.3 * left;
    }
    const PH = 32, PW = 96;
    function linePatches(ink, maxP) { // ink: 8U Mat, 255 = ink
      maxP = maxP || 400;
      const H = ink.rows, W = ink.cols, d = ink.data, bin = new Uint8Array(H * W);
      for (let i = 0; i < H * W; i++) bin[i] = d[i] > 110 ? 1 : 0;
      const bm = matU8(H, W, bin), c1 = ccStats(bm);
      const hs = []; for (let j = 1; j < c1.n; j++) if (c1.S[5 * j + 4] > 6 && c1.S[5 * j + 3] > 3) hs.push(c1.S[5 * j + 3]);
      if (hs.length < 5) { bm.delete(); return []; }
      const h = median(hs);
      const ke = rect(Math.max(3, Math.trunc(2.0 * h)), Math.max(1, Math.trunc(0.25 * h))), bl = new cv.Mat(); cv.dilate(bm, bl, ke); del(bm, ke);
      const c2 = ccStats(bl); bl.delete();
      const out = [];
      for (let j = 1; j < c2.n; j++) {
        const x = c2.S[5 * j], y = c2.S[5 * j + 1], w = c2.S[5 * j + 2], hh = c2.S[5 * j + 3];
        if (w < 2.5 * hh || hh < 0.8 * h || hh > 6 * h) continue;
        const roi = ink.roi(new cv.Rect(x, y, w, hh)), s = PH / hh, cw = Math.max(PW, Math.trunc(w * s));
        const cr = resizeArea(roi, cw, PH); roi.delete();
        const CRD = cr.data;
        for (let x0 = 0; x0 + PW <= cw; x0 += PW / 2) {
          const p = new Uint8Array(PH * PW); let cnt = 0;
          for (let yy = 0; yy < PH; yy++) for (let xx = 0; xx < PW; xx++) { const v = CRD[yy * cw + x0 + xx]; p[yy * PW + xx] = v; if (v > 110) cnt++; }
          if (cnt / (PH * PW) > 0.04) out.push(p);
        }
        cr.delete();
      }
      if (out.length > maxP) { const r = []; for (let i = 0; i < maxP; i++) r.push(out[Math.trunc(i * (out.length - 1) / (maxP - 1))]); return r; }
      return out;
    }
    function hog(p) { // identical to orient_model.features
      const cells = new Float64Array(432);
      for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) {
        const gx = (x > 0 && x < PW - 1) ? p[y * PW + x + 1] - p[y * PW + x - 1] : 0;
        const gy = (y > 0 && y < PH - 1) ? p[(y + 1) * PW + x] - p[(y - 1) * PW + x] : 0;
        const mg = Math.sqrt(gx * gx + gy * gy); if (mg === 0) { continue; }
        let a = Math.atan2(gy, gx); a = ((a % Math.PI) + Math.PI) % Math.PI; a = a / Math.PI * 9 - 0.5;
        let b0 = Math.floor(a); const w1 = a - b0; const b1 = ((b0 + 1) % 9 + 9) % 9; b0 = ((b0 % 9) + 9) % 9;
        const base = ((y >> 3) * 12 + (x >> 3)) * 9;
        cells[base + b0] += mg * (1 - w1); cells[base + b1] += mg * w1;
      }
      const f = new Float32Array(1188); let o = 0;
      for (let by = 0; by < 3; by++) for (let bx = 0; bx < 11; bx++) {
        const blk = new Float64Array(36);
        const parts = [[by, bx], [by, bx + 1], [by + 1, bx], [by + 1, bx + 1]];
        parts.forEach(([cy, cx], k) => { for (let b = 0; b < 9; b++) blk[k * 9 + b] = cells[(cy * 12 + cx) * 9 + b]; });
        let s = 0; for (let i = 0; i < 36; i++) s += blk[i] * blk[i]; s = Math.sqrt(s) + 1e-3;
        for (let i = 0; i < 36; i++) blk[i] = Math.min(blk[i] / s, 0.2);
        s = 0; for (let i = 0; i < 36; i++) s += blk[i] * blk[i]; s = Math.sqrt(s) + 1e-3;
        for (let i = 0; i < 36; i++) f[o++] = blk[i] / s;
      }
      return f;
    }
    function updownLogodds(ink) {
      if (!model) return [0, 0];
      const P = linePatches(ink); let sum = 0;
      const nh = model.b1.length, W1 = model.W1, z = new Float32Array(1188), a = new Float64Array(nh);
      for (const p of P) {
        const f = hog(p);
        for (let i = 0; i < 1188; i++) z[i] = (f[i] - model.mu[i]) / model.sd[i];
        a.set(model.b1);
        for (let i = 0; i < 1188; i++) { const zi = z[i]; if (zi === 0) continue; const row = i * nh; for (let h = 0; h < nh; h++) a[h] += zi * W1[row + h]; }
        let out = model.b2; for (let h = 0; h < nh; h++) if (a[h] > 0) out += a[h] * model.W2[h];
        sum += clip(out, -4, 4);
      }
      return [sum, P.length];
    }
    const ORIENT_W = [10.1532, 0.6510, 17.0498, 0.2722, 0.7958, 2.0949, 3.2146]; // fit_orient.py
    function marginLine(ink) { // long vertical rule near the left (+) or right (-) edge
      const H = ink.rows, W = ink.cols, kv = rect(1, Math.trunc(H / 3)), v = new cv.Mat();
      cv.morphologyEx(ink, v, cv.MORPH_OPEN, kv); kv.delete();
      const D = v.data, col = new Float32Array(W);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) col[x] += D[y * W + x];
      v.delete();
      let l = 0, r = 0; const q = Math.trunc(W / 4);
      for (let x = 0; x < q; x++) l = Math.max(l, col[x] / H);
      for (let x = W - q; x < W; x++) r = Math.max(r, col[x] / H);
      return l - r;
    }
    function orientFeatures(g, a) {
      const sw = 600, sh = Math.round(g.rows * 600 / g.cols);
      const sm = new cv.Mat(); cv.resize(g, sm, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
      const i0 = new cv.Mat(); cv.threshold(sm, i0, 127, 1, cv.THRESH_BINARY_INV);
      const s0 = new cv.Mat(); cv.threshold(sm, s0, 214, 1, cv.THRESH_BINARY_INV); sm.delete();  // (small < 215)
      const ink = rot(i0, a), soft = rot(s0, a); del(i0, s0);
      const H = ink.rows, W = ink.cols, d = ink.data; let sy = 0, sx = 0, c = 0, r0 = -1, r1 = -1;
      for (let y = 0; y < H; y++) { let rc = 0; for (let x = 0; x < W; x++) if (d[y * W + x]) { sy += y; sx += x; c++; rc++; }
        if (rc > 2) { if (r0 < 0) r0 = y; r1 = y; } }
      if (c < 50) { del(ink, soft); return [0, 0, 0, 0, 0, 0, 0]; }
      const u = uprightScore(ink), ml = marginLine(soft); del(ink, soft);
      let lo = 0, n = 0;
      if (model) {
        const inv = new cv.Mat(); cv.bitwise_not(g, inv); const r = rot(inv, a); inv.delete();
        const big = resizeArea(r, 1600, Math.trunc(1600 * r.rows / r.cols)); r.delete();
        [lo, n] = updownLogodds(big); big.delete();
      }
      const gap = r0 >= 0 ? (r0 / H - (H - 1 - r1) / H) : 0;
      return [u, 0.5 - sy / c / H, 0.5 - sx / c / W, lo / 400, n ? lo / n : 0, ml, -gap];
    }
    function autoOrient(g, pageFound) {
      const sw = 600, sh = Math.round(g.rows * 600 / g.cols);
      const sm = new cv.Mat(); cv.resize(g, sm, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
      const ink = new cv.Mat(); cv.threshold(sm, ink, 127, 1, cv.THRESH_BINARY_INV); sm.delete();
      const hs = horizScore(ink); ink.delete();
      const portrait = g.rows >= g.cols;
      const base = pageFound ? (portrait ? [0, 180] : [90, 270]) : hs >= 1.3 ? [0, 180] : hs <= 0.77 ? [90, 270] : (portrait ? [0, 180] : [90, 270]);
      const f = orientFeatures(g, base[0]); let score = 0;
      for (let i = 0; i < 7; i++) score += f[i] * ORIENT_W[i];
      return { a: score >= 0 ? base[0] : base[1], conf: Math.abs(score), hs };
    }
    function strokeAngles(g, vertical) {
      const src = vertical ? rot(g, 90) : g;
      const H = src.rows, W = src.cols, b = new Uint8Array(H * W);
      const SD = src.data; for (let i = 0; i < H * W; i++) b[i] = SD[i] < 160 ? 1 : 0;
      if (vertical) src.delete();
      const bm = matU8(H, W, b), { n, S, L } = ccStats(bm); bm.delete();
      const out = [];
      for (let j = 1; j < n; j++) {
        const x = S[5 * j], y = S[5 * j + 1], w = S[5 * j + 2], h = S[5 * j + 3], a = S[5 * j + 4];
        if (w > Math.max(W, H) / 25 && h < 0.2 * w && a < w * Math.max(4, 0.004 * Math.max(W, H))) {
          const pts = [];
          for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (L[yy * W + xx] === j) pts.push([xx - x, yy - y]);
          const [vx, vy] = fitLineHuber(pts);
          out.push([Math.atan2(vy, vx) * 180 / Math.PI, w]);
        }
      }
      return out;
    }
    function wmedian(v) {
      const s = v.slice().sort((p, q) => p[0] - q[0]); const tot = s.reduce((t, x) => t + x[1], 0); let c = 0;
      for (const [a, w] of s) { c += w; if (c >= tot / 2) return a; } return s[s.length - 1][0];
    }
    function skewFromStrokes(g) {
      const hz = strokeAngles(g, false), vt = strokeAngles(g, true);
      if (hz.length < 4) return null;
      const ah = wmedian(hz);
      if (vt.length >= 2) {
        const av = wmedian(vt);
        if (Math.abs(ah - av) <= 1.5) { const a = (ah * hz.length + av * vt.length) / (hz.length + vt.length); return Math.abs(a) >= 1.5 ? a : null; }
      }
      return hz.length >= 6 && Math.abs(ah) >= 3.5 ? ah : null;
    }
    function rotateSmall(g, deg) {
      const M = cv.getRotationMatrix2D(new cv.Point(g.cols / 2, g.rows / 2), deg, 1), o = new cv.Mat();
      cv.warpAffine(g, o, M, new cv.Size(g.cols, g.rows), cv.INTER_CUBIC, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255)); M.delete(); return o;
    }

    // ---------------- 7. quality ----------------
    function quality(pageGray, glare, dpiEff, frameSides) {
      const warn = [];
      if (dpiEff < 90) warn.push('The photo is too small to read well. Move the phone closer.');
      const g = resizeArea(pageGray, 800, Math.trunc(800 * pageGray.rows / pageGray.cols));
      const lap = new cv.Mat(); cv.Laplacian(g, lap, cv.CV_32F, 1, 1, 0, cv.BORDER_DEFAULT);
      const thr = percentile(g.data, 3); const N = g.rows * g.cols, ink = new Uint8Array(N); let ni = 0;
      const GD = g.data; for (let i = 0; i < N; i++) if (GD[i] < thr) { ink[i] = 1; ni++; }
      if (ni / N > 0.001) {
        const im = matU8(g.rows, g.cols, ink), dl = new cv.Mat(), k5 = cv.Mat.ones(5, 5, cv.CV_8U); cv.dilate(im, dl, k5);
        const v = [], DLD = dl.data, LPD = lap.data32F; for (let i = 0; i < N; i++) if (DLD[i]) v.push(Math.abs(LPD[i]));
        del(im, dl, k5);
        if (percentile(v, 90) < 12) warn.push('The photo is blurry. Hold still and tap the screen to focus.');
      }
      del(g, lap);
      if (glare > 0.03) warn.push('There is glare on the page. Tilt the phone or move the light.');
      if (frameSides) warn.push('Part of the page is cut off. Keep all four corners in view.');
      return warn;
    }

    // ---------------- 8. driver ----------------
    function fitToPaper(g, paper, dpi) {
      const Wp = Math.trunc(PAPER[paper][0] * dpi), Hp = Math.trunc(PAPER[paper][1] * dpi), m = Math.trunc(0.25 * dpi);
      const s = Math.min((Wp - 2 * m) / g.cols, (Hp - 2 * m) / g.rows);
      const w = Math.round(g.cols * s), h = Math.round(g.rows * s), r = new cv.Mat();
      cv.resize(g, r, new cv.Size(w, h), 0, 0, s < 1 ? cv.INTER_AREA : cv.INTER_CUBIC);
      const page = new cv.Mat(Hp, Wp, g.type(), new cv.Scalar(255, 255, 255, 255));
      const y = Math.trunc((Hp - h) / 2), x = Math.trunc((Wp - w) / 2), roi = page.roi(new cv.Rect(x, y, w, h));
      r.copyTo(roi); del(roi, r); return page;
    }
    function process(rgb, opts) { // rgb: 8UC3 RGB Mat; returns { page: 8U Mat (caller deletes), clean: 8U Mat, info }
      opts = Object.assign({ paper: 'letter', dpi: 300, bleed: 'normal', rotate: null, autorotate: true, focal: null }, opts || {});
      const info = { warn: [] }, dpi = opts.dpi;
      const fp = opts.quad ? { q: opts.quad.map(p => [p[0], p[1]]), how: 'manual' } : findPage(rgb); let q = fp.q, frameSides = 0, page, valid;
      if (q) {
        if (!opts.quad) { const g0 = new cv.Mat(); cv.cvtColor(rgb, g0, cv.COLOR_RGB2GRAY); q = refineCorners(g0, q); g0.delete(); }
        const H0 = rgb.rows, W0 = rgb.cols;
        frameSides = q.some(c => Math.min(c[0], c[1], W0 - 1 - c[0], H0 - 1 - c[1]) < -2) ? 1 : 0;
        const r = rectify(rgb, q, opts.paper, opts.focal); page = r.page; valid = r.valid;
        info.page = `${fp.how}; aspect from ${r.used}`; info.quad = q;
      } else {
        page = rgb.clone(); valid = new cv.Mat(rgb.rows, rgb.cols, cv.CV_8U, new cv.Scalar(255)); info.page = fp.how;
        { const g0 = new cv.Mat(); cv.cvtColor(rgb, g0, cv.COLOR_RGB2GRAY); const G = g0.data, H0 = g0.rows, W0 = g0.cols, b = Math.max(2, Math.trunc(0.03 * Math.max(H0, W0)));
          const ring = []; for (let y = 0; y < H0; y++) for (let x = 0; x < W0; x++) if (y < b || y >= H0 - b || x < b || x >= W0 - b) ring.push(G[y * W0 + x]);
          g0.delete(); if (median(ring) < 200) info.warn.push('The page edges are hard to see. Use a darker table and keep all four corners in view.'); }
      }
      let gray = new cv.Mat(); cv.cvtColor(page, gray, cv.COLOR_RGB2GRAY); if (!opts.color) page.delete();
      const N0 = gray.rows * gray.cols; let nv = 0; const gvv = [];
      const VD = valid.data, GRD = gray.data; for (let i = 0; i < N0; i++) if (VD[i]) { nv++; }
      const hv = new Float64Array(256); for (let i = 0; i < N0; i++) if (VD[i] || nv === 0) hv[GRD[i]]++;
      const tot = nv || N0; let c = 0, p60 = 255; for (let v = 0; v < 256; v++) { c += hv[v]; if (c >= 0.6 * tot) { p60 = v; break; } }
      let sat = 0; for (let v = 250; v < 256; v++) sat += hv[v];
      const glare = p60 < 238 ? sat / tot : 0;
      const longIn = PAPER[opts.paper][1], dpiEff = Math.max(gray.rows, gray.cols) / longIn;
      const n0 = flatten(gray);
      { const hp = new Float64Array(256); let np_ = 0; const N0D = n0.data; for (let i = 0; i < N0D.length; i++) { const v = N0D[i]; if (v > 200) { hp[v]++; np_++; } }
        let sigma = 0;
        if (np_) { const pm = histMedian(hp, np_), hd = new Float64Array(512); for (let v = 201; v < 256; v++) if (hp[v]) hd[Math.round(Math.abs(v - pm) * 2)] += hp[v]; sigma = 1.4826 * histMedian(hd, np_) / 2; }
        if (sigma > 3.0) { const d = new cv.Mat(); cv.bilateralFilter(gray, d, 5, Math.min(60, 3 * sigma), 3, cv.BORDER_DEFAULT); gray.delete(); gray = d; info.denoise = Math.round(sigma * 10) / 10; } }
      n0.delete();
      const s = (longIn * dpi) / Math.max(gray.rows, gray.cols);
      if (Math.abs(s - 1) > 0.05) {
        const w = Math.round(gray.cols * s), h = Math.round(gray.rows * s);
        const g2 = new cv.Mat(); cv.resize(gray, g2, new cv.Size(w, h), 0, 0, s < 1 ? cv.INTER_AREA : cv.INTER_CUBIC); gray.delete(); gray = g2;
        if (opts.color) { const p2 = new cv.Mat(); cv.resize(page, p2, new cv.Size(w, h), 0, 0, s < 1 ? cv.INTER_AREA : cv.INTER_CUBIC); page.delete(); page = p2; }
        const v2 = new cv.Mat(); cv.resize(valid, v2, new cv.Size(w, h), 0, 0, cv.INTER_NEAREST); valid.delete(); valid = v2;
      }
      const bg = flattenBg(gray), n = new cv.Mat(); cv.divide(gray, bg, n, 255, -1); gray.delete();
      const g = n.clone(); Object.assign(info, tone(g, opts.bleed));
      { const GD2 = g.data, VD2 = valid.data; for (let i = 0; i < GD2.length; i++) if (!VD2[i]) GD2[i] = 255; }
      const gPre = opts.color ? g.data.slice() : null;
      clearBorder(g, q ? 0.005 : 0.003);
      info.specks = despeckle(g, dpi);
      let col = null;
      if (opts.color) { col = colourPage(page, bg, n, valid, info.white, info.black); page.delete(); const CD = col.data, GD3 = g.data;
        for (let i = 0; i < GD3.length; i++) if (GD3[i] === 255 && gPre[i] !== 255) CD[3 * i] = CD[3 * i + 1] = CD[3 * i + 2] = 255; }
      valid.delete(); bg.delete();
      let a = 0;
      if (opts.rotate !== null && opts.rotate !== undefined) { a = opts.rotate; info.orient = `${a} (forced)`; }
      else if (!opts.autorotate) { info.orient = 'off'; }
      else { const o = autoOrient(g, !!q); a = o.a; info.orient = `${a} (conf ${o.conf.toFixed(3)}, h/v ${o.hs.toFixed(2)})`; info.orientConf = o.conf;
        if (o.conf < 1.0) info.warn.push('We could not tell which way is up. Please check this page.'); }
      info.rotation = a;
      let gr = rot(g, a); g.delete();
      let cr = col ? rot(col, a) : null; if (col) col.delete();
      if (!q) { const sk = skewFromStrokes(gr); if (sk !== null && Math.abs(sk) <= 15) { const t = rotateSmall(gr, sk); gr.delete(); gr = t; info.skew = Math.round(sk * 100) / 100;
        if (cr) { const t2 = rotateSmall(cr, sk); cr.delete(); cr = t2; } } }
      const nr = rot(n, a); n.delete();
      info.warn.push(...quality(nr, glare, dpiEff, frameSides)); nr.delete();
      if (opts.fit === false) return { page: null, clean: gr, colorPage: null, colorClean: cr, info }; // the caller lays the page out itself
      const out = fitToPaper(gr, opts.paper, dpi);
      if (cr) { const outC = fitToPaper(cr, opts.paper, dpi); return { page: out, clean: gr, colorPage: outC, colorClean: cr, info }; }
      return { page: out, clean: gr, info };
    }
    function processRGBA(width, height, rgba, opts) {
      const m = new cv.Mat(height, width, cv.CV_8UC4); m.data.set(rgba);
      const rgb = new cv.Mat(); cv.cvtColor(m, rgb, cv.COLOR_RGBA2RGB); m.delete();
      const r = process(rgb, opts); rgb.delete(); return r;
    }

    return { _internal: { percentile, median, histMedian, clip, matF32, matU8, del, ellipse, rect, bilinear, resizeArea, aspectRatio, order4, fisher },
             candidates, findPage, refineCorners, rectify, flatten, tone, despeckle, clearBorder, autoOrient, orientFeatures, linePatches, hog, updownLogodds, skewFromStrokes, process, processRGBA, PAPER, PAPER_RATIOS, WORK };
  }

  const api = { create, PAPER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HWScan = api;
})(typeof self !== 'undefined' ? self : this);
