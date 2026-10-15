// Hot loops of the cleaning pipeline, compiled to WebAssembly (scalar; iOS 12 has no SIMD).
// A line-for-line port of the JavaScript in core.js. The app checks the two against each other
// before it trusts this, and times both on the phone to pick the faster.
// All arguments are byte offsets into one shared linear memory that JavaScript owns.

@inline function f32at(p: i32, i: i32): f32 { return load<f32>(p + (i << 2)); }
@inline function f32put(p: i32, i: i32, v: f32): void { store<f32>(p + (i << 2), v); }

// Pass 1 over the photo: one linear-light brightness plane (16 bit) and a colour-ness sum per 2x2 cell.
export function prepass(src: i32, sw: i32, sh: i32, p16: i32, chromaS: i32, lin: i32,
  cR: f32, cG: f32, cB: f32, iR: f32, iG: f32, iB: f32, counts: i32): void {
  const sw2: i32 = (sw + 1) >> 1;
  const SC: f32 = 40000.0;
  let sat: i32 = 0, satN: i32 = 0;
  for (let y: i32 = 0; y < sh; y++) {
    let o: i32 = src + y * sw * 4;
    const row: i32 = y * sw, coarse: bool = (y & 3) == 0, crow: i32 = (y >> 1) * sw2;
    for (let x: i32 = 0; x < sw; x++, o += 4) {
      const r: i32 = load<u8>(o), g: i32 = load<u8>(o + 1), bl: i32 = load<u8>(o + 2);
      const lr: f32 = f32at(lin, r), lg: f32 = f32at(lin, g), lb: f32 = f32at(lin, bl);
      let l: f32 = (cR * lr + cG * lg + cB * lb) * SC;
      if (l > 65535.0) l = 65535.0;
      store<u16>(p16 + ((row + x) << 1), <u16>l);
      const rr: f32 = lr * iR, gg: f32 = lg * iG, bb: f32 = lb * iB;
      const mx: f32 = rr > gg ? (rr > bb ? rr : bb) : (gg > bb ? gg : bb);
      const mn: f32 = rr < gg ? (rr < bb ? rr : bb) : (gg < bb ? gg : bb);
      const ci: i32 = crow + (x >> 1);
      f32put(chromaS, ci, f32at(chromaS, ci) + (mx - mn));
      if (coarse && (x & 3) == 0) { satN++; if (r > 252 && g > 252 && bl > 252) sat++; }
    }
  }
  store<i32>(counts, sat);
  store<i32>(counts + 4, satN);
}

