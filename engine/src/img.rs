// Image primitives: area resize, colour conversion, blur, gradients. Planar f32 buffers where it helps.

use crate::util::*;

// Area-average resize of an RGBA image (alpha ignored) to dw x dh, returning interleaved RGB as f32 (0..255).
pub fn resize_area_rgba(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
    let sx = sw as f32 / dw as f32; let sy = sh as f32 / dh as f32;
    // horizontal pass: dw x sh x 3
    let mut tmp = vec![0.0f32; dw * sh * 3];
    let mut xr: Vec<(usize, usize, Vec<f32>)> = Vec::with_capacity(dw);
    for x in 0..dw {
        let a = x as f32 * sx; let b = (x + 1) as f32 * sx;
        let i0 = a.floor() as usize; let i1 = ((b.ceil() as usize).min(sw)).max(i0 + 1);
        let mut w = Vec::with_capacity(i1 - i0);
        for i in i0..i1 { let lo = (i as f32).max(a); let hi = ((i + 1) as f32).min(b); w.push((hi - lo).max(0.0)); }
        let s: f32 = w.iter().sum::<f32>().max(1e-6); for v in w.iter_mut() { *v /= s; }
        xr.push((i0, i1, w));
    }
    for y in 0..sh {
        let row = &src[y * sw * 4..(y + 1) * sw * 4];
        let out = &mut tmp[y * dw * 3..(y + 1) * dw * 3];
        for x in 0..dw {
            let (i0, i1, w) = &xr[x];
            let (mut r, mut g, mut b) = (0.0f32, 0.0f32, 0.0f32);
            for (k, i) in (*i0..*i1).enumerate() { let p = &row[i * 4..i * 4 + 3]; let wk = w[k]; r += p[0] as f32 * wk; g += p[1] as f32 * wk; b += p[2] as f32 * wk; }
            out[x * 3] = r; out[x * 3 + 1] = g; out[x * 3 + 2] = b;
        }
    }
    // vertical pass
    let mut dst = vec![0.0f32; dw * dh * 3];
    for y in 0..dh {
        let a = y as f32 * sy; let b = (y + 1) as f32 * sy;
        let i0 = a.floor() as usize; let i1 = ((b.ceil() as usize).min(sh)).max(i0 + 1);
        let mut tot = 0.0f32;
        let out = &mut dst[y * dw * 3..(y + 1) * dw * 3];
        for i in i0..i1 {
            let lo = (i as f32).max(a); let hi = ((i + 1) as f32).min(b); let wk = (hi - lo).max(0.0); tot += wk;
            let row = &tmp[i * dw * 3..(i + 1) * dw * 3];
            for k in 0..dw * 3 { out[k] += row[k] * wk; }
        }
        let inv = 1.0 / tot.max(1e-6); for k in 0..dw * 3 { out[k] *= inv; }
    }
    dst
}

fn srgb_lut() -> [f32; 256] {
    let mut l = [0.0f32; 256];
    for i in 0..256 { let c = i as f32 / 255.0; l[i] = if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }; }
    l
}

// sRGB (0..255 as f32, interleaved) to planar CIE Lab (L 0..100, a and b about -100..100).
pub fn rgb_to_lab(rgb: &[f32], n: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let lut = srgb_lut();
    let mut l = vec![0.0f32; n]; let mut a = vec![0.0f32; n]; let mut b = vec![0.0f32; n];
    let f = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    for i in 0..n {
        let lin = |v: f32| { let iv = clampf(v, 0.0, 255.0); let i0 = iv.floor() as usize; let i1 = (i0 + 1).min(255); let fr = iv - i0 as f32; lut[i0] * (1.0 - fr) + lut[i1] * fr };
        let (r, g, bl) = (lin(rgb[i * 3]), lin(rgb[i * 3 + 1]), lin(rgb[i * 3 + 2]));
        let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * bl) / 0.95047;
        let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * bl;
        let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * bl) / 1.08883;
        let (fx, fy, fz) = (f(x), f(y), f(z));
        l[i] = 116.0 * fy - 16.0; a[i] = 500.0 * (fx - fy); b[i] = 200.0 * (fy - fz);
    }
    (l, a, b)
}

