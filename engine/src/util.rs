// Small geometry and statistics helpers shared by the engine. Everything is f32 and allocation-light.

pub type P = [f32; 2];
pub type Quad = [P; 4]; // top-left, top-right, bottom-right, bottom-left

#[inline]
pub fn clampf(x: f32, a: f32, b: f32) -> f32 { if x < a { a } else if x > b { b } else { x } }
#[inline]
pub fn clampi(x: i32, a: i32, b: i32) -> i32 { if x < a { a } else if x > b { b } else { x } }

pub fn dist(a: P, b: P) -> f32 { ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt() }

// A line a*x + b*y + c = 0 with (a, b) a unit normal.
#[derive(Clone, Copy, Debug)]
pub struct Line { pub a: f32, pub b: f32, pub c: f32 }

impl Line {
    pub fn through(p: P, q: P) -> Option<Line> {
        let dx = q[0] - p[0]; let dy = q[1] - p[1];
        let n = (dx * dx + dy * dy).sqrt();
        if n < 1e-6 { return None; }
        let a = dy / n; let b = -dx / n;
        Some(Line { a, b, c: -(a * p[0] + b * p[1]) })
    }
    pub fn from_normal(theta: f32, rho: f32) -> Line { Line { a: theta.cos(), b: theta.sin(), c: -rho } }
    pub fn signed(&self, p: P) -> f32 { self.a * p[0] + self.b * p[1] + self.c }
}

pub fn intersect(l1: &Line, l2: &Line) -> Option<P> {
    let det = l1.a * l2.b - l2.a * l1.b;
    if det.abs() < 1e-6 { return None; }
    Some([(l1.b * l2.c - l2.b * l1.c) / det, (l2.a * l1.c - l1.a * l2.c) / det])
}

pub fn poly_area(p: &[P]) -> f32 {
    let mut s = 0.0;
    for i in 0..p.len() { let j = (i + 1) % p.len(); s += p[i][0] * p[j][1] - p[j][0] * p[i][1]; }
    s.abs() * 0.5
}

pub fn is_convex(q: &Quad) -> bool {
    let (mut pos, mut neg) = (0, 0);
    for k in 0..4 {
        let a = q[k]; let b = q[(k + 1) % 4]; let c = q[(k + 2) % 4];
        let cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
        if cr > 0.0 { pos += 1 } else if cr < 0.0 { neg += 1 }
    }
    pos == 4 || neg == 4
}

// Order four points as top-left, top-right, bottom-right, bottom-left.
pub fn order4(p: [P; 4]) -> Quad {
    let mut s = [0.0f32; 4]; let mut d = [0.0f32; 4];
    for i in 0..4 { s[i] = p[i][0] + p[i][1]; d[i] = p[i][0] - p[i][1]; }
    let (mut tl, mut br, mut tr, mut bl) = (0, 0, 0, 0);
    for i in 1..4 {
        if s[i] < s[tl] { tl = i } if s[i] > s[br] { br = i }
        if d[i] > d[tr] { tr = i } if d[i] < d[bl] { bl = i }
    }
    [p[tl], p[tr], p[br], p[bl]]
}

// Fill a convex or simple polygon into a u8 mask (value 1) with a scanline rule.
pub fn fill_poly(mask: &mut [u8], w: usize, h: usize, poly: &[P]) {
    let n = poly.len();
    for y in 0..h {
        let yc = y as f32 + 0.5;
        let mut xs: [f32; 16] = [0.0; 16]; let mut k = 0;
        for i in 0..n {
            let a = poly[i]; let b = poly[(i + 1) % n];
            if (a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc) {
                if k < 16 { xs[k] = a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]); k += 1; }
            }
        }
        // sort the few crossings
        for i in 1..k { let mut j = i; while j > 0 && xs[j - 1] > xs[j] { xs.swap(j - 1, j); j -= 1; } }
        let mut i = 0;
        while i + 1 < k {
            let x0 = (xs[i] - 0.5).ceil().max(0.0) as usize; let x1 = ((xs[i + 1] - 0.5).floor() as i64).min(w as i64 - 1);
            if x1 >= x0 as i64 { for x in x0..=(x1 as usize) { mask[y * w + x] = 1; } }
            i += 2;
        }
    }
}

