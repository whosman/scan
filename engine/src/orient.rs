// Which way is up, and whether the photo is blurry. Orientation combines the page layout (writing starts at the top left, margins on the
// left) with a small learned model that reads text-line patches (HOG features into a one-hidden-layer network, trained on open fonts).

use crate::util::*;

pub struct Model { pub mu: Vec<f32>, pub sd: Vec<f32>, pub w1: Vec<f32>, pub b1: Vec<f32>, pub w2: Vec<f32>, pub b2: f32, pub nh: usize }

const PH: usize = 32; const PW: usize = 96;
const ORIENT_W: [f32; 7] = [10.1532, 0.6510, 17.0498, 0.2722, 0.7958, 2.0949, 3.2146];

pub fn resize_area_gray(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let sx = sw as f32 / dw as f32; let sy = sh as f32 / dh as f32;
    let mut tmp = vec![0.0f32; dw * sh];
    for x in 0..dw {
        let a = x as f32 * sx; let b = (x + 1) as f32 * sx; let i0 = a.floor() as usize; let i1 = ((b.ceil() as usize).min(sw)).max(i0 + 1);
        let mut ws = 0.0f32; let mut ws_v: Vec<f32> = Vec::with_capacity(i1 - i0);
        for i in i0..i1 { let w = (((i + 1) as f32).min(b) - (i as f32).max(a)).max(0.0); ws += w; ws_v.push(w); }
        let inv = 1.0 / ws.max(1e-6);
        for y in 0..sh { let row = &src[y * sw..(y + 1) * sw]; let mut s = 0.0f32; for (k, i) in (i0..i1).enumerate() { s += row[i] as f32 * ws_v[k]; } tmp[y * dw + x] = s * inv; }
    }
    let mut out = vec![0u8; dw * dh];
    for y in 0..dh {
        let a = y as f32 * sy; let b = (y + 1) as f32 * sy; let i0 = a.floor() as usize; let i1 = ((b.ceil() as usize).min(sh)).max(i0 + 1);
        let mut acc = vec![0.0f32; dw]; let mut tot = 0.0f32;
        for i in i0..i1 { let w = (((i + 1) as f32).min(b) - (i as f32).max(a)).max(0.0); tot += w; for x in 0..dw { acc[x] += tmp[i * dw + x] * w; } }
        let inv = 1.0 / tot.max(1e-6); for x in 0..dw { out[y * dw + x] = (acc[x] * inv + 0.5) as u8; }
    }
    out
}

// Area-average resize of the luminance of an RGBA page (so no full-size gray plane is needed). invert: 255 - luminance (ink is bright).
pub fn resize_luma_rgba(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize, invert: bool) -> Vec<u8> {
    let sx = sw as f32 / dw as f32; let sy = sh as f32 / dh as f32;
    let mut xr: Vec<(usize, usize, Vec<f32>)> = Vec::with_capacity(dw);
    for x in 0..dw {
        let a = x as f32 * sx; let b = (x + 1) as f32 * sx; let i0 = a.floor() as usize; let i1 = ((b.ceil() as usize).min(sw)).max(i0 + 1);
        let mut ws: Vec<f32> = (i0..i1).map(|i| (((i + 1) as f32).min(b) - (i as f32).max(a)).max(0.0)).collect();
        let s: f32 = ws.iter().sum::<f32>().max(1e-6); for v in ws.iter_mut() { *v /= s; }
        xr.push((i0, i1, ws));
    }
    let mut tmp = vec![0.0f32; dw * sh];
    for y in 0..sh {
        let row = &src[y * sw * 4..(y + 1) * sw * 4]; let out = &mut tmp[y * dw..(y + 1) * dw];
        for x in 0..dw { let (i0, i1, ws) = &xr[x]; let mut s = 0.0f32;
            for (k, i) in (*i0..*i1).enumerate() { let p = &row[i * 4..i * 4 + 3]; s += ((77 * p[0] as u32 + 151 * p[1] as u32 + 28 * p[2] as u32) >> 8) as f32 * ws[k]; }
            out[x] = s; }
    }
    let mut out = vec![0u8; dw * dh];
    for y in 0..dh {
        let a = y as f32 * sy; let b = (y + 1) as f32 * sy; let i0 = a.floor() as usize; let i1 = ((b.ceil() as usize).min(sh)).max(i0 + 1);
        let mut acc = vec![0.0f32; dw]; let mut tot = 0.0f32;
        for i in i0..i1 { let w = (((i + 1) as f32).min(b) - (i as f32).max(a)).max(0.0); tot += w; let r = &tmp[i * dw..(i + 1) * dw]; for x in 0..dw { acc[x] += r[x] * w; } }
        let inv = 1.0 / tot.max(1e-6);
        for x in 0..dw { let v = (acc[x] * inv + 0.5) as u8; out[y * dw + x] = if invert { 255 - v } else { v }; }
    }
    out
}