// Pass 2: straighten. Exact source position every 8 pixels, linear in between.
export function warp(p16: i32, sw: i32, sh: i32, L: i32, W: i32, H: i32,
  h0: f64, h1: f64, h2: f64, h3: f64, h4: f64, h5: f64, h6: f64, h7: f64,
  chromaS: i32, sw2: i32, sh2: i32, chromaF: i32, cw: i32): void {
  const maxX: f64 = <f64>sw - 1.001, maxY: f64 = <f64>sh - 1.001;
  const invSC: f32 = 1.0 / 40000.0;
  const NODE: i32 = 8;
  for (let y: i32 = 0; y < H; y++) {
    const py: f64 = <f64>y + 0.5;
    const hy1: f64 = h1 * py + h2, hy4: f64 = h4 * py + h5, hy7: f64 = h7 * py + 1.0;
    const row: i32 = y * W, coarseRow: bool = (y & 3) == 0, crow: i32 = (y >> 2) * cw;
    let x1n: i32 = 0;
    let dsx: f64 = 0.0, dsy: f64 = 0.0, sxc: f64 = 0.0, syc: f64 = 0.0;
    for (let x: i32 = 0; x < W; x++) {
      if (x == x1n) {
        x1n = x + NODE < W ? x + NODE : W;
        const pxA: f64 = <f64>x + 0.5, dnA: f64 = h6 * pxA + hy7, pxB: f64 = <f64>x1n + 0.5, dnB: f64 = h6 * pxB + hy7;
        sxc = (h0 * pxA + hy1) / dnA - 0.5; syc = (h3 * pxA + hy4) / dnA - 0.5;
        const sxB: f64 = (h0 * pxB + hy1) / dnB - 0.5, syB: f64 = (h3 * pxB + hy4) / dnB - 0.5, span: f64 = <f64>(x1n - x);
        dsx = (sxB - sxc) / span; dsy = (syB - syc) / span;
      }
      let sx: f64 = sxc, sy: f64 = syc;
      sxc += dsx; syc += dsy;
      sx = sx < 0.0 ? 0.0 : (sx > maxX ? maxX : sx);
      sy = sy < 0.0 ? 0.0 : (sy > maxY ? maxY : sy);
      const x0: i32 = <i32>sx, y0: i32 = <i32>sy;
      const fx: f64 = sx - <f64>x0, fy: f64 = sy - <f64>y0;
      const i: i32 = y0 * sw + x0;
      const a: f64 = <f64>load<u16>(p16 + (i << 1)), b: f64 = <f64>load<u16>(p16 + ((i + 1) << 1));
      const c: f64 = <f64>load<u16>(p16 + ((i + sw) << 1)), d: f64 = <f64>load<u16>(p16 + ((i + sw + 1) << 1));
      const t: f64 = a + (b - a) * fx;
      f32put(L, row + x, <f32>((t + ((c + (d - c) * fx) - t) * fy) * <f64>invSC));
      if (coarseRow && (x & 3) == 0) {
        let cu: f64 = (sx - 0.5) * 0.5, cv: f64 = (sy - 0.5) * 0.5;
        if (cu < 0.0) cu = 0.0; if (cv < 0.0) cv = 0.0;
        if (cu > <f64>sw2 - 1.001) cu = <f64>sw2 - 1.001; if (cv > <f64>sh2 - 1.001) cv = <f64>sh2 - 1.001;
        const iu: i32 = <i32>cu, iv: i32 = <i32>cv; const fu: f64 = cu - <f64>iu, fv: f64 = cv - <f64>iv; const ci: i32 = iv * sw2 + iu;
        const q00: f64 = <f64>f32at(chromaS, ci), q01: f64 = <f64>f32at(chromaS, ci + 1), q10: f64 = <f64>f32at(chromaS, ci + sw2), q11: f64 = <f64>f32at(chromaS, ci + sw2 + 1);
        const c0: f64 = q00 + (q01 - q00) * fu, c1: f64 = q10 + (q11 - q10) * fu;
        f32put(chromaF, crow + (x >> 2), <f32>((c0 + (c1 - c0) * fv) * 0.25));
      }
    }
  }
}

// 88th percentile of each BSxBS block (every 2nd sample), by keeping the K largest.
export function paperGrid(L: i32, W: i32, H: i32, BS: i32, grid: i32, top: i32, gw: i32, gh: i32): void {
  for (let gy: i32 = 0; gy < gh; gy++) {
    const y0: i32 = gy * BS; const y1: i32 = y0 + BS < H ? y0 + BS : H;
    for (let gx: i32 = 0; gx < gw; gx++) {
      const x0: i32 = gx * BS; const x1: i32 = x0 + BS < W ? x0 + BS : W;
      let k: i32 = 0;
      for (let y: i32 = y0; y < y1; y += 2) for (let x: i32 = x0; x < x1; x += 2) k++;
      let K: i32 = k - <i32>Math.floor(0.88 * <f64>(k - 1)); if (K < 1) K = 1;
      for (let i: i32 = 0; i < K; i++) f32put(top, i, -9.0);
      for (let y: i32 = y0; y < y1; y += 2) {
        const o: i32 = y * W;
        for (let x: i32 = x0; x < x1; x += 2) {
          const v: f32 = f32at(L, o + x);
          if (v > f32at(top, 0)) {
            let j: i32 = 0;
            while (j + 1 < K && f32at(top, j + 1) < v) { f32put(top, j, f32at(top, j + 1)); j++; }
            f32put(top, j, v);
          }
        }
      }
      f32put(grid, gy * gw + gx, f32at(top, 0));
    }
  }
}

