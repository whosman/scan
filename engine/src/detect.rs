// Page detection. Works on a ~320 px copy of the photo.
//
// Two candidate sources, one verifier:
//   1. Segmentation. The table is modelled from the frame border (a small colour mixture in Lab). Everything unlike the table is
//      paper. The paper region becomes a quadrilateral (hull reduced to four sides, then each side refitted to the region boundary).
//   2. Lines. Noise-normalised colour edges vote in a Hough accumulator; pairs of near-horizontal and near-vertical lines make quads.
// Every candidate is then scored on how well all four sides are supported by real edges and colour steps, how different the inside is
// from the outside, how well it agrees with the segmentation, and how paper-like its shape is. A linear scorer (weights learned
// offline, see tools/) picks the winner.

use crate::img::*;
use crate::util::*;

pub const NF: usize = 19;

pub struct Work { pub w: usize, pub h: usize, pub s: f32, pub l: Vec<f32>, pub a: Vec<f32>, pub b: Vec<f32>, pub ink: Vec<u8> }

pub struct Edges { pub mag: Vec<f32>, pub ori: Vec<f32>, pub rel: Vec<f32>, pub hard: f32, pub soft: f32 }

#[derive(Clone)]
pub struct Cand { pub q: Quad, pub src: u8, pub f: [f32; NF], pub score: f32 }

pub struct Detection {
    pub conf: f32, pub wk: Work, pub edges: Edges, pub masks: Vec<Vec<u8>>,
    pub found: bool, pub qw: Quad, pub src: u8, pub score: f32, pub margin: f32, pub frame_sides: u32,
    pub cands: Vec<Cand>, pub s: f32, pub ww: usize, pub wh: usize,
}

pub const PAPER_RATIOS: [f32; 4] = [11.0 / 8.5, 11.69 / 8.27, 14.0 / 8.5, 1.3333];

// Weights of the linear scorer, in the order of the features below. Fitted by tools/fit_rank_rs.py.
pub static mut WEIGHTS: [f32; NF + 1] = [3.0707, 4.4122, 1.8936, 1.2113, -1.3225, 2.0198, 2.1867, 3.2454, 2.6903, -0.4923, -5.4986, 6.0532, 1.2434, 1.7455, 2.3835, -0.4278, -0.8646, 2.0510, -0.8223, -0.0000];

// Confidence that the chosen candidate is the page: logistic on its features, its score, its margin over the runner-up and whether it is the whole frame.
// Fitted by tools/fit_conf_rs.py.
pub static mut CONF: [f32; NF + 4] = [2.5404, 6.4609, 0.9398, 2.4044, -2.5096, -0.6661, 1.2641, 2.1467, 1.9004, -0.5926, -3.6182, 1.9705, 0.6872, 0.6183, -0.9210, 0.3847, -0.5494, -0.4938, -0.2209, 0.1861, -0.0117, -0.1376, -10.7422];

pub fn make_work(rgba: &[u8], w: usize, h: usize, wl: f32) -> Work {
    let s = (wl / w.max(h) as f32).min(1.0);
    let dw = ((w as f32 * s).round() as usize).max(16); let dh = ((h as f32 * s).round() as usize).max(16);
    let rgb = resize_area_rgba(rgba, w, h, dw, dh);
    let (l, a, b) = rgb_to_lab(&rgb, dw * dh);
    // ink: thin dark strokes (text, ruling) stand out from the local average
    let loc = box_blur(&l, dw, dh, 9);
    let ink: Vec<u8> = (0..dw * dh).map(|i| if loc[i] - l[i] > 6.0 { 1 } else { 0 }).collect();
    Work { w: dw, h: dh, s: dw as f32 / w as f32, l, a, b, ink }
}

pub fn edges(wk: &Work) -> Edges {
    let (w, h) = (wk.w, wk.h); let n = w * h;
    let k = gauss_kernel(1.0);
    let planes = [&wk.l, &wk.a, &wk.b];
    let (mut jxx, mut jyy, mut jxy) = (vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]);
    for p in planes.iter() {
        let bl = blur_sep(p, w, h, &k);
        let (gx, gy) = sobel(&bl, w, h);
        let hyp: Vec<f32> = (0..n).map(|i| (gx[i] * gx[i] + gy[i] * gy[i]).sqrt()).collect();
        let noise = median(&hyp) + 1e-3;
        for i in 0..n { let x = gx[i] / noise; let y = gy[i] / noise; jxx[i] += x * x; jyy[i] += y * y; jxy[i] += x * y; }
    }
    let mut mag = vec![0.0f32; n]; let mut ori = vec![0.0f32; n];
    for i in 0..n {
        let tr = jxx[i] + jyy[i]; let det = jxx[i] * jyy[i] - jxy[i] * jxy[i];
        let lam = tr * 0.5 + (tr * tr * 0.25 - det).max(0.0).sqrt();
        mag[i] = lam.sqrt();
        let mut t = 0.5 * (2.0 * jxy[i]).atan2(jxx[i] - jyy[i]); if t < 0.0 { t += core::f32::consts::PI; }
        ori[i] = t;
    }
    // non-maximum suppression across the edge direction
    let mut thin = vec![0.0f32; n];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let i = y * w + x; let dx = ori[i].cos().round() as i32; let dy = ori[i].sin().round() as i32;
            let m1 = mag[((y as i32 + dy) as usize) * w + (x as i32 + dx) as usize]; let m2 = mag[((y as i32 - dy) as usize) * w + (x as i32 - dx) as usize];
            if mag[i] >= m1 && mag[i] >= m2 { thin[i] = mag[i]; }
        }
    }
    let loc = box_blur(&mag, w, h, (w / 8) | 1);
    let med = median(&mag) + 1e-3;
    let mut rel = vec![0.0f32; n]; let mut nz: Vec<f32> = Vec::new();
    for i in 0..n { rel[i] = thin[i] / (loc[i] + med); if rel[i] > 0.0 { nz.push(rel[i]); } }
    let hard = if nz.is_empty() { 1.0 } else { percentile(&nz, 80.0) };
    Edges { mag, ori, rel, hard, soft: 0.6 * hard }
}

// ---------- binary morphology and regions ----------
fn dilate(m: &[u8], w: usize, h: usize, r: i32) -> Vec<u8> {
    let mut t = vec![0u8; w * h]; let mut o = vec![0u8; w * h];
    for y in 0..h { for x in 0..w as i32 { let mut v = 0; for k in -r..=r { let xx = x + k; if xx >= 0 && xx < w as i32 && m[y * w + xx as usize] != 0 { v = 1; break; } } t[y * w + x as usize] = v; } }
    for y in 0..h as i32 { for x in 0..w { let mut v = 0; for k in -r..=r { let yy = y + k; if yy >= 0 && yy < h as i32 && t[yy as usize * w + x] != 0 { v = 1; break; } } o[y as usize * w + x] = v; } }
    o
}
fn erode(m: &[u8], w: usize, h: usize, r: i32) -> Vec<u8> {
    let inv: Vec<u8> = m.iter().map(|v| if *v != 0 { 0 } else { 1 }).collect();
    dilate(&inv, w, h, r).iter().map(|v| if *v != 0 { 0 } else { 1 }).collect()
}

// Label 4-connected components; returns labels (0 = none) and per-label (area, sum x, sum y).
fn label(m: &[u8], w: usize, h: usize) -> (Vec<u32>, Vec<(u32, f64, f64)>) {
    let mut lab = vec![0u32; w * h]; let mut stats: Vec<(u32, f64, f64)> = vec![(0, 0.0, 0.0)];
    let mut stack: Vec<usize> = Vec::new();
    for s in 0..w * h {
        if m[s] == 0 || lab[s] != 0 { continue; }
        let id = stats.len() as u32; stats.push((0, 0.0, 0.0)); lab[s] = id; stack.push(s);
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            let st = &mut stats[id as usize]; st.0 += 1; st.1 += x as f64; st.2 += y as f64;
            if x > 0 && m[i - 1] != 0 && lab[i - 1] == 0 { lab[i - 1] = id; stack.push(i - 1); }
            if x + 1 < w && m[i + 1] != 0 && lab[i + 1] == 0 { lab[i + 1] = id; stack.push(i + 1); }
            if y > 0 && m[i - w] != 0 && lab[i - w] == 0 { lab[i - w] = id; stack.push(i - w); }
            if y + 1 < h && m[i + w] != 0 && lab[i + w] == 0 { lab[i + w] = id; stack.push(i + w); }
        }
    }
    (lab, stats)
}