pub fn rotate_cw(src: &[u8], w: usize, h: usize, ch: usize, a: u32) -> (Vec<u8>, usize, usize) {
    match a % 360 {
        0 => (src.to_vec(), w, h),
        90 => { let mut o = vec![0u8; w * h * ch]; for y in 0..h { for x in 0..w { let (nx, ny) = (h - 1 - y, x); for c in 0..ch { o[(ny * h + nx) * ch + c] = src[(y * w + x) * ch + c]; } } } (o, h, w) }
        180 => { let mut o = vec![0u8; w * h * ch]; for y in 0..h { for x in 0..w { let (nx, ny) = (w - 1 - x, h - 1 - y); for c in 0..ch { o[(ny * w + nx) * ch + c] = src[(y * w + x) * ch + c]; } } } (o, w, h) }
        _ => { let mut o = vec![0u8; w * h * ch]; for y in 0..h { for x in 0..w { let (nx, ny) = (y, w - 1 - x); for c in 0..ch { o[(ny * h + nx) * ch + c] = src[(y * w + x) * ch + c]; } } } (o, h, w) }
    }
}

// pixels belonging to horizontal (or vertical) runs of at least k ink pixels: a morphological opening with a line
fn open_runs(ink: &[u8], w: usize, h: usize, k: usize, horizontal: bool) -> Vec<u8> {
    let mut out = vec![0u8; w * h];
    let (outer, inner) = if horizontal { (h, w) } else { (w, h) };
    for o in 0..outer {
        let mut run = 0usize;
        for i in 0..=inner {
            let v = if i < inner { let idx = if horizontal { o * w + i } else { i * w + o }; ink[idx] } else { 0 };
            if v != 0 { run += 1; } else { if run >= k { for j in i - run..i { let idx = if horizontal { o * w + j } else { j * w + o }; out[idx] = 1; } } run = 0; }
        }
    }
    out
}

fn horiz_score(ink: &[u8], w: usize, h: usize) -> f32 {
    let k = 15.max(w / 60);
    let a: u32 = open_runs(ink, w, h, k, true).iter().map(|v| *v as u32).sum(); let b: u32 = open_runs(ink, w, h, k, false).iter().map(|v| *v as u32).sum();
    (a as f32 + 1.0) / (b as f32 + 1.0)
}

fn dilate_rect(m: &[u8], w: usize, h: usize, rx: i32, ry: i32) -> Vec<u8> {
    // sliding-window counts: O(pixels), whatever the window
    let mut t = vec![0u8; w * h]; let mut o = vec![0u8; w * h];
    for y in 0..h {
        let row = &m[y * w..(y + 1) * w]; let mut cnt = 0i32;
        for x in 0..=(rx as usize).min(w - 1) { cnt += (row[x] != 0) as i32; }
        for x in 0..w as i32 {
            t[y * w + x as usize] = (cnt > 0) as u8;
            let add = x + rx + 1; if add < w as i32 { cnt += (row[add as usize] != 0) as i32; }
            let sub = x - rx; if sub >= 0 { cnt -= (row[sub as usize] != 0) as i32; }
        }
    }
    for x in 0..w {
        let mut cnt = 0i32;
        for y in 0..=(ry as usize).min(h - 1) { cnt += t[y * w + x] as i32; }
        for y in 0..h as i32 {
            o[y as usize * w + x] = (cnt > 0) as u8;
            let add = y + ry + 1; if add < h as i32 { cnt += t[add as usize * w + x] as i32; }
            let sub = y - ry; if sub >= 0 { cnt -= t[sub as usize * w + x] as i32; }
        }
    }
    o
}
// bounding boxes (x, y, w, h, area) of 8-connected components of a binary mask
fn boxes(m: &[u8], w: usize, h: usize) -> Vec<(u32, u32, u32, u32, u32)> {
    let mut seen = vec![false; w * h]; let mut out = Vec::new(); let mut stack: Vec<usize> = Vec::new();
    for s in 0..w * h {
        if m[s] == 0 || seen[s] { continue; }
        seen[s] = true; stack.push(s); let (mut x0, mut y0, mut x1, mut y1, mut a) = (u32::MAX, u32::MAX, 0u32, 0u32, 0u32);
        while let Some(i) = stack.pop() {
            let (x, y) = ((i % w) as u32, (i / w) as u32); a += 1; x0 = x0.min(x); x1 = x1.max(x); y0 = y0.min(y); y1 = y1.max(y);
            for dy in -1i32..=1 { for dx in -1i32..=1 { if dx == 0 && dy == 0 { continue; }
                let (nx, ny) = (x as i32 + dx, y as i32 + dy); if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 { continue; }
                let j = ny as usize * w + nx as usize; if m[j] != 0 && !seen[j] { seen[j] = true; stack.push(j); } } }
        }
        out.push((x0, y0, x1 - x0 + 1, y1 - y0 + 1, a));
    }
    out
}