// density = 1 - light / paper, in place. scratch holds xa (i32[W]), tx (f32[W]), rowInv (f32[gw]).
export function density(L: i32, W: i32, H: i32, g2: i32, gw: i32, gh: i32, BS: i32, xa: i32, tx: i32, rowInv: i32): void {
  const bs: f64 = <f64>BS;
  for (let x: i32 = 0; x < W; x++) {
    let f: f64 = (<f64>x + 0.5) / bs - 0.5; if (f < 0.0) f = 0.0; if (f > <f64>(gw - 1)) f = <f64>(gw - 1);
    let a: i32 = <i32>Math.floor(f); const lim: i32 = gw - 2 < 0 ? 0 : gw - 2; if (a > lim) a = lim;
    store<i32>(xa + (x << 2), a); f32put(tx, x, <f32>(f - <f64>a));
  }
  for (let y: i32 = 0; y < H; y++) {
    let f: f64 = (<f64>y + 0.5) / bs - 0.5; if (f < 0.0) f = 0.0; if (f > <f64>(gh - 1)) f = <f64>(gh - 1);
    const ya: i32 = <i32>Math.floor(f); const yb: i32 = ya + 1 < gh - 1 ? ya + 1 : gh - 1; const ty: f32 = <f32>(f - <f64>ya);
    for (let gx: i32 = 0; gx < gw; gx++) {
      const pv: f32 = f32at(g2, ya * gw + gx) * (1.0 - ty) + f32at(g2, yb * gw + gx) * ty;
      f32put(rowInv, gx, 1.0 / (pv > 0.02 ? pv : 0.02));
    }
    const row: i32 = y * W;
    for (let x: i32 = 0; x < W; x++) {
      const a: i32 = load<i32>(xa + (x << 2)); const t2: f32 = f32at(tx, x);
      const a1: i32 = a + 1 > gw - 1 ? gw - 1 : a + 1;
      const ip: f32 = f32at(rowInv, a) * (1.0 - t2) + f32at(rowInv, a1) * t2;
      f32put(L, row + x, 1.0 - f32at(L, row + x) * ip);
    }
  }
}

// Laplacian noise histogram on a sparse sample. Returns the sample count.
export function noiseHist(L: i32, W: i32, H: i32, hist: i32): i32 {
  let n: i32 = 0;
  for (let y: i32 = 1; y < H - 1; y += 3) {
    const o: i32 = y * W;
    for (let x: i32 = 1; x < W - 1; x += 3) {
      const i: i32 = o + x;
      let v: f32 = f32at(L, i) - 0.25 * (f32at(L, i - 1) + f32at(L, i + 1) + f32at(L, i - W) + f32at(L, i + W));
      if (v < 0.0) v = -v;
      let b: i32 = <i32>(v * 4000.0); if (b > 1199) b = 1199;
      store<u32>(hist + (b << 2), load<u32>(hist + (b << 2)) + 1);
      n++;
    }
  }
  return n;
}

// Box blur passes (running sums). Radius < 1 does nothing. `a` is blurred in place; `tmp` is scratch; `col` is f32[w].
function blurH(src: i32, dst: i32, w: i32, h: i32, r: i32): void {
  const win: i32 = 2 * r + 1; const rp1: i32 = r + 1; const inv: f32 = 1.0 / <f32>win;
  for (let y: i32 = 0; y < h; y++) {
    const o: i32 = y * w; const last: f32 = f32at(src, o + w - 1), first: f32 = f32at(src, o);
    let acc: f32 = first * <f32>rp1;
    for (let i: i32 = 1; i <= r; i++) acc += f32at(src, o + (i < w ? i : w - 1));
    let x: i32 = 0;
    const lim1: i32 = r < w ? r : w;
    for (; x < lim1; x++) { f32put(dst, o + x, acc * inv); acc += (x + r + 1 < w ? f32at(src, o + x + r + 1) : last) - first; }
    const lim2: i32 = w - r - 1;
    for (; x < lim2; x++) { f32put(dst, o + x, acc * inv); acc += f32at(src, o + x + r + 1) - f32at(src, o + x - r); }
    for (; x < w; x++) { f32put(dst, o + x, acc * inv); acc += last - f32at(src, o + x - r); }
  }
}
function blurV(src: i32, dst: i32, w: i32, h: i32, r: i32, col: i32): void {
  const win: i32 = 2 * r + 1; const rp1: i32 = r + 1; const inv: f32 = 1.0 / <f32>win;
  for (let x: i32 = 0; x < w; x++) f32put(col, x, f32at(src, x) * <f32>rp1);
  for (let i: i32 = 1; i <= r; i++) { const o: i32 = (i < h ? i : h - 1) * w; for (let x: i32 = 0; x < w; x++) f32put(col, x, f32at(col, x) + f32at(src, o + x)); }
  for (let y: i32 = 0; y < h; y++) {
    const o: i32 = y * w, a: i32 = (y + r + 1 < h ? y + r + 1 : h - 1) * w, s: i32 = (y - r >= 0 ? y - r : 0) * w;
    for (let x: i32 = 0; x < w; x++) { f32put(dst, o + x, f32at(col, x) * inv); f32put(col, x, f32at(col, x) + f32at(src, a + x) - f32at(src, s + x)); }
  }
}
export function boxCascade(a: i32, tmp: i32, w: i32, h: i32, r0: i32, r1: i32, r2: i32, col: i32): void {
  if (r0 >= 1) { blurH(a, tmp, w, h, r0); blurV(tmp, a, w, h, r0, col); }
  if (r1 >= 1) { blurH(a, tmp, w, h, r1); blurV(tmp, a, w, h, r1, col); }
  if (r2 >= 1) { blurH(a, tmp, w, h, r2); blurV(tmp, a, w, h, r2, col); }
}
// separable 3-tap gaussian for sigma below one pixel: centre weight c, side weight sd
export function blur3(a: i32, tmp: i32, w: i32, h: i32, c: f32, sd: f32): void {
  for (let y: i32 = 0; y < h; y++) {
    const o: i32 = y * w;
    f32put(tmp, o, f32at(a, o) * (c + sd) + f32at(a, o + 1) * sd);
    for (let x: i32 = 1; x < w - 1; x++) f32put(tmp, o + x, f32at(a, o + x - 1) * sd + f32at(a, o + x) * c + f32at(a, o + x + 1) * sd);
    f32put(tmp, o + w - 1, f32at(a, o + w - 1) * (c + sd) + f32at(a, o + w - 2) * sd);
  }
  for (let x: i32 = 0; x < w; x++) f32put(a, x, f32at(tmp, x) * (c + sd) + f32at(tmp, w + x) * sd);
  for (let y: i32 = 1; y < h - 1; y++) { const o: i32 = y * w; for (let x: i32 = 0; x < w; x++) f32put(a, o + x, f32at(tmp, o - w + x) * sd + f32at(tmp, o + x) * c + f32at(tmp, o + w + x) * sd); }
  const l: i32 = (h - 1) * w; for (let x: i32 = 0; x < w; x++) f32put(a, l + x, f32at(tmp, l + x) * (c + sd) + f32at(tmp, l - w + x) * sd);
}