fn fill_holes(m: &mut Vec<u8>, w: usize, h: usize) {
    let mut outside = vec![0u8; w * h]; let mut stack: Vec<usize> = Vec::new();
    for x in 0..w { for &y in &[0usize, h - 1] { let i = y * w + x; if m[i] == 0 && outside[i] == 0 { outside[i] = 1; stack.push(i); } } }
    for y in 0..h { for &x in &[0usize, w - 1] { let i = y * w + x; if m[i] == 0 && outside[i] == 0 { outside[i] = 1; stack.push(i); } } }
    while let Some(i) = stack.pop() {
        let (x, y) = (i % w, i / w);
        let mut push = |j: usize| if m[j] == 0 && outside[j] == 0 { outside[j] = 1; stack.push(j); };
        if x > 0 { push(i - 1) } if x + 1 < w { push(i + 1) } if y > 0 { push(i - w) } if y + 1 < h { push(i + w) }
    }
    for i in 0..w * h { if m[i] == 0 && outside[i] == 0 { m[i] = 1; } }
}

fn convex_hull(mut pts: Vec<P>) -> Vec<P> {
    pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(core::cmp::Ordering::Equal).then(a[1].partial_cmp(&b[1]).unwrap_or(core::cmp::Ordering::Equal)));
    pts.dedup();
    if pts.len() < 3 { return pts; }
    let cross = |o: P, a: P, b: P| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut lo: Vec<P> = Vec::new();
    for p in pts.iter() { while lo.len() >= 2 && cross(lo[lo.len() - 2], lo[lo.len() - 1], *p) <= 0.0 { lo.pop(); } lo.push(*p); }
    let mut up: Vec<P> = Vec::new();
    for p in pts.iter().rev() { while up.len() >= 2 && cross(up[up.len() - 2], up[up.len() - 1], *p) <= 0.0 { up.pop(); } up.push(*p); }
    lo.pop(); up.pop(); lo.extend(up); lo
}

// Reduce a convex polygon to four sides by repeatedly dropping the edge whose removal adds the least area.
fn reduce_to_quad(mut v: Vec<P>) -> Option<Quad> {
    if v.len() < 4 { return None; }
    // make the polygon counter-clockwise in image coordinates (y down) so that "outside" is the right side of an edge
    let mut area2 = 0.0; for i in 0..v.len() { let j = (i + 1) % v.len(); area2 += v[i][0] * v[j][1] - v[j][0] * v[i][1]; }
    if area2 < 0.0 { v.reverse(); }
    while v.len() > 4 {
        let n = v.len(); let mut best: Option<(usize, P, f32)> = None;
        for i in 0..n {
            let a = v[(i + n - 1) % n]; let b = v[i]; let c = v[(i + 1) % n]; let d = v[(i + 2) % n];
            let l1 = match Line::through(a, b) { Some(l) => l, None => continue }; let l2 = match Line::through(c, d) { Some(l) => l, None => continue };
            let p = match intersect(&l1, &l2) { Some(p) => p, None => continue };
            let e = [c[0] - b[0], c[1] - b[1]]; let t = [p[0] - b[0], p[1] - b[1]];
            let outside = e[0] * t[1] - e[1] * t[0];
            let ok = if area2 >= 0.0 { outside > 0.0 } else { outside < 0.0 };
            if !ok { continue; }
            let added = poly_area(&[b, p, c]);
            if best.map_or(true, |bb| added < bb.2) { best = Some((i, p, added)); }
        }
        match best {
            Some((i, p, _)) => { let j = (i + 1) % n; v[i] = p; v.remove(j); }
            None => { // nearly parallel neighbours: drop the vertex with the smallest triangle
                let mut bi = 0; let mut ba = f32::MAX;
                for i in 0..n { let t = poly_area(&[v[(i + n - 1) % n], v[i], v[(i + 1) % n]]); if t < ba { ba = t; bi = i; } }
                v.remove(bi);
            }
        }
    }
    Some(order4([v[0], v[1], v[2], v[3]]))
}

// ---------- segmentation candidates ----------
struct Cluster { mu: [f32; 3], inv: [[f32; 3]; 3], weight: f32 }

fn inv3(m: [[f32; 3]; 3]) -> Option<[[f32; 3]; 3]> {
    let d = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if d.abs() < 1e-9 { return None; }
    let id = 1.0 / d;
    Some([
        [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) * id, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * id, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * id],
        [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) * id, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * id, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * id],
        [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) * id, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * id, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * id],
    ])
}

fn ring_clusters(wk: &Work) -> Vec<Cluster> {
    let (w, h) = (wk.w, wk.h); let b = ((0.06 * w.min(h) as f32).round() as usize).max(3);
    let mut px: Vec<[f32; 3]> = Vec::new();
    for y in 0..h { for x in 0..w { if x < b || x >= w - b || y < b || y >= h - b { let i = y * w + x; px.push([wk.l[i], wk.a[i], wk.b[i]]); } } }
    if px.len() < 30 { return vec![]; }
    let mut order: Vec<usize> = (0..px.len()).collect();
    order.sort_by(|&i, &j| px[i][0].partial_cmp(&px[j][0]).unwrap_or(core::cmp::Ordering::Equal));
    let k = 3; let mut mu: Vec<[f32; 3]> = (0..k).map(|c| px[order[(px.len() - 1) * (2 * c + 1) / (2 * k)]]).collect();
    let mut asg = vec![0usize; px.len()];
    for _ in 0..10 {
        let mut sum = vec![[0.0f32; 3]; k]; let mut cnt = vec![0u32; k];
        for (i, p) in px.iter().enumerate() {
            let mut bc = 0; let mut bd = f32::MAX;
            for c in 0..k { let d = (p[0] - mu[c][0]).powi(2) + (p[1] - mu[c][1]).powi(2) + (p[2] - mu[c][2]).powi(2); if d < bd { bd = d; bc = c; } }
            asg[i] = bc; for t in 0..3 { sum[bc][t] += p[t]; } cnt[bc] += 1;
        }
        for c in 0..k { if cnt[c] > 0 { for t in 0..3 { mu[c][t] = sum[c][t] / cnt[c] as f32; } } }
    }
    let mut out = Vec::new();
    for c in 0..k {
        let idx: Vec<usize> = (0..px.len()).filter(|&i| asg[i] == c).collect();
        let wgt = idx.len() as f32 / px.len() as f32; if wgt < 0.08 { continue; }
        let mut cov = [[0.0f32; 3]; 3];
        for &i in &idx { for r in 0..3 { for s in 0..3 { cov[r][s] += (px[i][r] - mu[c][r]) * (px[i][s] - mu[c][s]); } } }
        for r in 0..3 { for s in 0..3 { cov[r][s] /= idx.len() as f32; } cov[r][r] += 6.0; } // noise floor of about 2.5 Lab units
        if let Some(inv) = inv3(cov) { out.push(Cluster { mu: mu[c], inv, weight: wgt }); }
    }
    out.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(core::cmp::Ordering::Equal));
    out
}

fn otsu(d: &[f32], hi: f32) -> f32 {
    let nb = 64; let mut hist = vec![0.0f32; nb]; let mut tot = 0.0;
    for v in d { let b = ((v.min(hi) / hi) * (nb as f32 - 1.0)) as usize; hist[b] += 1.0; tot += 1.0; }
    let (mut sum, mut wb, mut sb, mut best, mut bt) = (0.0f32, 0.0f32, 0.0f32, -1.0f32, 0usize);
    for i in 0..nb { sum += i as f32 * hist[i]; }
    for i in 0..nb {
        wb += hist[i]; if wb == 0.0 { continue; } let wf = tot - wb; if wf == 0.0 { break; }
        sb += i as f32 * hist[i];
        let mb = sb / wb; let mf = (sum - sb) / wf; let between = wb * wf * (mb - mf) * (mb - mf);
        if between > best { best = between; bt = i; }
    }
    (bt as f32 + 1.0) / nb as f32 * hi
}

// The region (as a mask) most likely to be the paper in a foreground mask.
fn pick_region(mask: &[u8], w: usize, h: usize) -> Option<Vec<u8>> {
    let o = erode(&dilate(mask, w, h, 1), w, h, 1); // close small gaps (text, ruling)
    let o = dilate(&erode(&o, w, h, 1), w, h, 1);   // drop specks
    let (lab, stats) = label(&o, w, h);
    let (cx, cy) = (w as f64 / 2.0, h as f64 / 2.0); let diag = ((w * w + h * h) as f64).sqrt();
    let mut best = 0usize; let mut bs = 0.0f64;
    for i in 1..stats.len() {
        let (a, sx, sy) = stats[i]; if (a as f64) < 0.03 * (w * h) as f64 { continue; }
        let d = (((sx / a as f64) - cx).powi(2) + ((sy / a as f64) - cy).powi(2)).sqrt() / diag;
        let s = a as f64 * (1.0 - 1.2 * d); if s > bs { bs = s; best = i; }
    }
    if best == 0 { return None; }
    let mut r: Vec<u8> = lab.iter().map(|&l| if l as usize == best { 1 } else { 0 }).collect();
    fill_holes(&mut r, w, h);
    Some(r)
}