fn upright_score(ink: &[u8], w: usize, h: usize) -> f32 {
    let (mut sy, mut c) = (0.0f64, 0u32);
    for y in 0..h { for x in 0..w { if ink[y * w + x] != 0 { sy += y as f64; c += 1; } } }
    if c < 200 { return 0.0; }
    let top = 0.5 - (sy / c as f64) as f32 / h as f32;
    let kw = (w / 25).max(3) as i32;
    let li = dilate_rect(ink, w, h, kw / 2, 1);
    let rows: Vec<(u32, u32)> = boxes(&li, w, h).into_iter().filter(|b| b.4 > 50).map(|b| (b.0, b.2)).collect();
    let mut left = 0.0f32;
    if rows.len() >= 3 {
        let (mut a, mut b) = (0.0f32, 0.0f32);
        for (x, ww) in &rows { a += 1.0 - (*x + *ww) as f32 / w as f32; b += *x as f32 / w as f32; }
        left = a / rows.len() as f32 - b / rows.len() as f32;
    }
    top + 0.3 * left
}

fn margin_line(soft: &[u8], w: usize, h: usize) -> f32 {
    let v = open_runs(soft, w, h, (h / 3).max(1), false);
    let mut col = vec![0.0f32; w];
    for y in 0..h { for x in 0..w { col[x] += v[y * w + x] as f32; } }
    let q = w / 4; let (mut l, mut r) = (0.0f32, 0.0f32);
    for x in 0..q { l = l.max(col[x] / h as f32); } for x in w - q..w { r = r.max(col[x] / h as f32); }
    l - r
}

// atan2 with an error under 0.0002 rad: plenty for 9 orientation bins, and about 5 times faster
#[inline]
fn fast_atan2(y: f32, x: f32) -> f32 {
    let (ax, ay) = (x.abs(), y.abs()); let (mn, mx) = if ax < ay { (ax, ay) } else { (ay, ax) };
    let a = mn / mx.max(1e-20); let s = a * a;
    let mut r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
    if ay > ax { r = core::f32::consts::FRAC_PI_2 - r; }
    if x < 0.0 { r = core::f32::consts::PI - r; }
    if y < 0.0 { r = -r; }
    r
}

fn hog(p: &[u8]) -> Vec<f32> {
    let mut cells = vec![0.0f64; 432];
    for y in 0..PH { for x in 0..PW {
        let gx = if x > 0 && x < PW - 1 { p[y * PW + x + 1] as f32 - p[y * PW + x - 1] as f32 } else { 0.0 };
        let gy = if y > 0 && y < PH - 1 { p[(y + 1) * PW + x] as f32 - p[(y - 1) * PW + x] as f32 } else { 0.0 };
        let mg = (gx * gx + gy * gy).sqrt(); if mg == 0.0 { continue; }
        let mut a = fast_atan2(gy, gx); if a < 0.0 { a += core::f32::consts::PI; } if a >= core::f32::consts::PI { a -= core::f32::consts::PI; } a = a / core::f32::consts::PI * 9.0 - 0.5;
        let b0f = a.floor(); let w1 = a - b0f; let b1 = (((b0f as i32 + 1) % 9 + 9) % 9) as usize; let b0 = (((b0f as i32) % 9 + 9) % 9) as usize;
        let base = ((y >> 3) * 12 + (x >> 3)) * 9;
        cells[base + b0] += (mg * (1.0 - w1)) as f64; cells[base + b1] += (mg * w1) as f64;
    } }
    let mut f = vec![0.0f32; 1188]; let mut o = 0;
    for by in 0..3 { for bx in 0..11 {
        let mut blk = [0.0f64; 36];
        for (k, (cy, cx)) in [(by, bx), (by, bx + 1), (by + 1, bx), (by + 1, bx + 1)].iter().enumerate() { for b in 0..9 { blk[k * 9 + b] = cells[(cy * 12 + cx) * 9 + b]; } }
        let mut s = 0.0; for v in blk.iter() { s += v * v; } s = s.sqrt() + 1e-3;
        for v in blk.iter_mut() { *v = (*v / s).min(0.2); }
        s = 0.0; for v in blk.iter() { s += v * v; } s = s.sqrt() + 1e-3;
        for v in blk.iter() { f[o] = (*v / s) as f32; o += 1; }
    } }
    f
}