// dens0 (8 bit, un-sharpened) and, when sharpening, a copy of L into tmp
export function dens0Copy(L: i32, tmp: i32, dens0: i32, n: i32, doDeblur: i32): void {
  for (let i: i32 = 0; i < n; i++) {
    const v: f32 = f32at(L, i); const q: i32 = <i32>(v * 255.0 + 0.5);
    store<u8>(dens0 + i, q < 0 ? 0 : (q > 255 ? 255 : q));
    if (doDeblur != 0) f32put(tmp, i, v);
  }
}
// one pass: sharpen (L += deb * (L - blurred)), keep the float, store the 16 bit copy
export function combine(L: i32, tmp: i32, densQ: i32, n: i32, deb: f32, doDeblur: i32): void {
  for (let i: i32 = 0; i < n; i++) {
    let v: f32 = f32at(L, i);
    if (doDeblur != 0) { v += deb * (v - f32at(tmp, i)); f32put(L, i, v); }
    let f: f32 = v * 4096.0; if (f > 32767.0) f = 32767.0; else if (f < -32767.0) f = -32767.0;
    store<i16>(densQ + (i << 1), <i16>f);
  }
}

// statistics histogram over the valid area, every 3rd pixel. Returns the sample count.
export function statsHist(L: i32, W: i32, H: i32, edge: i32, hist: i32, NB: i32, LO: f32, RES: f32): i32 {
  let total: i32 = 0;
  for (let y: i32 = edge; y < H - edge; y += 3) {
    const o: i32 = y * W;
    for (let x: i32 = edge; x < W - edge; x += 3) {
      let b: i32 = <i32>((f32at(L, o + x) - LO) * RES);
      if (b < 0) b = 0; else if (b >= NB) b = NB - 1;
      store<u32>(hist + (b << 2), load<u32>(hist + (b << 2)) + 1);
      total++;
    }
  }
  return total;
}

// where is there strong ink? 1/4 resolution grid; every other pixel is enough
export function gateMax(L: i32, W: i32, H: i32, cm: i32, strongC: i32, gcw: i32, tStrong: f32): void {
  for (let y: i32 = 0; y < H; y++) {
    if ((y & 3) == 0) for (let c: i32 = 0; c < gcw; c++) f32put(cm, c, -9.0);
    if ((y & 1) == 0) {
      const o: i32 = y * W;
      for (let x: i32 = 0; x < W; x += 2) { const v: f32 = f32at(L, o + x); const c: i32 = x >> 2; if (v > f32at(cm, c)) f32put(cm, c, v); }
    }
    if ((y & 3) == 3 || y == H - 1) {
      const base: i32 = (y >> 2) * gcw;
      for (let c: i32 = 0; c < gcw; c++) f32put(strongC, base + c, f32at(cm, c) > tStrong ? 1.0 : 0.0);
    }
  }
}