// A quad for a region: hull -> four sides -> each side refitted to the true boundary pixels.
fn quad_of_region(r: &[u8], w: usize, h: usize) -> Option<Quad> {
    let mut bpts: Vec<P> = Vec::new(); let mut inner: Vec<P> = Vec::new();
    for y in 0..h { for x in 0..w {
        if r[y * w + x] == 0 { continue; }
        let nb = |xx: i32, yy: i32| -> Option<bool> { if xx < 0 || yy < 0 || xx >= w as i32 || yy >= h as i32 { None } else { Some(r[yy as usize * w + xx as usize] != 0) } };
        let (xi, yi) = (x as i32, y as i32);
        let ns = [nb(xi - 1, yi), nb(xi + 1, yi), nb(xi, yi - 1), nb(xi, yi + 1)];
        let on_edge = ns.iter().any(|v| *v == Some(false));
        let on_frame = ns.iter().any(|v| v.is_none());
        if on_edge || on_frame { bpts.push([x as f32 + 0.5, y as f32 + 0.5]); }
        if on_edge { inner.push([x as f32 + 0.5, y as f32 + 0.5]); }
    } }
    if bpts.len() < 12 { return None; }
    let q0 = reduce_to_quad(convex_hull(bpts))?;
    // refit each side to the real boundary (not the frame) pixels close to it
    let mut lines: Vec<Line> = Vec::new();
    for k in 0..4 {
        let a = q0[k]; let b = q0[(k + 1) % 4]; let l0 = Line::through(a, b)?;
        let len = dist(a, b).max(1.0); let d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        let near: Vec<P> = inner.iter().cloned().filter(|p| {
            let t = (p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1];
            l0.signed(*p).abs() < 0.03 * len.max(20.0) + 2.0 && t > 0.05 * len && t < 0.95 * len
        }).collect();
        lines.push(if near.len() >= 8 { fit_line_robust(&near, 3).unwrap_or(l0) } else { l0 });
    }
    let mut q = q0;
    for k in 0..4 {
        let p = intersect(&lines[(k + 3) % 4], &lines[k]);
        if let Some(p) = p { if dist(p, q0[k]) < 0.08 * (w.max(h) as f32) { q[k] = p; } }
    }
    Some(q)
}

fn seg_candidates(wk: &Work) -> (Vec<Quad>, Vec<Vec<u8>>) {
    let (w, h) = (wk.w, wk.h); let n = w * h;
    let cl = ring_clusters(wk);
    if cl.is_empty() { return (vec![], vec![]); }
    let mut sets: Vec<Vec<usize>> = vec![vec![0]];
    if cl.len() > 1 { sets.push((0..cl.len()).collect()); }
    let mut acc = 0.0; let mut pre = Vec::new(); for (i, c) in cl.iter().enumerate() { pre.push(i); acc += c.weight; if acc >= 0.75 { break; } }
    if pre.len() != 1 && pre.len() != cl.len() { sets.push(pre); }
    let mut quads: Vec<Quad> = Vec::new(); let mut masks: Vec<Vec<u8>> = Vec::new();
    for set in sets {
        let mut d = vec![0.0f32; n];
        for i in 0..n {
            let p = [wk.l[i], wk.a[i], wk.b[i]]; let mut best = f32::MAX;
            for &c in &set {
                let cc = &cl[c]; let v = [p[0] - cc.mu[0], p[1] - cc.mu[1], p[2] - cc.mu[2]];
                let m = v[0] * (cc.inv[0][0] * v[0] + cc.inv[0][1] * v[1] + cc.inv[0][2] * v[2]) + v[1] * (cc.inv[1][0] * v[0] + cc.inv[1][1] * v[1] + cc.inv[1][2] * v[2]) + v[2] * (cc.inv[2][0] * v[0] + cc.inv[2][1] * v[1] + cc.inv[2][2] * v[2]);
                if m < best { best = m; }
            }
            d[i] = best.max(0.0).sqrt();
        }
        let t0 = otsu(&d, 40.0).max(3.5);
        for thr in [t0, 0.5 * t0].iter() {
            let m: Vec<u8> = d.iter().map(|v| if *v > thr.max(2.5) { 1 } else { 0 }).collect();
            if let Some(r) = pick_region(&m, w, h) {
                if masks.iter().any(|o| mask_iou(o, &r) > 0.985) { continue; }
                if let Some(q) = quad_of_region(&r, w, h) { quads.push(q); masks.push(r); }
            }
        }
    }
    (quads, masks)
}

// ---------- line candidates ----------
#[derive(Clone, Copy)]
struct HLine { theta: f32, rho: f32, votes: f32 }

// Hough transform over edge pixels (optionally only those inside `restrict`). Peaks are picked per orientation class,
// so a page full of ruling cannot crowd the page edges out.
fn hough_classes(wk: &Work, e: &Edges, restrict: Option<&[u8]>, thr: f32, per_class: usize) -> (Vec<HLine>, Vec<HLine>) {
    let (w, h) = (wk.w, wk.h);
    let nt = 360usize; let diag = ((w * w + h * h) as f32).sqrt(); let nr = (2.0 * diag) as usize + 3; let r0 = diag;
    let mut acc = vec![0.0f32; nt * nr];
    let cos: Vec<f32> = (0..nt).map(|i| (i as f32 * core::f32::consts::PI / nt as f32).cos()).collect();
    let sin: Vec<f32> = (0..nt).map(|i| (i as f32 * core::f32::consts::PI / nt as f32).sin()).collect();
    for y in 0..h { for x in 0..w {
        let i = y * w + x; let r = e.rel[i]; if r < thr { continue; }
        if let Some(m) = restrict { if m[i] == 0 { continue; } }
        let c = (e.ori[i] / core::f32::consts::PI * nt as f32).round() as i32;
        for dt in -6..=6 {
            let t = (c + dt).rem_euclid(nt as i32) as usize;
            let rho = x as f32 * cos[t] + y as f32 * sin[t]; let ri = (rho + r0).round() as usize;
            if ri < nr { acc[t * nr + ri] += r * (1.0 - dt.abs() as f32 / 8.0); }
        }
    } }
    let mut sm = acc.clone();
    for t in 0..nt { for r in 1..nr - 1 { sm[t * nr + r] = 0.25 * acc[t * nr + r - 1] + 0.5 * acc[t * nr + r] + 0.25 * acc[t * nr + r + 1]; } }
    let mut mx = 0.0f32; for v in sm.iter() { if *v > mx { mx = *v; } }
    let mut peaks: Vec<HLine> = Vec::new();
    if mx > 0.0 {
        let floor = 0.10 * mx;
        for t in 0..nt { for r in 1..nr - 1 {
            let v = sm[t * nr + r]; if v < floor { continue; }
            let tp = (t + nt - 1) % nt; let tn = (t + 1) % nt;
            if v >= sm[t * nr + r - 1] && v >= sm[t * nr + r + 1] && v >= sm[tp * nr + r] && v >= sm[tn * nr + r] {
                peaks.push(HLine { theta: t as f32 * core::f32::consts::PI / nt as f32, rho: r as f32 - r0, votes: v });
            }
        } }
    }
    peaks.sort_by(|a, b| b.votes.partial_cmp(&a.votes).unwrap_or(core::cmp::Ordering::Equal));
    let mut hz: Vec<HLine> = Vec::new(); let mut vt: Vec<HLine> = Vec::new();
    let same = |a: &HLine, b: &HLine| { let mut dt = (a.theta - b.theta).abs(); let mut dr = (a.rho - b.rho).abs();
        if dt > core::f32::consts::FRAC_PI_2 { dt = core::f32::consts::PI - dt; dr = (a.rho + b.rho).abs(); }
        dt < 3.0f32.to_radians() && dr < 6.0 };
    for p in peaks {
        let t = p.theta;
        let vertical = t < 40f32.to_radians() || t > 140f32.to_radians(); let horizontal = t > 50f32.to_radians() && t < 130f32.to_radians();
        if vertical { if vt.len() < per_class && !vt.iter().any(|o| same(o, &p)) { vt.push(p); } }
        else if horizontal { if hz.len() < per_class && !hz.iter().any(|o| same(o, &p)) { hz.push(p); } }
        if hz.len() >= per_class && vt.len() >= per_class { break; }
    }
    (hz, vt)
}