fn line_patches(ink: &[u8], w: usize, h: usize, max_p: usize) -> Vec<Vec<u8>> {
    let bin: Vec<u8> = ink.iter().map(|v| if *v > 110 { 1 } else { 0 }).collect();
    let c1 = boxes(&bin, w, h);
    let hs: Vec<f32> = c1.iter().filter(|b| b.4 > 6 && b.3 > 3).map(|b| b.3 as f32).collect();
    if hs.len() < 5 { return vec![]; }
    let hm = median(&hs);
    let bl = dilate_rect(&bin, w, h, ((2.0 * hm) as i32).max(3) / 2, ((0.25 * hm) as i32).max(1) / 2);
    let mut out: Vec<Vec<u8>> = Vec::new();
    for (x, y, ww, hh, _) in boxes(&bl, w, h) {
        let (x, y, ww, hh) = (x as usize, y as usize, ww as usize, hh as usize);
        if (ww as f32) < 2.5 * hh as f32 || (hh as f32) < 0.8 * hm || hh as f32 > 6.0 * hm { continue; }
        let s = PH as f32 / hh as f32; let cw = PW.max((ww as f32 * s) as usize);
        let mut roi = vec![0u8; ww * hh]; for r in 0..hh { roi[r * ww..(r + 1) * ww].copy_from_slice(&ink[(y + r) * w + x..(y + r) * w + x + ww]); }
        let cr = resize_area_gray(&roi, ww, hh, cw, PH);
        let mut x0 = 0;
        while x0 + PW <= cw {
            let mut p = vec![0u8; PH * PW]; let mut cnt = 0;
            for yy in 0..PH { for xx in 0..PW { let v = cr[yy * cw + x0 + xx]; p[yy * PW + xx] = v; if v > 110 { cnt += 1; } } }
            if cnt as f32 / (PH * PW) as f32 > 0.04 { out.push(p); }
            x0 += PW / 2;
        }
    }
    if out.len() > max_p { let n = out.len(); return (0..max_p).map(|i| out[i * (n - 1) / (max_p - 1)].clone()).collect(); }
    out
}

fn updown_logodds(m: &Model, ink: &[u8], w: usize, h: usize, max_p: usize) -> (f32, usize) {
    let patches = line_patches(ink, w, h, max_p); let mut sum = 0.0f32; let nh = m.nh;
    let mut a = vec![0.0f32; nh];
    for p in patches.iter() {
        let f = hog(p);
        a.copy_from_slice(&m.b1);
        for i in 0..1188 { let zi = (f[i] - m.mu[i]) / m.sd[i]; if zi == 0.0 { continue; } let row = &m.w1[i * nh..(i + 1) * nh]; for k in 0..nh { a[k] += zi * row[k]; } }
        let mut out = m.b2; for k in 0..nh { if a[k] > 0.0 { out += a[k] * m.w2[k]; } }
        sum += clampf(out, -4.0, 4.0);
    }
    (sum, patches.len())
}