pub fn gauss_kernel(sigma: f32) -> Vec<f32> {
    let r = (sigma * 3.0).ceil().max(1.0) as i32;
    let mut k: Vec<f32> = (-r..=r).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
    let s: f32 = k.iter().sum(); for v in k.iter_mut() { *v /= s; }
    k
}

pub fn blur_sep(src: &[f32], w: usize, h: usize, kern: &[f32]) -> Vec<f32> {
    let r = (kern.len() / 2) as i32;
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut s = 0.0;
            for (k, kv) in kern.iter().enumerate() { let xx = clampi(x as i32 + k as i32 - r, 0, w as i32 - 1) as usize; s += src[y * w + xx] * kv; }
            tmp[y * w + x] = s;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut s = 0.0;
            for (k, kv) in kern.iter().enumerate() { let yy = clampi(y as i32 + k as i32 - r, 0, h as i32 - 1) as usize; s += tmp[yy * w + x] * kv; }
            out[y * w + x] = s;
        }
    }
    out
}

// Box blur with edge replication, window k (odd), via running sums.
pub fn box_blur(src: &[f32], w: usize, h: usize, k: usize) -> Vec<f32> {
    let r = (k / 2) as i32; let kf = (2 * r + 1) as f32;
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        let mut s = 0.0f32;
        for i in -r..=r { s += row[clampi(i, 0, w as i32 - 1) as usize]; }
        for x in 0..w as i32 {
            tmp[y * w + x as usize] = s / kf;
            s += row[clampi(x + r + 1, 0, w as i32 - 1) as usize] - row[clampi(x - r, 0, w as i32 - 1) as usize];
        }
    }
    let mut out = vec![0.0f32; w * h];
    for x in 0..w {
        let mut s = 0.0f32;
        for i in -r..=r { s += tmp[clampi(i, 0, h as i32 - 1) as usize * w + x]; }
        for y in 0..h as i32 {
            out[y as usize * w + x] = s / kf;
            s += tmp[clampi(y + r + 1, 0, h as i32 - 1) as usize * w + x] - tmp[clampi(y - r, 0, h as i32 - 1) as usize * w + x];
        }
    }
    out
}

// Sobel gradients (3x3), edge replicated.
pub fn sobel(src: &[f32], w: usize, h: usize) -> (Vec<f32>, Vec<f32>) {
    let mut gx = vec![0.0f32; w * h]; let mut gy = vec![0.0f32; w * h];
    let at = |x: i32, y: i32| src[clampi(y, 0, h as i32 - 1) as usize * w + clampi(x, 0, w as i32 - 1) as usize];
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let a = at(x - 1, y - 1); let b = at(x, y - 1); let c = at(x + 1, y - 1);
            let d = at(x - 1, y); let f = at(x + 1, y);
            let g = at(x - 1, y + 1); let hh = at(x, y + 1); let i = at(x + 1, y + 1);
            gx[y as usize * w + x as usize] = (c + 2.0 * f + i) - (a + 2.0 * d + g);
            gy[y as usize * w + x as usize] = (g + 2.0 * hh + i) - (a + 2.0 * b + c);
        }
    }
    (gx, gy)
}

pub fn sample_bilinear(p: &[f32], w: usize, h: usize, x: f32, y: f32) -> f32 {
    let x = clampf(x, 0.0, w as f32 - 1.001); let y = clampf(y, 0.0, h as f32 - 1.001);
    let x0 = x as usize; let y0 = y as usize; let fx = x - x0 as f32; let fy = y - y0 as f32;
    let a = p[y0 * w + x0]; let b = p[y0 * w + x0 + 1]; let c = p[(y0 + 1) * w + x0]; let d = p[(y0 + 1) * w + x0 + 1];
    (a * (1.0 - fx) + b * fx) * (1.0 - fy) + (c * (1.0 - fx) + d * fx) * fy
}