fn side_hit(e: &Edges, w: usize, h: usize, a: P, b: P) -> (f32, f32, f32) { // (hit fraction, mean strength, visible fraction)
    let len = dist(a, b); let n = ((len / 1.5) as usize).max(4);
    let d = [(b[0] - a[0]) / len.max(1e-3), (b[1] - a[1]) / len.max(1e-3)]; let nrm = [-d[1], d[0]];
    let na = nrm[1].atan2(nrm[0]);
    let (mut hit, mut vis, mut sum) = (0u32, 0u32, 0.0f32);
    for k in 0..n {
        let t = (k as f32 + 0.5) / n as f32; let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if p[0] < 2.0 || p[1] < 2.0 || p[0] > w as f32 - 3.0 || p[1] > h as f32 - 3.0 { continue; }
        vis += 1; let mut best = 0.0f32;
        for o in -1..=1 {
            let x = (p[0] + nrm[0] * o as f32).round() as usize; let y = (p[1] + nrm[1] * o as f32).round() as usize; let i = y * w + x;
            let mut da = (e.ori[i] - na.rem_euclid(core::f32::consts::PI)).abs(); if da > core::f32::consts::FRAC_PI_2 { da = core::f32::consts::PI - da; }
            let al = da.cos().powi(2); let v = e.rel[i] * al; if v > best { best = v; }
        }
        sum += best; if best > e.soft { hit += 1; }
    }
    if vis == 0 { return (0.0, 0.0, 0.0); }
    (hit as f32 / vis as f32, sum / vis as f32 / e.hard.max(1e-3), vis as f32 / n as f32)
}

fn quick_score(e: &Edges, w: usize, h: usize, q: &Quad) -> (f32, f32, u32) { // (min hit, mean hit, frame-ish sides)
    let (mut mn, mut sm, mut fr) = (1.0f32, 0.0f32, 0u32);
    for k in 0..4 {
        let (hit, _, vis) = side_hit(e, w, h, q[k], q[(k + 1) % 4]);
        if vis < 0.25 { fr += 1; mn = mn.min(0.0); continue; }
        mn = mn.min(hit); sm += hit;
    }
    (mn, sm / 4.0, fr)
}

// where a line crosses the frame
fn clip_line(l: &Line, w: f32, h: f32) -> Option<(P, P)> {
    let mut pts: Vec<P> = Vec::new();
    let edges = [Line { a: 0.0, b: 1.0, c: 0.0 }, Line { a: 0.0, b: 1.0, c: -(h - 1.0) }, Line { a: 1.0, b: 0.0, c: 0.0 }, Line { a: 1.0, b: 0.0, c: -(w - 1.0) }];
    for ed in edges.iter() { if let Some(p) = intersect(l, ed) { if p[0] >= -0.5 && p[0] <= w - 0.5 && p[1] >= -0.5 && p[1] <= h - 0.5 { pts.push(p); } } }
    if pts.len() < 2 { return None; }
    let mut best = (pts[0], pts[1]); let mut bd = 0.0;
    for i in 0..pts.len() { for j in i + 1..pts.len() { let d = dist(pts[i], pts[j]); if d > bd { bd = d; best = (pts[i], pts[j]); } } }
    Some(best)
}

pub static mut DEBUG_LINES: Vec<[f32; 3]> = Vec::new();
pub static mut DEBUG_MASK: Vec<u8> = Vec::new(); // seeded segmentation: 1 = classified paper, 2 = paper seed (for the training tools) // class (0 horizontal, 1 vertical), theta, rho; for the training tools

fn line_candidates(wk: &Work, e: &Edges, masks: &[Vec<u8>]) -> Vec<Quad> {
    let (w, h) = (wk.w as f32, wk.h as f32); let (wi, hi) = (wk.w, wk.h);
    let (mut hz_l, mut vt_l) = hough_classes(wk, e, None, e.soft, 16);
    // second pass: only edges close to the boundary of a segmentation region
    if !masks.is_empty() {
        let n = wi * hi; let mut near = vec![0u8; n];
        for m in masks {
            let er = erode(m, wi, hi, 1);
            let bd: Vec<u8> = (0..n).map(|i| if m[i] != 0 && er[i] == 0 { 1 } else { 0 }).collect();
            let d = dilate(&bd, wi, hi, 4); for i in 0..n { if d[i] != 0 { near[i] = 1; } }
        }
        let (h2, v2) = hough_classes(wk, e, Some(&near), e.soft, 10);
        hz_l.extend(h2); vt_l.extend(v2);
    }
    // keep lines that actually carry edges along their length
    let keep = |ls: Vec<HLine>| -> Vec<Line> {
        let mut out: Vec<Line> = Vec::new(); let mut seen: Vec<HLine> = Vec::new();
        for l in ls {
            let dup = seen.iter().any(|o| { let mut dt = (l.theta - o.theta).abs(); let mut dr = (l.rho - o.rho).abs();
                if dt > core::f32::consts::FRAC_PI_2 { dt = core::f32::consts::PI - dt; dr = (l.rho + o.rho).abs(); } dt < 2.5f32.to_radians() && dr < 4.0 });
            if dup { continue; }
            let line = Line::from_normal(l.theta, l.rho);
            if let Some((a, b)) = clip_line(&line, w, h) { let (hit, _, vis) = side_hit(e, wi, hi, a, b); if vis > 0.4 && hit >= 0.25 { out.push(line); seen.push(l); } }
        }
        out
    };
    let mut hz = keep(hz_l); let mut vt = keep(vt_l);
    hz.truncate(20); vt.truncate(20);
    let nreal_h = hz.len(); let nreal_v = vt.len();
    unsafe { let d = &mut *core::ptr::addr_of_mut!(DEBUG_LINES); d.clear();
        for l in hz.iter() { d.push([0.0, l.b.atan2(l.a).rem_euclid(core::f32::consts::PI), -l.c]); }
        for l in vt.iter() { d.push([1.0, l.b.atan2(l.a).rem_euclid(core::f32::consts::PI), -l.c]); } }
    hz.push(Line { a: 0.0, b: 1.0, c: 0.0 }); hz.push(Line { a: 0.0, b: 1.0, c: -(h - 1.0) });
    vt.push(Line { a: 1.0, b: 0.0, c: 0.0 }); vt.push(Line { a: 1.0, b: 0.0, c: -(w - 1.0) });
    let mut out: Vec<(f32, Quad)> = Vec::new();
    for i in 0..hz.len() { for j in i + 1..hz.len() { for k in 0..vt.len() { for m in k + 1..vt.len() {
        let frame_h = (i >= nreal_h) as u32 + (j >= nreal_h) as u32; let frame_v = (k >= nreal_v) as u32 + (m >= nreal_v) as u32;
        if frame_h + frame_v > 2 { continue; }
        let pts = [intersect(&hz[i], &vt[k]), intersect(&hz[i], &vt[m]), intersect(&hz[j], &vt[m]), intersect(&hz[j], &vt[k])];
        if pts.iter().any(|p| p.is_none()) { continue; }
        let p: [P; 4] = [pts[0].unwrap(), pts[1].unwrap(), pts[2].unwrap(), pts[3].unwrap()];
        let q = order4(p);
        if !is_convex(&q) { continue; }
        if q.iter().any(|v| v[0] < -0.25 * w || v[0] > 1.25 * w || v[1] < -0.25 * h || v[1] > 1.25 * h) { continue; }
        let ar = poly_area(&q) / (w * h); if ar < 0.05 || ar > 1.3 { continue; }
        let mut ok = true;
        for t in 0..4 { let a = q[t]; let b = q[(t + 1) % 4]; let c = q[(t + 2) % 4];
            let (v1, v2) = ([a[0] - b[0], a[1] - b[1]], [c[0] - b[0], c[1] - b[1]]);
            let cs = (v1[0] * v2[0] + v1[1] * v2[1]) / ((v1[0].hypot(v1[1])) * (v2[0].hypot(v2[1])) + 1e-6);
            if cs.abs() > 0.82 { ok = false; break; } }
        if !ok { continue; }
        let (mn, sm, fr) = quick_score(e, wk.w, wk.h, &q);
        out.push((0.5 * mn + 0.5 * sm - 0.12 * fr as f32, q));
    } } } }
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(core::cmp::Ordering::Equal));
    // second, stronger pre-score on the best 120: edge support plus the colour step across each side
    let mut scored: Vec<(f32, Quad)> = Vec::new();
    for (qs, q) in out.into_iter().filter(|x| x.0 > 0.12).take(120) {
        let c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4.0, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4.0];
        let (mut mn, mut sm, mut fr) = (f32::MAX, 0.0f32, 0u32);
        for k in 0..4 { let o = side_objective(wk, e, q[k], q[(k + 1) % 4], c); if o == 0.0 { fr += 1; continue; } mn = mn.min(o); sm += o; }
        let valid = 4 - fr; if valid == 0 { continue; }
        scored.push((0.5 * mn.min(2.0) + 0.5 * sm / valid as f32 - 0.2 * fr as f32 + 0.1 * qs, q));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(core::cmp::Ordering::Equal));
    scored.into_iter().take(24).map(|x| x.1).collect()
}
// ---------- features ----------
fn aspect_raw(q: &Quad, w: f32, h: f32) -> Option<f32> { // Zhang & He single-view rectangle geometry; returns width/height
    let (u0, v0) = (w / 2.0, h / 2.0);
    let m1 = [q[0][0], q[0][1], 1.0]; let m2 = [q[1][0], q[1][1], 1.0]; let m4 = [q[2][0], q[2][1], 1.0]; let m3 = [q[3][0], q[3][1], 1.0];
    let cross = |a: [f32; 3], b: [f32; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3); let k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
    if !k2.is_finite() || !k3.is_finite() { return None; }
    let n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]]; let n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
    let mut f = f32::NAN;
    if n2[2].abs() > 1e-9 && n3[2].abs() > 1e-9 {
        let f2 = -((n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + n2[2] * n3[2] * u0 * u0) + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + n2[2] * n3[2] * v0 * v0)) / (n2[2] * n3[2]);
        if f2 > 0.0 { f = f2.sqrt(); }
    }
    let mx = w.max(h); if !(f > 0.3 * mx && f < 5.0 * mx) { f = 0.8 * mx; }
    let ai = |v: [f32; 3]| [(v[0] - u0 * v[2]) / f, (v[1] - v0 * v[2]) / f, v[2]];
    let a2 = ai(n2); let a3 = ai(n3); let w2 = dot(a2, a2); let h2 = dot(a3, a3);
    if w2 <= 0.0 || h2 <= 0.0 { return None; }
    Some((w2 / h2).sqrt())
}

