// Corner refinement on the full-resolution photo, the true page shape, and the perspective warp.

use crate::detect::{aspect_ratio_full, PAPER_RATIOS};
use crate::util::*;

pub struct Rgba<'a> { pub d: &'a [u8], pub w: usize, pub h: usize }

#[inline]
fn px(img: &Rgba, x: i32, y: i32) -> [f32; 3] {
    let xi = clampi(x, 0, img.w as i32 - 1) as usize; let yi = clampi(y, 0, img.h as i32 - 1) as usize; let o = (yi * img.w + xi) * 4;
    [img.d[o] as f32, img.d[o + 1] as f32, img.d[o + 2] as f32]
}

// bilinear colour at a float position
pub fn sample(img: &Rgba, x: f32, y: f32) -> [f32; 3] {
    let x0 = x.floor(); let y0 = y.floor(); let fx = x - x0; let fy = y - y0; let (xi, yi) = (x0 as i32, y0 as i32);
    let a = px(img, xi, yi); let b = px(img, xi + 1, yi); let c = px(img, xi, yi + 1); let d = px(img, xi + 1, yi + 1);
    let mut o = [0.0f32; 3];
    for k in 0..3 { o[k] = (a[k] * (1.0 - fx) + b[k] * fx) * (1.0 - fy) + (c[k] * (1.0 - fx) + d[k] * fx) * fy; }
    o
}

// colour step across a position: how different the three pixels on one side are from the three on the other
fn step_at(img: &Rgba, c: P, nrm: [f32; 2]) -> f32 {
    let (mut ia, mut ib) = ([0.0f32; 3], [0.0f32; 3]);
    for u in [1.0f32, 2.0, 3.0].iter() {
        let sa = sample(img, c[0] - nrm[0] * u, c[1] - nrm[1] * u); let sb = sample(img, c[0] + nrm[0] * u, c[1] + nrm[1] * u);
        for ch in 0..3 { ia[ch] += sa[ch] / 3.0; ib[ch] += sb[ch] / 3.0; }
    }
    ((ia[0] - ib[0]).powi(2) + (ia[1] - ib[1]).powi(2) + (ia[2] - ib[2]).powi(2)).sqrt()
}

// Move each side of the quad onto the strongest colour step in the photo, then intersect the sides.
// Conservative: a side moves only when the new line is clearly better supported than the old one (a shadow or a printed border near the
// page edge must not pull the corner away).
pub fn refine_quad(img: &Rgba, q: &Quad) -> Quad {
    let big = img.w.max(img.h) as f32;
    let r = (0.008 * big).max(3.0); // search radius in pixels
    let mut lines: Vec<Line> = Vec::new();
    for k in 0..4 {
        let a = q[k]; let b = q[(k + 1) % 4]; let l0 = match Line::through(a, b) { Some(l) => l, None => return *q };
        let len = dist(a, b).max(1.0); let d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]; let nrm = [l0.a, l0.b];
        let ns = ((len / 4.0) as usize).clamp(12, 120);
        let mut pts: Vec<P> = Vec::new(); let mut ts: Vec<f32> = Vec::new(); let mut base = 0.0f32; let mut nvalid = 0usize;
        for s in 0..ns {
            let t = 0.06 + 0.88 * (s as f32 + 0.5) / ns as f32; let p = [a[0] + d[0] * len * t, a[1] + d[1] * len * t];
            if p[0] < 2.0 || p[1] < 2.0 || p[0] > img.w as f32 - 3.0 || p[1] > img.h as f32 - 3.0 { continue; }
            nvalid += 1; base += step_at(img, p, nrm);
            let steps = (2.0 * r) as i32; let (mut best, mut bo) = (0.0f32, 0.0f32); let mut sum = 0.0f32;
            for j in 0..=steps {
                let o = -r + j as f32; let v = step_at(img, [p[0] + nrm[0] * o, p[1] + nrm[1] * o], nrm);
                sum += v; if v > best { best = v; bo = o; }
            }
            let mean = sum / (steps + 1) as f32;
            if best > 2.0 * mean + 6.0 { pts.push([p[0] + nrm[0] * bo, p[1] + nrm[1] * bo]); ts.push(t); }
        }
        let mut chosen = l0;
        if nvalid >= 10 && pts.len() >= (nvalid / 2).max(10) {
            if let Some(l1) = fit_line_robust(&pts, 3) {
                // support of the new line against the old one, over the same stretch of the page edge
                let mut fit = 0.0f32; let mut inl = 0usize;
                for p in pts.iter() { if l1.signed(*p).abs() < 1.5 { inl += 1; } }
                for s in 0..ns { let t = 0.06 + 0.88 * (s as f32 + 0.5) / ns as f32; let p = [a[0] + d[0] * len * t, a[1] + d[1] * len * t];
                    if p[0] < 2.0 || p[1] < 2.0 || p[0] > img.w as f32 - 3.0 || p[1] > img.h as f32 - 3.0 { continue; }
                    // the point of the new line nearest to p
                    let off = -l1.signed(p); fit += step_at(img, [p[0] + l1.a * off, p[1] + l1.b * off], [l1.a, l1.b]); }
                if inl * 10 >= pts.len() * 6 && fit >= 1.25 * base { chosen = l1; }
            }
        }
        lines.push(chosen);
    }
    let mut out = *q;
    for k in 0..4 {
        if let Some(p) = intersect(&lines[(k + 3) % 4], &lines[k]) { if dist(p, q[k]) < 0.02 * big { out[k] = p; } }
    }
    out
}
pub struct PageShape { pub w: usize, pub h: usize, pub used: u8 } // used: 0 edges, 1 geometry, 2 paper