// ink0 / s0: the page at 600 px wide, as ink (< 128) and soft ink (< 215); big: the inverted page at up to 1600 px wide (for the text model)
fn features(i0: &[u8], s0: &[u8], sw: usize, sh: usize, big: Option<(&[u8], usize, usize)>, a: u32, model: Option<&Model>, max_p: usize) -> [f32; 7] {
    let (ink, w, h) = rotate_cw(i0, sw, sh, 1, a); let (soft, _, _) = rotate_cw(s0, sw, sh, 1, a);
    let (mut sy, mut sx, mut c, mut r0, mut r1) = (0.0f64, 0.0f64, 0u32, -1i32, -1i32);
    for y in 0..h { let mut rc = 0; for x in 0..w { if ink[y * w + x] != 0 { sy += y as f64; sx += x as f64; c += 1; rc += 1; } } if rc > 2 { if r0 < 0 { r0 = y as i32; } r1 = y as i32; } }
    if c < 50 { return [0.0; 7]; }
    let u = upright_score(&ink, w, h); let ml = margin_line(&soft, w, h);
    let (mut lo, mut n) = (0.0f32, 0usize);
    if let (Some(m), Some((b, bw, bh))) = (model, big) {
        let (r, rw, rh) = rotate_cw(b, bw, bh, 1, a);
        let (l, nn) = updown_logodds(m, &r, rw, rh, max_p); lo = l; n = nn;
    }
    let gap = if r0 >= 0 { r0 as f32 / h as f32 - (h as i32 - 1 - r1) as f32 / h as f32 } else { 0.0 };
    [u, 0.5 - (sy / c as f64) as f32 / h as f32, 0.5 - (sx / c as f64) as f32 / w as f32, lo / 400.0, if n > 0 { lo / n as f32 } else { 0.0 }, ml, -gap]
}

// page: the finished page as RGBA. Returns (rotation in degrees clockwise to make the page upright, confidence).
pub fn auto_orient(page: &[u8], gw: usize, gh: usize, page_found: bool, model: Option<&Model>, max_p: usize) -> (u32, f32) {
    let sw = 600.min(gw); let sh = ((gh as f32 * sw as f32 / gw as f32).round() as usize).max(8);
    let sm = resize_luma_rgba(page, gw, gh, sw, sh, false);
    let i0: Vec<u8> = sm.iter().map(|v| if *v <= 127 { 1 } else { 0 }).collect(); let s0: Vec<u8> = sm.iter().map(|v| if *v < 215 { 1 } else { 0 }).collect();
    let hs = horiz_score(&i0, sw, sh); let portrait = gh >= gw;
    let base: [u32; 2] = if page_found { if portrait { [0, 180] } else { [90, 270] } } else if hs >= 1.3 { [0, 180] } else if hs <= 0.77 { [90, 270] } else if portrait { [0, 180] } else { [90, 270] };
    let big = model.map(|_| { let bw = 1600.min(gw); let bh = ((gh as f32 * bw as f32 / gw as f32) as usize).max(8);
        (resize_luma_rgba(page, gw, gh, bw, bh, true), bw, bh) });
    let f = features(&i0, &s0, sw, sh, big.as_ref().map(|(b, w, h)| (b.as_slice(), *w, *h)), base[0], model, max_p);
    let mut score = 0.0f32; for i in 0..7 { score += f[i] * ORIENT_W[i]; }
    (if score >= 0.0 { base[0] } else { base[1] }, score.abs())
}
// Share of ink pixels with sharp edges: false when the photo is blurry. n: the shading-corrected page at any size.
pub fn is_blurry(n: &[u8], w: usize, h: usize) -> bool {
    let (sw, sh) = (800usize.min(w), ((h as f32 * 800.0f32.min(w as f32) / w as f32) as usize).max(8));
    let g = resize_area_gray(n, w, h, sw, sh);
    let fv: Vec<f32> = g.iter().map(|v| *v as f32).collect(); let thr = percentile(&fv, 3.0);
    let ink: Vec<u8> = g.iter().map(|v| if (*v as f32) < thr { 1 } else { 0 }).collect();
    if (ink.iter().map(|v| *v as u32).sum::<u32>() as f32) / (sw * sh) as f32 <= 0.001 { return false; }
    let dl = dilate_rect(&ink, sw, sh, 2, 2);
    let mut v: Vec<f32> = Vec::new();
    for y in 1..sh - 1 { for x in 1..sw - 1 { if dl[y * sw + x] != 0 {
        let c = g[y * sw + x] as f32; let lap = g[(y - 1) * sw + x] as f32 + g[(y + 1) * sw + x] as f32 + g[y * sw + x - 1] as f32 + g[y * sw + x + 1] as f32 - 4.0 * c; v.push(lap.abs());
    } } }
    percentile(&v, 90.0) < 12.0
}