fn aspect_ratio(q: &Quad, w: f32, h: f32) -> Option<f32> { aspect_raw(q, w, h).map(|r| r.max(1.0 / r)) }

// (long/short ratio, whether the page is wider than tall in the photo)
pub fn aspect_ratio_full(q: &Quad, w: f32, h: f32) -> Option<(f32, bool)> { aspect_raw(q, w, h).map(|r| (r.max(1.0 / r), r >= 1.0)) }

fn shrink(q: &Quad, f: f32) -> Quad {
    let c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4.0, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4.0];
    let mut o = *q; for i in 0..4 { o[i] = [c[0] + (q[i][0] - c[0]) * f, c[1] + (q[i][1] - c[1]) * f]; } o
}

pub fn cheap_features(wk: &Work, e: &Edges, q: &Quad) -> [f32; NF] {
    let (w, h) = (wk.w, wk.h); let n = w * h;
    let mut f = [0.0f32; NF];
    // sides
    let mut hits = [0.0f32; 4]; let mut str_ = [0.0f32; 4]; let mut valid = [true; 4]; let mut frame = 0u32;
    for k in 0..4 {
        let (hit, st, vis) = side_hit(e, w, h, q[k], q[(k + 1) % 4]);
        if vis < 0.3 { valid[k] = false; frame += 1; } hits[k] = hit; str_[k] = st;
    }
    let vh: Vec<f32> = (0..4).filter(|&k| valid[k]).map(|k| hits[k]).collect();
    f[0] = if vh.is_empty() { 0.0 } else { vh.iter().cloned().fold(1.0, f32::min) };
    f[1] = if vh.is_empty() { 0.0 } else { vh.iter().sum::<f32>() / vh.len() as f32 };
    f[2] = { let v: Vec<f32> = (0..4).filter(|&k| valid[k]).map(|k| str_[k]).collect(); if v.is_empty() { 0.0 } else { (v.iter().sum::<f32>() / v.len() as f32).min(3.0) / 3.0 } };
    // colour step across each side
    let mut cs: Vec<f32> = Vec::new();
    for k in 0..4 {
        if !valid[k] { continue; }
        let a = q[k]; let b = q[(k + 1) % 4]; let len = dist(a, b).max(1.0); let d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        let c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4.0, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4.0];
        let mut nrm = [-d[1], d[0]]; if ((a[0] + b[0]) / 2.0 - c[0]) * nrm[0] + ((a[1] + b[1]) / 2.0 - c[1]) * nrm[1] < 0.0 { nrm = [-nrm[0], -nrm[1]]; }
        let mut ds: Vec<f32> = Vec::new(); let ns = ((len * 0.8 / 3.0) as usize).max(4);
        for s in 0..ns {
            let t = 0.1 + 0.8 * (s as f32 + 0.5) / ns as f32; let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            let (ix, iy, ox, oy) = (p[0] - nrm[0] * 3.5, p[1] - nrm[1] * 3.5, p[0] + nrm[0] * 3.5, p[1] + nrm[1] * 3.5);
            if ix < 1.0 || iy < 1.0 || ix >= w as f32 - 1.0 || iy >= h as f32 - 1.0 || ox < 1.0 || oy < 1.0 || ox >= w as f32 - 1.0 || oy >= h as f32 - 1.0 { continue; }
            let i1 = iy as usize * w + ix as usize; let i2 = oy as usize * w + ox as usize;
            ds.push(((wk.l[i1] - wk.l[i2]).powi(2) + (wk.a[i1] - wk.a[i2]).powi(2) + (wk.b[i1] - wk.b[i2]).powi(2)).sqrt());
        }
        if ds.len() >= 5 { cs.push((1.0 + median(&ds)).ln() / 4.0); }
    }
    f[3] = if cs.is_empty() { 0.0 } else { cs.iter().cloned().fold(10.0, f32::min) };
    f[4] = if cs.is_empty() { 0.0 } else { cs.iter().sum::<f32>() / cs.len() as f32 };
    // shape
    let ar = poly_area(q) / (w * h) as f32;
    f[8] = ar.min(1.0);
    f[9] = frame as f32;
    if frame == 0 { if let Some(r) = aspect_ratio(&shrink(q, 1.0), w as f32 / wk.s * wk.s, h as f32) {
        let mut m = 1.0f32; for pr in PAPER_RATIOS.iter() { m = m.min((r - pr).abs() / pr); } f[7] = (1.0 - m / 0.15).max(0.0);
    } }
    // overshoot: strong aligned edges continuing past the corners suggest the quad is too small
    let mut over = Vec::new();
    for k in 0..4 {
        let a = q[k]; let b = q[(k + 1) % 4]; let len = dist(a, b).max(1.0); let d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        for (p, sg) in [(a, -1.0f32), (b, 1.0f32)].iter() {
            let s = [p[0] + sg * d[0] * 4.0, p[1] + sg * d[1] * 4.0]; let t = [p[0] + sg * d[0] * 0.15 * len, p[1] + sg * d[1] * 0.15 * len];
            let (hit, _, vis) = side_hit(e, w, h, s, t); if vis > 0.5 { over.push(hit); }
        }
    }
    f[10] = if over.is_empty() { 0.0 } else { over.iter().sum::<f32>() / over.len() as f32 };
    f
}

pub fn features(wk: &Work, e: &Edges, masks: &[Vec<u8>], q: &Quad) -> [f32; NF] { features_from(wk, e, masks, q, cheap_features(wk, e, q)) }