pub fn mask_iou(a: &[u8], b: &[u8]) -> f32 {
    let (mut i, mut u) = (0u32, 0u32);
    for k in 0..a.len() { let x = a[k] != 0; let y = b[k] != 0; if x && y { i += 1 } if x || y { u += 1 } }
    if u == 0 { 0.0 } else { i as f32 / u as f32 }
}

// k-th smallest (0-based) without disturbing the caller's order
pub fn kth(v: &[f32], k: usize) -> f32 {
    let mut t: Vec<f32> = v.to_vec();
    if t.is_empty() { return 0.0; }
    let k = k.min(t.len() - 1);
    let (_, m, _) = t.select_nth_unstable_by(k, |a, b| a.partial_cmp(b).unwrap_or(core::cmp::Ordering::Equal));
    *m
}
pub fn median(v: &[f32]) -> f32 { if v.is_empty() { 0.0 } else { kth(v, v.len() / 2) } }
pub fn percentile(v: &[f32], p: f32) -> f32 { if v.is_empty() { 0.0 } else { kth(v, ((v.len() - 1) as f32 * p / 100.0).round() as usize) } }

// Median of a u8 slice by histogram (exact)
pub fn median_u8(v: impl Iterator<Item = u8>) -> f32 {
    let mut h = [0u32; 256]; let mut n = 0u32;
    for x in v { h[x as usize] += 1; n += 1; }
    if n == 0 { return 0.0; }
    let mut c = 0u32; let half = n / 2;
    for i in 0..256 { c += h[i]; if c > half { return i as f32; } }
    255.0
}

// Solve the 8x8 system for a homography mapping four points to four points (Gaussian elimination).
pub fn homography(src: &Quad, dst: &Quad) -> Option<[f32; 9]> {
    let mut m = [[0.0f64; 9]; 8];
    for i in 0..4 {
        let (x, y) = (src[i][0] as f64, src[i][1] as f64); let (u, v) = (dst[i][0] as f64, dst[i][1] as f64);
        m[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u];
        m[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v];
    }
    for c in 0..8 {
        let mut p = c; for r in c + 1..8 { if m[r][c].abs() > m[p][c].abs() { p = r } }
        if m[p][c].abs() < 1e-12 { return None; }
        m.swap(c, p);
        for r in 0..8 { if r != c { let f = m[r][c] / m[c][c]; for k in c..9 { m[r][k] -= f * m[c][k]; } } }
    }
    let mut h = [0.0f32; 9];
    for i in 0..8 { h[i] = (m[i][8] / m[i][i]) as f32; }
    h[8] = 1.0;
    Some(h)
}

pub fn apply_h(h: &[f32; 9], x: f32, y: f32) -> P {
    let w = h[6] * x + h[7] * y + h[8];
    [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
}

// Total least squares line through points; returns a line and the rms distance.
pub fn fit_line(pts: &[P]) -> Option<(Line, f32)> {
    if pts.len() < 2 { return None; }
    let n = pts.len() as f32;
    let (mut mx, mut my) = (0.0f32, 0.0f32);
    for p in pts { mx += p[0]; my += p[1]; }
    mx /= n; my /= n;
    let (mut sxx, mut sxy, mut syy) = (0.0f32, 0.0f32, 0.0f32);
    for p in pts { let dx = p[0] - mx; let dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    let th = 0.5 * (2.0 * sxy).atan2(sxx - syy); // direction of the line
    let (dx, dy) = (th.cos(), th.sin());
    let (a, b) = (-dy, dx);
    let l = Line { a, b, c: -(a * mx + b * my) };
    let mut e = 0.0; for p in pts { let d = l.signed(*p); e += d * d; }
    Some((l, (e / n).sqrt()))
}

// Iteratively reweighted (Huber) line fit, robust to a few stray points.
pub fn fit_line_robust(pts: &[P], iters: usize) -> Option<Line> {
    let (mut l, _) = fit_line(pts)?;
    for _ in 0..iters {
        let ds: Vec<f32> = pts.iter().map(|p| l.signed(*p).abs()).collect();
        let s = (median(&ds) * 1.4826).max(0.4);
        let keep: Vec<P> = pts.iter().zip(ds.iter()).filter(|(_, d)| **d <= 2.0 * s + 0.3).map(|(p, _)| *p).collect();
        if keep.len() < 4 || keep.len() == pts.len() { break; }
        l = fit_line(&keep)?.0;
    }
    Some(l)
}