// Output size for a page quad: the true paper shape from the camera geometry, snapped to letter/A4 when close.
pub fn page_shape(q: &Quad, iw: usize, ih: usize, long_px: f32, paper_ratio: f32) -> PageShape {
    let l = |a: P, b: P| dist(a, b);
    let wpx = l(q[0], q[1]).max(l(q[3], q[2])); let hpx = l(q[0], q[3]).max(l(q[1], q[2]));
    let longest = wpx.max(hpx);
    let target_long = long_px.min((1.35 * longest).max(300.0)).max(200.0);
    let (ratio, wide, used) = match aspect_ratio_full(q, iw as f32, ih as f32) {
        Some((r, wide)) => {
            let mut ls = r; let mut used = 1u8;
            let mut list = vec![paper_ratio]; for p in PAPER_RATIOS.iter().take(2) { if (p - paper_ratio).abs() > 1e-3 { list.push(*p); } }
            for pr in list { if (ls - pr).abs() / pr < 0.07 { ls = pr; used = 2; break; } }
            (ls, wide, used)
        }
        None => { let r = (wpx.max(hpx) / wpx.min(hpx).max(1.0)).max(1.0); (r, wpx >= hpx, 0u8) }
    };
    let (w, h) = if wide { (target_long, target_long / ratio) } else { (target_long / ratio, target_long) };
    PageShape { w: (w.round() as usize).max(16), h: (h.round() as usize).max(16), used }
}

// Warp the quad to an ow x oh rectangle (bilinear). Output is RGBA; alpha 0 marks pixels that fall outside the photo.
// Integer bilinear: two channels per 32-bit multiply (weights sum to 256, so a 16-bit lane never overflows).
pub fn warp(img: &Rgba, q: &Quad, ow: usize, oh: usize) -> (Vec<u8>, Vec<u8>) {
    let dst: Quad = [[0.0, 0.0], [ow as f32 - 1.0, 0.0], [ow as f32 - 1.0, oh as f32 - 1.0], [0.0, oh as f32 - 1.0]];
    let hm = homography(&dst, q).unwrap_or([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]); // output -> photo
    let mut out = vec![255u8; ow * oh * 4]; let mut lum = vec![255u8; ow * oh];
    let (iw, ih) = (img.w, img.h); let (fw, fh) = ((iw - 1) as f32, (ih - 1) as f32);
    let d = img.d;
    let at = |i: usize| u32::from_le_bytes([d[i], d[i + 1], d[i + 2], d[i + 3]]);
    for y in 0..oh {
        let yf = y as f32;
        let (nu0, nv0, dn0) = (hm[1] * yf + hm[2], hm[4] * yf + hm[5], hm[7] * yf + hm[8]);
        let row = &mut out[y * ow * 4..(y + 1) * ow * 4]; let lrow = &mut lum[y * ow..(y + 1) * ow];
        for x in 0..ow {
            let xf = x as f32; let inv = 1.0 / (hm[6] * xf + dn0);
            let sx = (hm[0] * xf + nu0) * inv; let sy = (hm[3] * xf + nv0) * inv;
            let o = x * 4;
            if !(sx >= 0.0 && sy >= 0.0 && sx < fw && sy < fh) { row[o + 3] = 0; continue; }
            let (x0, y0) = (sx as usize, sy as usize);
            let wx = ((sx - x0 as f32) * 256.0) as u32; let wy = ((sy - y0 as f32) * 256.0) as u32;
            let w11 = (wx * wy) >> 8; let w10 = wx - w11; let w01 = wy - w11; let w00 = 256 - wx - wy + w11;
            let i00 = (y0 * iw + x0) * 4;
            let (p00, p10, p01, p11) = (at(i00), at(i00 + 4), at(i00 + iw * 4), at(i00 + iw * 4 + 4));
            const M: u32 = 0x00FF_00FF;
            let rb = ((p00 & M) * w00 + (p10 & M) * w10 + (p01 & M) * w01 + (p11 & M) * w11 + 0x0080_0080) >> 8;
            let ga = (((p00 >> 8) & M) * w00 + ((p10 >> 8) & M) * w10 + ((p01 >> 8) & M) * w01 + ((p11 >> 8) & M) * w11 + 0x0080_0080) >> 8;
            let (r, g, b) = ((rb & 0xFF) as u8, (ga & 0xFF) as u8, ((rb >> 16) & 0xFF) as u8);
            row[o] = r; row[o + 1] = g; row[o + 2] = b; row[o + 3] = 255;
            lrow[x] = ((77 * r as u32 + 151 * g as u32 + 28 * b as u32) >> 8) as u8;
        }
    }
    (out, lum)
}