pub fn features_from(wk: &Work, e: &Edges, masks: &[Vec<u8>], q: &Quad, cheap: [f32; NF]) -> [f32; NF] {
    let (w, h) = (wk.w, wk.h); let n = w * h;
    let mut f = cheap;
    // inside band against outside band
    let mut mi = vec![0u8; n]; let mut mq = vec![0u8; n]; let mut mo = vec![0u8; n];
    fill_poly(&mut mi, w, h, &shrink(q, 0.88)); fill_poly(&mut mq, w, h, q); fill_poly(&mut mo, w, h, &shrink(q, 1.12));
    let (mut li, mut ai, mut bi, mut lo, mut ao, mut bo): (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) = Default::default();
    for i in 0..n {
        let inq = mq[i] != 0;
        if inq && mi[i] == 0 { li.push(wk.l[i]); ai.push(wk.a[i]); bi.push(wk.b[i]); }
        else if !inq && mo[i] != 0 { lo.push(wk.l[i]); ao.push(wk.a[i]); bo.push(wk.b[i]); }
    }
    if li.len() >= 50 && lo.len() >= 50 {
        let (mli, mai, mbi, mlo, mao, mbo) = (median(&li), median(&ai), median(&bi), median(&lo), median(&ao), median(&bo));
        let sep = ((mli - mlo).powi(2) + (mai - mao).powi(2) + (mbi - mbo).powi(2)).sqrt();
        let spread = |v: &[f32], m: f32| median(&v.iter().map(|x| (x - m).abs()).collect::<Vec<f32>>()) * 1.4826;
        let sp = (spread(&li, mli) + spread(&lo, mlo) + spread(&ai, mai) + spread(&ao, mao) + 2.0) / 3.0;
        f[5] = (sep / (sp * 3.0 + 4.0)).min(3.0) / 3.0;
        f[11] = clampf((mli - mlo) / 60.0, -1.0, 1.0);
        let ci = (mai * mai + mbi * mbi).sqrt(); let co = (mao * mao + mbo * mbo).sqrt(); f[12] = clampf((co - ci) / 30.0, -1.0, 1.0);
    }
    // agreement with the segmentation masks
    let mut best = 0.0f32; for m in masks { let v = mask_iou(&mq, m); if v > best { best = v; } }
    f[6] = best;
    f[13] = if f[6] > 0.9 { 1.0 } else { 0.0 };
    // region agreement: how much of the segmented paper the quad covers (recall), how much of the quad is segmented paper (precision)
    let qa = mq.iter().filter(|v| **v != 0).count().max(1) as f32;
    let (mut rec, mut prec, mut outp) = (0.0f32, 0.0f32, 0.0f32);
    for (k, m) in masks.iter().enumerate() {
        let (mut inter, mut ma) = (0u32, 0u32); for i in 0..n { if m[i] != 0 { ma += 1; if mq[i] != 0 { inter += 1; } } }
        let r = inter as f32 / ma.max(1) as f32; let p = inter as f32 / qa;
        if r > rec { rec = r; } if p > prec { prec = p; }
        if k == 0 { let (mut ob, mut op) = (0u32, 0u32); for i in 0..n { if mo[i] != 0 && mq[i] == 0 { ob += 1; if m[i] != 0 { op += 1; } } } outp = op as f32 / ob.max(1) as f32; }
    }
    f[14] = rec; f[15] = prec; f[16] = outp;
    // ink (text and ruling) lives on paper: it should be inside the quad, not just outside it
    let (mut ii, mut ni, mut io, mut no) = (0u32, 0u32, 0u32, 0u32);
    for i in 0..n { if mi[i] != 0 { ni += 1; if wk.ink[i] != 0 { ii += 1; } } else if mo[i] != 0 && mq[i] == 0 { no += 1; if wk.ink[i] != 0 { io += 1; } } }
    let din = ii as f32 / ni.max(1) as f32; let dout = io as f32 / no.max(1) as f32;
    f[17] = (din * 10.0).min(1.0); f[18] = (dout / (din + 0.01)).min(2.0) * if no > 40 { 1.0 } else { 0.0 };
    f
}

pub fn score_of(f: &[f32; NF]) -> f32 {
    let w = unsafe { &*core::ptr::addr_of!(WEIGHTS) };
    let mut s = w[NF]; for i in 0..NF { s += w[i] * f[i]; } s
}

fn refine_working(e: &Edges, w: usize, h: usize, q: &Quad) -> Quad {
    let mut lines: Vec<Line> = Vec::new();
    for k in 0..4 {
        let a = q[k]; let b = q[(k + 1) % 4]; let l0 = match Line::through(a, b) { Some(l) => l, None => return *q };
        let len = dist(a, b).max(1.0); let d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len]; let nrm = [l0.a, l0.b];
        let na = nrm[1].atan2(nrm[0]).rem_euclid(core::f32::consts::PI);
        let mut pts: Vec<P> = Vec::new(); let ns = (len / 1.5) as usize;
        for s in 0..ns {
            let t = 0.06 + 0.88 * (s as f32 + 0.5) / ns as f32; let p = [a[0] + d[0] * len * t, a[1] + d[1] * len * t];
            let (mut bv, mut bo) = (0.0f32, 0i32);
            for o in -3..=3 { let x = (p[0] + nrm[0] * o as f32).round(); let y = (p[1] + nrm[1] * o as f32).round();
                if x < 1.0 || y < 1.0 || x >= w as f32 - 1.0 || y >= h as f32 - 1.0 { continue; }
                let i = y as usize * w + x as usize; let mut da = (e.ori[i] - na).abs(); if da > core::f32::consts::FRAC_PI_2 { da = core::f32::consts::PI - da; }
                let v = e.rel[i] * da.cos().powi(2); if v > bv { bv = v; bo = o; } }
            if bv > e.soft { pts.push([p[0] + nrm[0] * bo as f32, p[1] + nrm[1] * bo as f32]); }
        }
        lines.push(if pts.len() >= 8 { fit_line_robust(&pts, 3).unwrap_or(l0) } else { l0 });
    }
    let mut out = *q;
    for k in 0..4 { if let Some(p) = intersect(&lines[(k + 3) % 4], &lines[k]) { if dist(p, q[k]) < 6.0 { out[k] = p; } } }
    out
}

// ---------- local search: let each side find the best nearby line ----------
// Colour step across a side: how different the paper just inside is from the table just outside (0..1).
fn side_step(wk: &Work, a: P, b: P, centre: P) -> f32 {
    let (w, h) = (wk.w, wk.h); let len = dist(a, b).max(1.0); let d = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let mut nrm = [-d[1], d[0]]; if ((a[0] + b[0]) / 2.0 - centre[0]) * nrm[0] + ((a[1] + b[1]) / 2.0 - centre[1]) * nrm[1] < 0.0 { nrm = [-nrm[0], -nrm[1]]; }
    let ns = ((len * 0.8 / 4.0) as usize).clamp(4, 40); let mut ds: Vec<f32> = Vec::new();
    for s in 0..ns {
        let t = 0.1 + 0.8 * (s as f32 + 0.5) / ns as f32; let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        let (ix, iy, ox, oy) = (p[0] - nrm[0] * 3.0, p[1] - nrm[1] * 3.0, p[0] + nrm[0] * 3.0, p[1] + nrm[1] * 3.0);
        if ix < 1.0 || iy < 1.0 || ix >= w as f32 - 1.0 || iy >= h as f32 - 1.0 || ox < 1.0 || oy < 1.0 || ox >= w as f32 - 1.0 || oy >= h as f32 - 1.0 { continue; }
        let i1 = iy as usize * w + ix as usize; let i2 = oy as usize * w + ox as usize;
        ds.push(((wk.l[i1] - wk.l[i2]).powi(2) + (wk.a[i1] - wk.a[i2]).powi(2) + (wk.b[i1] - wk.b[i2]).powi(2)).sqrt());
    }
    if ds.len() < 4 { return 0.0; }
    ((1.0 + median(&ds)).ln() / 4.0).min(1.0)
}

fn side_objective(wk: &Work, e: &Edges, a: P, b: P, centre: P) -> f32 {
    let (hit, st, vis) = side_hit(e, wk.w, wk.h, a, b);
    if vis < 0.3 { return 0.0; } // a side outside the frame cannot be judged
    hit + 0.25 * st.min(2.0) + 0.8 * side_step(wk, a, b, centre)
}

fn improve_quad(wk: &Work, e: &Edges, q0: &Quad) -> Quad {
    let mut q = *q0;
    for _round in 0..2 {
        let mut changed = false;
        for k in 0..4 {
            let c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4.0, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4.0];
            let l_prev = match Line::through(q[(k + 3) % 4], q[k]) { Some(l) => l, None => continue };
            let l_next = match Line::through(q[(k + 1) % 4], q[(k + 2) % 4]) { Some(l) => l, None => continue };
            let cur = match Line::through(q[k], q[(k + 1) % 4]) { Some(l) => l, None => continue };
            let mut best = (side_objective(wk, e, q[k], q[(k + 1) % 4], c), q[k], q[(k + 1) % 4]);
            let th0 = cur.b.atan2(cur.a); let rho0 = -cur.c;
            for dti in (-6i32..=6).step_by(2) { for dri in (-12i32..=12).step_by(3) {
                if dti == 0 && dri == 0 { continue; }
                let th = th0 + (dti as f32).to_radians(); let rho = rho0 + dri as f32;
                let l = Line::from_normal(th, rho);
                let (a, b) = match (intersect(&l_prev, &l), intersect(&l, &l_next)) { (Some(a), Some(b)) => (a, b), _ => continue };
                if dist(a, q[k]) > 40.0 || dist(b, q[(k + 1) % 4]) > 40.0 { continue; }
                let mut tq = q; tq[k] = a; tq[(k + 1) % 4] = b;
                if !is_convex(&tq) { continue; }
                let pen = 0.01 * (dti.abs() as f32 + dri.abs() as f32 * 0.5); // prefer small moves
                let o = side_objective(wk, e, a, b, c) - pen;
                if o > best.0 + 0.02 { best = (o, a, b); }
            } }
            if best.1 != q[k] || best.2 != q[(k + 1) % 4] { q[k] = best.1; q[(k + 1) % 4] = best.2; changed = true; }
        }
        if !changed { break; }
    }
    q
}
// ---------- text-anchored candidates (for faint paper edges, e.g. white paper on a pale table) ----------
// Writing is easy to find even when the paper edge is not. The text-dense blob gives a rectangle that lies inside the page;
// each side is then pushed outward to the offset where the colour step across it, integrated along its whole length, is strongest.
fn min_area_rect(pts: &[P]) -> Option<Quad> {
    let hull = convex_hull(pts.to_vec()); if hull.len() < 3 { return None; }
    let (mut best, mut ba) = (None, f32::MAX);
    for deg in 0..90 {
        let a = (deg as f32).to_radians(); let (c, s) = (a.cos(), a.sin());
        let (mut x0, mut x1, mut y0, mut y1) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
        for p in hull.iter() { let u = p[0] * c + p[1] * s; let v = -p[0] * s + p[1] * c; x0 = x0.min(u); x1 = x1.max(u); y0 = y0.min(v); y1 = y1.max(v); }
        let ar = (x1 - x0) * (y1 - y0);
        if ar < ba { ba = ar; let back = |u: f32, v: f32| [u * c - v * s, u * s + v * c]; best = Some(order4([back(x0, y0), back(x1, y0), back(x1, y1), back(x0, y1)])); }
    }
    best
}

fn push_side(wk: &Work, e: &Edges, q: &Quad, k: usize) -> Quad {
    // move side k (from q[k] to q[k+1]) outward and keep the offset with the best objective
    let l = match Line::through(q[k], q[(k + 1) % 4]) { Some(l) => l, None => return *q };
    let lp = match Line::through(q[(k + 3) % 4], q[k]) { Some(l) => l, None => return *q };
    let ln = match Line::through(q[(k + 1) % 4], q[(k + 2) % 4]) { Some(l) => l, None => return *q };
    let c = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4.0, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4.0];
    // the normal pointing away from the centre
    let sgn = if l.signed(c) > 0.0 { -1.0f32 } else { 1.0 };
    let size = dist(q[k], q[(k + 1) % 4]).max(dist(q[(k + 1) % 4], q[(k + 2) % 4]));
    let maxd = (0.35 * size).min(0.25 * wk.w.max(wk.h) as f32);
    // objective at every offset, then the NEAREST peak that stands clearly above the side's own baseline
    let mut os: Vec<f32> = Vec::new(); let mut qs: Vec<Option<Quad>> = Vec::new(); let mut ds: Vec<f32> = Vec::new();
    let mind = -(0.12 * size).min(14.0);
    let mut d = mind;
    while d <= maxd {
        let nl = Line { a: l.a, b: l.b, c: l.c - sgn * d };
        let mut item: Option<Quad> = None; let mut o = 0.0f32;
        if let (Some(a), Some(b)) = (intersect(&lp, &nl), intersect(&nl, &ln)) {
            let mut tq = *q; tq[k] = a; tq[(k + 1) % 4] = b;
            if is_convex(&tq) { o = side_objective(wk, e, a, b, c); item = Some(tq); }
        }
        os.push(o); qs.push(item); ds.push(d); d += 1.0;
    }
    if os.len() < 6 { return *q; }
    let base = median(&os); let mad = median(&os.iter().map(|v| (v - base).abs()).collect::<Vec<f32>>()) * 1.4826 + 0.02;
    let mut best: Option<(f32, usize)> = None; // (|offset|, index) of the nearest clear peak
    for i in 2..os.len() - 2 {
        let v = os[i];
        if v > base + 3.0 * mad + 0.12 && v >= os[i - 1] && v >= os[i + 1] && v >= os[i - 2] && v >= os[i + 2] && qs[i].is_some() {
            let a = ds[i].abs(); if best.map_or(true, |b| a < b.0) { best = Some((a, i)); }
        }
    }
    match best { Some((_, i)) => qs[i].unwrap(), None => *q }
}
fn text_blobs(wk: &Work, e: &Edges) -> Vec<Vec<P>> {
    let (w, h) = (wk.w, wk.h); let n = w * h;
    let en = box_blur(&e.mag, w, h, 9);
    let t = otsu(&en, percentile(&en, 98.0).max(1.0));
    let m: Vec<u8> = en.iter().map(|v| if *v > t { 1 } else { 0 }).collect();
    let m = dilate(&m, w, h, 3);
    let (lab, stats) = label(&m, w, h);
    let mut comps: Vec<(f64, usize)> = Vec::new();
    for i in 1..stats.len() { let (a, sx, sy) = stats[i]; if (a as f64) < 0.01 * n as f64 { continue; }
        let d = (((sx / a as f64) - w as f64 / 2.0).powi(2) + ((sy / a as f64) - h as f64 / 2.0).powi(2)).sqrt() / (w.max(h) as f64);
        comps.push((a as f64 * (1.0 - d), i)); }
    comps.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(core::cmp::Ordering::Equal));
    let mut out = Vec::new();
    for (_, id) in comps.into_iter().take(2) {
        out.push((0..n).filter(|&i| lab[i] as usize == id).step_by(3).map(|i| [(i % w) as f32 + 0.5, (i / w) as f32 + 0.5]).collect());
    }
    out
}

fn text_candidates(wk: &Work, e: &Edges, blobs: &[Vec<P>]) -> Vec<(Quad, Quad)> {
    let mut out = Vec::new();
    for pts in blobs {
        if let Some(r) = min_area_rect(pts) {
            let mut q = r;
            for k in 0..4 { q = push_side(wk, e, &q, k); }
            out.push((r, q));
        }
    }
    out
}

// Seeded segmentation: the text is a sample of paper, the frame border is a sample of table. Every pixel is classified by which model it is
// closer to, and the region that grows from the text becomes a quadrilateral. This is what finds white paper on a pale table.
fn seeded_candidates(wk: &Work, blobs: &[Vec<P>]) -> Vec<(Quad, Vec<u8>)> {
    let (w, h) = (wk.w, wk.h); let n = w * h;
    let table = ring_clusters(wk); if table.is_empty() { return vec![]; }
    let mut out = Vec::new();
    for pts in blobs.iter().take(1) {
        let hull = convex_hull(pts.clone()); if hull.len() < 3 { continue; }
        let mut seed = vec![0u8; n]; fill_poly(&mut seed, w, h, &hull);
        let core = erode(&seed, w, h, 5); // the text mask is dilated, so its edge may already be table: sample paper from the core only
        if core.iter().filter(|v| **v != 0).count() > 200 { seed = core; }
        let ls: Vec<f32> = (0..n).filter(|&i| seed[i] != 0).map(|i| wk.l[i]).collect(); if ls.len() < 60 { continue; }
        let lm = median(&ls);
        let idx: Vec<usize> = (0..n).filter(|&i| seed[i] != 0 && wk.l[i] >= lm).collect(); // the bright half of the text area: paper between the strokes
        let cnt = idx.len() as f32;
        let mut mu = [0.0f32; 3]; for &i in &idx { mu[0] += wk.l[i]; mu[1] += wk.a[i]; mu[2] += wk.b[i]; } for k in 0..3 { mu[k] /= cnt; }
        let mut cov = [[0.0f32; 3]; 3];
        for &i in &idx { let v = [wk.l[i] - mu[0], wk.a[i] - mu[1], wk.b[i] - mu[2]]; for r in 0..3 { for c in 0..3 { cov[r][c] += v[r] * v[c]; } } }
        for r in 0..3 { for c in 0..3 { cov[r][c] /= cnt; } cov[r][r] += 6.0; }
        let inv = match inv3(cov) { Some(i) => i, None => continue };
        let mut m = vec![0u8; n];
        for i in 0..n {
            let p = [wk.l[i], wk.a[i], wk.b[i]];
            let maha = |mu: &[f32; 3], inv: &[[f32; 3]; 3]| { let v = [p[0] - mu[0], p[1] - mu[1], p[2] - mu[2]];
                v[0] * (inv[0][0] * v[0] + inv[0][1] * v[1] + inv[0][2] * v[2]) + v[1] * (inv[1][0] * v[0] + inv[1][1] * v[1] + inv[1][2] * v[2]) + v[2] * (inv[2][0] * v[0] + inv[2][1] * v[1] + inv[2][2] * v[2]) };
            let dp = maha(&mu, &inv); let mut dt = f32::MAX; for c in table.iter() { let v = maha(&c.mu, &c.inv); if v < dt { dt = v; } }
            if dp < dt { m[i] = 1; }
        }
        unsafe { let d = &mut *core::ptr::addr_of_mut!(DEBUG_MASK); d.clear(); d.extend((0..n).map(|i| if seed[i] != 0 { 2 } else { m[i] })); }
        let m = dilate(&erode(&dilate(&m, w, h, 1), w, h, 1), w, h, 0); // close small gaps
        let (lab, stats) = label(&m, w, h);
        let mut best = 0usize; let mut bo = 0u32; let mut counts = vec![0u32; stats.len()];
        for i in 0..n { if seed[i] != 0 && lab[i] != 0 { counts[lab[i] as usize] += 1; } }
        for k in 1..stats.len() { if counts[k] > bo { bo = counts[k]; best = k; } }
        if best == 0 { continue; }
        let mut region: Vec<u8> = lab.iter().map(|&l| if l as usize == best { 1 } else { 0 }).collect();
        fill_holes(&mut region, w, h);
        let region = erode(&dilate(&region, w, h, 1), w, h, 1);
        if let Some(q) = quad_of_region(&region, w, h) { out.push((q, region)); }
    }
    out
}
// ---------- hill climbing on the verifier ----------
// The page's weak sides often have no Hough peak. The score itself says where they are: move the corners to maximise it.
fn cheap_score(wk: &Work, e: &Edges, q: &Quad) -> f32 { score_of(&cheap_features(wk, e, q)) }

fn climb(wk: &Work, e: &Edges, q0: &Quad) -> Quad {
    let (w, h) = (wk.w as f32, wk.h as f32);
    let mut best = *q0; let mut bs = cheap_score(wk, e, &best);
    const DIRS: [(f32, f32); 8] = [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0), (0.7, 0.7), (-0.7, 0.7), (0.7, -0.7), (-0.7, -0.7)];
    for &s in [5.0f32, 2.0].iter() {
        for _ in 0..3 {
            let mut improved = false;
            for k in 0..4 { for &(dx, dy) in DIRS.iter() {
                let mut q = best; q[k] = [q[k][0] + dx * s, q[k][1] + dy * s];
                if q[k][0] < -0.3 * w || q[k][0] > 1.3 * w || q[k][1] < -0.3 * h || q[k][1] > 1.3 * h { continue; }
                if !is_convex(&q) { continue; }
                let sc = cheap_score(wk, e, &q);
                if sc > bs + 1e-3 { best = q; bs = sc; improved = true; }
            } }
            if !improved { break; }
        }
    }
    best
}
// for the timing tools: stop after stage 1 (work copy), 2 (edges), 3 (segmentation), 4 (lines), 5 (text), 6 (climbing)
pub static mut STAGE: i32 = 99;

fn stub(wk: Work, e: Edges, masks: Vec<Vec<u8>>) -> Detection {
    let (s, ww, wh) = (wk.s, wk.w, wk.h);
    Detection { conf: 0.0, wk, edges: e, masks, found: false, qw: [[0.0; 2]; 4], src: 0, score: 0.0, margin: 0.0, frame_sides: 0, cands: vec![Cand { q: [[0.0; 2]; 4], src: 0, f: [0.0; NF], score: 0.0 }], s, ww, wh }
}

pub fn detect(rgba: &[u8], w: usize, h: usize, wl: f32) -> Detection {
    let stage = unsafe { *core::ptr::addr_of!(STAGE) };
    let wk = make_work(rgba, w, h, wl);
    if stage == 1 { let e = Edges { mag: vec![], ori: vec![], rel: vec![], hard: 1.0, soft: 0.6 }; return stub(wk, e, vec![]); }
    let e = edges(&wk);
    if stage == 2 { return stub(wk, e, vec![]); }
    let (segq, mut masks) = seg_candidates(&wk);
    if stage == 3 { return stub(wk, e, masks); }
    let mut quads: Vec<(Quad, u8)> = Vec::new();
    for q in segq { quads.push((q, 1)); }
    for q in line_candidates(&wk, &e, &masks) { quads.push((q, 2)); }
    if stage == 4 { return stub(wk, e, masks); }
    let blobs = text_blobs(&wk, &e);
    for (raw, q) in text_candidates(&wk, &e, &blobs) { quads.push((raw, 6)); quads.push((q, 5)); }
    for (q, region) in seeded_candidates(&wk, &blobs) { quads.push((q, 7)); masks.push(region); }
    if stage == 5 { return stub(wk, e, masks); }
    let (ww, wh) = (wk.w as f32, wk.h as f32);
    quads.push(([[1.0, 1.0], [ww - 2.0, 1.0], [ww - 2.0, wh - 2.0], [1.0, wh - 2.0]], 3));
    // seeds ranked by the cheap score; the best few are hill-climbed and the climbed versions join the candidates
    let mut seeds: Vec<(f32, Quad)> = quads.iter().map(|(q, _)| (cheap_score(&wk, &e, q), *q)).collect();
    seeds.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(core::cmp::Ordering::Equal));
    let climbed: Vec<(Quad, u8)> = seeds.iter().take(3).map(|(_, q)| (climb(&wk, &e, q), 4u8)).collect();
    quads.extend(climbed);
    if stage == 6 { return stub(wk, e, masks); }
    // drop near-duplicates (same corners within 3 px)
    let mut uniq: Vec<(Quad, u8)> = Vec::new();
    for (q, s) in quads { if !uniq.iter().any(|(u, _)| (0..4).all(|i| dist(u[i], q[i]) < 3.0)) { uniq.push((q, s)); } }
    // cheap features for everything; the expensive region features only for the best candidates, the segmentation quads and the frame
    let mut pre: Vec<(Quad, u8, [f32; NF], f32)> = Vec::new();
    for (q, s) in uniq {
        let q = if s == 3 || s == 4 || s == 6 || s == 7 { q } else { refine_working(&e, wk.w, wk.h, &q) };
        let cf = cheap_features(&wk, &e, &q); let cs = score_of(&cf);
        pre.push((q, s, cf, cs));
    }
    let mut order: Vec<usize> = (0..pre.len()).collect();
    order.sort_by(|&i, &j| pre[j].3.partial_cmp(&pre[i].3).unwrap_or(core::cmp::Ordering::Equal));
    let mut full = vec![false; pre.len()];
    for (rank, &i) in order.iter().enumerate() { if rank < 12 || pre[i].1 == 1 || pre[i].1 == 3 { full[i] = true; } }
    let mut cands: Vec<Cand> = Vec::new();
    for (i, (q, s, cf, _)) in pre.into_iter().enumerate() {
        if !full[i] { continue; }
        let f = features_from(&wk, &e, &masks, &q, cf); let sc = score_of(&f);
        cands.push(Cand { q, src: s, f, score: sc });
    }    cands.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(core::cmp::Ordering::Equal));
    let best = cands[0].clone();
    let margin = if cands.len() > 1 { best.score - cands[1].score } else { best.score };
    let conf = { let c = unsafe { &*core::ptr::addr_of!(CONF) }; let mut z = c[NF + 3];
        for i in 0..NF { z += c[i] * best.f[i]; } z += c[NF] * best.score + c[NF + 1] * margin.min(8.0) + c[NF + 2] * if best.src == 3 { 1.0 } else { 0.0 };
        if c.iter().all(|v| *v == 0.0) { 1.0 } else { 1.0 / (1.0 + (-z).exp()) } };
    let found = best.src != 3 && conf >= 0.5;
    let (s, ww, wh) = (wk.s, wk.w, wk.h);
    Detection { conf, wk, edges: e, masks, found, qw: best.q, src: best.src, score: best.score, margin, frame_sides: best.f[9] as u32, cands, s, ww, wh }
}
