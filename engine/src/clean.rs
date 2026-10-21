// Turn a straightened colour photo of a page into a clean page: remove the shading, fix the colour cast, set black and white
// points from the ink, drop specks and edge shadows. A few fused passes over the pixels; the shading is estimated on a coarse grid.

use crate::util::*;

pub struct CleanParams { pub margin: f32, pub dpi: f32, pub page_found: bool }

// rgba: the clean page. lum_half / norm_half: half-size planes (mean luminance of the clean page; shading-corrected luminance of the photo)
pub struct Cleaned { pub rgba: Vec<u8>, pub lum_half: Vec<u8>, pub norm: Vec<u8>, pub nw: usize, pub nh: usize, pub hw: usize, pub hh: usize, pub white: u8, pub black: u8, pub specks: u32, pub glare: f32, pub paper_sigma: f32 }

fn max_filter(src: &[f32], w: usize, h: usize, r: i32, is_max: bool) -> Vec<f32> {
    let f = |a: f32, b: f32| if is_max { a.max(b) } else { a.min(b) };
    let init = if is_max { f32::MIN } else { f32::MAX };
    let mut t = vec![0.0f32; w * h]; let mut o = vec![0.0f32; w * h];
    for y in 0..h { for x in 0..w as i32 { let mut v = init; for k in -r..=r { v = f(v, src[y * w + clampi(x + k, 0, w as i32 - 1) as usize]); } t[y * w + x as usize] = v; } }
    for y in 0..h as i32 { for x in 0..w { let mut v = init; for k in -r..=r { v = f(v, t[clampi(y + k, 0, h as i32 - 1) as usize * w + x]); } o[y as usize * w + x] = v; } }
    o
}

fn box3(src: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut o = vec![0.0f32; w * h];
    for y in 0..h as i32 { for x in 0..w as i32 {
        let mut s = 0.0; for dy in -1..=1 { for dx in -1..=1 { s += src[clampi(y + dy, 0, h as i32 - 1) as usize * w + clampi(x + dx, 0, w as i32 - 1) as usize]; } }
        o[y as usize * w + x as usize] = s / 9.0;
    } }
    o
}

fn hist_median(h: &[u32; 256], lo: usize, hi: usize) -> f32 {
    let tot: u32 = h[lo..=hi].iter().sum(); if tot == 0 { return f32::NAN; }
    let half = tot / 2; let mut c = 0u32; for i in lo..=hi { c += h[i]; if c > half { return i as f32; } } hi as f32
}

struct Comp { area: u32, x0: u32, y0: u32, x1: u32, y1: u32 }

// 8-connected components of (value < thr) on a gray plane. Returns the label map (0 = background) and component list (index = label - 1).
fn components(g: &[u8], w: usize, h: usize, thr: u8) -> (Vec<u32>, Vec<Comp>) {
    let mut lab = vec![0u32; w * h]; let mut comps: Vec<Comp> = Vec::new(); let mut stack: Vec<usize> = Vec::new();
    for s in 0..w * h {
        if g[s] >= thr || lab[s] != 0 { continue; }
        let id = comps.len() as u32 + 1; lab[s] = id; stack.push(s);
        let mut c = Comp { area: 0, x0: u32::MAX, y0: u32::MAX, x1: 0, y1: 0 };
        while let Some(i) = stack.pop() {
            let (x, y) = ((i % w) as u32, (i / w) as u32); c.area += 1;
            c.x0 = c.x0.min(x); c.x1 = c.x1.max(x); c.y0 = c.y0.min(y); c.y1 = c.y1.max(y);
            for dy in -1i32..=1 { for dx in -1i32..=1 {
                if dx == 0 && dy == 0 { continue; }
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 { continue; }
                let j = ny as usize * w + nx as usize; if g[j] < thr && lab[j] == 0 { lab[j] = id; stack.push(j); }
            } }
        }
        comps.push(c);
    }
    (lab, comps)
}

fn dilate_u8(m: &[u8], w: usize, h: usize, r: i32) -> Vec<u8> {
    let mut t = vec![0u8; w * h]; let mut o = vec![0u8; w * h];
    for y in 0..h { let mut cnt = 0i32; for x in 0..=(r as usize).min(w - 1) { cnt += m[y * w + x] as i32; }
        for x in 0..w as i32 { t[y * w + x as usize] = (cnt > 0) as u8;
            let add = x + r + 1; if add < w as i32 { cnt += m[y * w + add as usize] as i32; } let sub = x - r; if sub >= 0 { cnt -= m[y * w + sub as usize] as i32; } } }
    for x in 0..w { let mut cnt = 0i32; for y in 0..=(r as usize).min(h - 1) { cnt += t[y * w + x] as i32; }
        for y in 0..h as i32 { o[y as usize * w + x] = (cnt > 0) as u8;
            let add = y + r + 1; if add < h as i32 { cnt += t[add as usize * w + x] as i32; } let sub = y - r; if sub >= 0 { cnt -= t[sub as usize * w + x] as i32; } } }
    o
}

pub static mut CSTAGE: i32 = 99; // timing tools: stop after 1 glare/grid pass, 2 shade grid, 3 statistics and tone, 4 final pass, 5 specks

fn early(rgba: Vec<u8>) -> Cleaned { Cleaned { rgba, lum_half: vec![], norm: vec![], nw: 1, nh: 1, hw: 1, hh: 1, white: 0, black: 0, specks: 0, glare: 0.0, paper_sigma: 0.0 } }

pub fn clean(page: &[u8], y: &[u8], ow: usize, oh: usize, p: &CleanParams) -> Cleaned {
    let cst = unsafe { CSTAGE };
    let n = ow * oh;
    // glare statistics and block maxima in one pass (the luminance plane comes from the warp)
    let mut hy = [0u32; 256]; let mut nvalid = 0u32;
    let tot_dummy = 0u32; let _ = tot_dummy;
    let bs = (ow as f32 / 200.0).ceil().max(3.0) as usize; let gw = (ow + bs - 1) / bs; let gh = (oh + bs - 1) / bs;
    let mut grid = vec![-1.0f32; gw * gh]; let mut gmax = vec![-1i16; gw * gh];
    for yy in 0..oh {
        let grow = (yy / bs) * gw; let yrow = &y[yy * ow..(yy + 1) * ow]; let arow = &page[yy * ow * 4..(yy + 1) * ow * 4];
        let (mut bx, mut cnt) = (0usize, 0usize);
        for xx in 0..ow {
            if arow[xx * 4 + 3] != 0 { let v = yrow[xx]; hy[v as usize] += 1; nvalid += 1; let g = grow + bx; if v as i16 > gmax[g] { gmax[g] = v as i16; } }
            cnt += 1; if cnt == bs { cnt = 0; bx += 1; }
        }
    }
    for i in 0..gw * gh { grid[i] = gmax[i] as f32; }
    let tot = nvalid.max(1);
    let (mut c, mut p60) = (0u32, 255usize); for v in 0..256 { c += hy[v]; if c as f32 >= 0.6 * tot as f32 { p60 = v; break; } }
    let sat: u32 = hy[250..].iter().sum(); let glare = if p60 < 238 { sat as f32 / tot as f32 } else { 0.0 };    if cst == 1 { return early(vec![]); }
    let known: Vec<f32> = grid.iter().cloned().filter(|v| *v >= 0.0).collect();
    let fill = if known.is_empty() { 255.0 } else { median(&known) };
    for v in grid.iter_mut() { if *v < 0.0 { *v = fill; } }
    let closed = max_filter(&max_filter(&grid, gw, gh, 2, true), gw, gh, 2, false);
    let mut bg = box3(&box3(&box3(&closed, gw, gh), gw, gh), gw, gh);
    for v in bg.iter_mut() { *v = 255.0 / v.max(1.0); } // now a gain

    // gain of a coarse grid, bilinear along a row; advances by slope inside each cell instead of recomputing the indices
    fn grid_row(grid: &[f32], gw: usize, gh: usize, bs: usize, yy: usize, ow: usize, out: &mut Vec<f32>) {
        let gy = ((yy as f32 + 0.5) / bs as f32 - 0.5).max(0.0); let y0 = (gy as usize).min(gh - 1); let y1 = (y0 + 1).min(gh - 1); let fy = gy - y0 as f32;
        let (r0, r1) = (&grid[y0 * gw..(y0 + 1) * gw], &grid[y1 * gw..(y1 + 1) * gw]);
        let col = |x: usize| r0[x] * (1.0 - fy) + r1[x] * fy;
        let mut xx = 0usize;
        while xx < ow {
            let gx = ((xx as f32 + 0.5) / bs as f32 - 0.5).max(0.0); let x0 = (gx as usize).min(gw - 1); let x1 = (x0 + 1).min(gw - 1);
            let (a, b) = (col(x0), col(x1));
            // pixels of this cell: gx from the cell's left grid centre to the next
            let end = (((x0 + 1) as f32 + 0.5) * bs as f32 - 0.5).ceil().max(xx as f32 + 1.0).min(ow as f32) as usize;
            let slope = (b - a) / bs as f32; let mut v = a + (gx - x0 as f32) * (b - a);
            if x1 == x0 { for i in xx..end { out[i] = a; } } else { for i in xx..end { out[i] = v; v += slope; } }
            xx = end;
        }
    }
    let gain_row = |yy: usize, out: &mut Vec<f32>| grid_row(&bg, gw, gh, bs, yy, ow, out);
    if cst == 2 { return early(vec![]); }
    // statistics pass (every second pixel): histogram of the normalised luminance and of paper-pixel colour channels
    let mut hn = [0u32; 256]; let mut hc = [[0u32; 256]; 3]; let mut gr = vec![0.0f32; ow];
    for yy in (0..oh).step_by(2) {
        gain_row(yy, &mut gr);
        for xx in (0..ow).step_by(2) {
            let i = yy * ow + xx; if page[i * 4 + 3] == 0 { continue; }
            let nv = (y[i] as f32 * gr[xx]).min(255.0); hn[nv as usize] += 1;
            if nv > 200.0 { for ch in 0..3 { hc[ch][((page[i * 4 + ch] as f32 * gr[xx]).min(255.0)) as usize] += 1; } }
        }
    }
    // tone: white point from the paper, black point from the ink (faint pencil included)
    let npaper: u32 = hn[201..].iter().sum();
    let (pmed, sigma) = if npaper > 0 {
        let pm = hist_median(&hn, 201, 255);
        let mut hd = [0u32; 256]; for v in 201..256usize { hd[((v as f32 - pm).abs() * 2.0).round().min(255.0) as usize] += hn[v]; }
        (pm, 1.4826 * hist_median(&hd, 0, 255) / 2.0)
    } else { (250.0, 3.0) };
    let hi = clampf(pmed - p.margin.max(4.0 * sigma), 180.0, 248.0);
    if cst == 3 { return early(vec![]); }
    // Ink strength t = how far below the white point a pixel is, relative to a full-strength stroke. Faint pencil and heavy pen can share
    // a page, so each patch is amplified by its own stroke strength: the strongest 5% of ink in a patch is mapped to about 85% dark.
    let r_full = 130.0f32; let dead = 2.0f32;
    let gb = 40usize; let gw2 = (ow + gb - 1) / gb; let gh2 = (oh + gb - 1) / gb; const NB: usize = 40;
    let mut bh = vec![[0u16; NB]; gw2 * gh2];
    for yy in (0..oh).step_by(2) {
        gain_row(yy, &mut gr);
        for xx in (0..ow).step_by(2) {
            let i = yy * ow + xx; if page[i * 4 + 3] == 0 { continue; }
            let nv = y[i] as f32 * gr[xx]; if nv >= hi { continue; }
            let tt = (hi - nv - dead) / r_full; if tt <= 0.03 { continue; }
            let b = (((tt - 0.03) / 1.17 * NB as f32) as usize).min(NB - 1);
            bh[(yy / gb) * gw2 + xx / gb][b] += 1;
        }
    }
    // gain for the whole page from its overall ink strength (ruling on a page with writing stays light; a page of faint pencil is stretched),
    // and a bounded extra boost where a patch is much fainter than the page
    let mut page_hist = [0u32; NB];
    for k in 0..gw2 * gh2 { for b in 0..NB { page_hist[b] += bh[k][b] as u32; } }
    let page_tot: u32 = page_hist.iter().sum();
    let g_page = if page_tot < 40 { 1.0 } else {
        let target = (page_tot as f32 * 0.95) as u32; let mut c = 0u32; let mut bin = NB - 1;
        for b in 0..NB { c += page_hist[b]; if c >= target { bin = b; break; } }
        clampf(0.85 / (0.03 + (bin as f32 + 0.5) * 1.17 / NB as f32), 1.0, 8.0)
    };
    let mut lg = vec![g_page; gw2 * gh2];
    for k in 0..gw2 * gh2 {
        let tot: u32 = bh[k].iter().map(|v| *v as u32).sum(); if tot < 12 { continue; }
        let target = (tot as f32 * 0.95) as u32; let mut c = 0u32; let mut bin = NB - 1;
        for b in 0..NB { c += bh[k][b] as u32; if c >= target { bin = b; break; } }
        let t95 = 0.03 + (bin as f32 + 0.5) * 1.17 / NB as f32;
        lg[k] = clampf(0.85 / t95, g_page, (g_page * 2.0).min(8.0).max(2.0));
    }    let lg = box3(&box3(&lg, gw2, gh2), gw2, gh2);
    let lg_row = |yy: usize, out: &mut Vec<f32>| grid_row(&lg, gw2, gh2, gb, yy, ow, out);
    // darkness t (0..1) to an output level
    let mut tl = vec![0u8; 4097];
    for k in 0..=4096 { tl[k] = ((1.0 - k as f32 / 4096.0).powf(1.2) * 255.0) as u8; }
    let lo = hi - r_full;
    // colour cast: one gain per channel so the paper is neutral at the same level as the luminance
    let mut gains = [1.0f32; 3];
    if npaper > 0 { for ch in 0..3 { let m = hist_median(&hc[ch], 0, 255); if m.is_finite() && m > 1.0 { gains[ch] = clampf(pmed / m, 0.5, 2.0); } } }
    let gmin = gains[0].min(gains[1]).min(gains[2]);

    // final pass: the clean RGBA page, plus half-size planes for the checks that follow
    let (hw, hh) = (ow / 2, oh / 2);
    let mut rgba = vec![255u8; n * 4]; let mut lgr = vec![1.0f32; ow];

    for yy in 0..oh {
        gain_row(yy, &mut gr); lg_row(yy, &mut lgr);
        let hy_ = yy / 2; let in_half = hy_ < hh;
        for xx in 0..ow {
            let i = yy * ow + xx; let o = i * 4;
            let (mut r8, mut g8, mut b8) = (255u8, 255u8, 255u8);
            let g = gr[xx];
            let paper = page[o + 3] != 0 && (page[o].min(page[o + 1]).min(page[o + 2]) as f32) * g * gmin >= hi; // all channels at paper level: white
            if paper { }
            else if page[o + 3] != 0 {
                let k = lgr[xx] * 4096.0 / r_full; let mut c = [0u8; 3];
                for ch in 0..3 { let v = page[o + ch] as f32 * g * gains[ch]; c[ch] = if v >= hi { 255 } else { tl[(((hi - v - dead).max(0.0) * k) as usize).min(4096)] }; }
                r8 = c[0]; g8 = c[1]; b8 = c[2];
            }
            rgba[o] = r8; rgba[o + 1] = g8; rgba[o + 2] = b8;
        }
    }
    // the shading-corrected luminance at 800 px wide, for the blur check (sharpness must be judged on a plane that keeps the strokes)
    let nw = 800.min(ow); let nh = ((oh as f32 * nw as f32 / ow as f32) as usize).max(8);
    let ysm = crate::orient::resize_area_gray(y, ow, oh, nw, nh);
    let mut norm = vec![255u8; nw * nh]; let mut grr = vec![1.0f32; ow];
    for r in 0..nh { let yy = ((r as f32 + 0.5) * oh as f32 / nh as f32) as usize; gain_row(yy.min(oh - 1), &mut grr);
        for c2 in 0..nw { let xx = (((c2 as f32 + 0.5) * ow as f32 / nw as f32) as usize).min(ow - 1); norm[r * nw + c2] = (ysm[r * nw + c2] as f32 * grr[xx]).min(255.0) as u8; } }
    // half-size planes from the finished page: mean luminance (for orientation) and darkest pixel (for specks)
    let mut lum_half = vec![255u8; hw * hh]; let mut hmin = vec![255u8; hw * hh];
    for yy in 0..hh {
        let (r0, r1) = (&rgba[(2 * yy) * ow * 4..(2 * yy + 1) * ow * 4], &rgba[(2 * yy + 1) * ow * 4..(2 * yy + 2) * ow * 4]);
        for xx in 0..hw {
            let k = xx * 8; let lum = |r: &[u8], o: usize| ((77 * r[o] as u32 + 151 * r[o + 1] as u32 + 28 * r[o + 2] as u32) >> 8) as u16;
            let (a, b, c, d) = (lum(r0, k), lum(r0, k + 4), lum(r1, k), lum(r1, k + 4));
            lum_half[yy * hw + xx] = ((a + b + c + d) / 4) as u8; hmin[yy * hw + xx] = a.min(b).min(c).min(d) as u8;
        }
    }
    if cst == 4 { return Cleaned { rgba, lum_half, norm: vec![], nw: 1, nh: 1, hw, hh, white: 0, black: 0, specks: 0, glare: 0.0, paper_sigma: 0.0 }; }
    // edge frame and long thin shadow lines near the border, then isolated specks (on the half-size darkest-pixel plane)
    let mut half = hmin;
    let frac = if p.page_found { 0.005 } else { 0.003 }; let m = (frac * ow.max(oh) as f32) as usize;
    let mh = m / 2 + 1;
    for yy in 0..hh { for xx in 0..hw { if yy < mh || yy + mh >= hh || xx < mh || xx + mh >= hw { half[yy * hw + xx] = 255; } } }
    let mut kill = vec![false; hw * hh];
    {
        let (lab, comps) = components(&half, hw, hh, 200);
        let band = (0.025 * hw.max(hh) as f32) as u32;
        let mut dead = vec![false; comps.len()];
        for (k, c) in comps.iter().enumerate() {
            let (w_, h_) = (c.x1 - c.x0 + 1, c.y1 - c.y0 + 1);
            let hz = w_ as f32 > 0.1 * hw as f32 && (h_ as f32) < 0.012 * hh as f32 && (c.y1 < band || c.y0 > hh as u32 - band);
            let vt = h_ as f32 > 0.1 * hh as f32 && (w_ as f32) < 0.012 * hw as f32 && (c.x1 < band || c.x0 > hw as u32 - band);
            if hz || vt { dead[k] = true; }
        }
        for i in 0..hw * hh { if lab[i] != 0 && dead[lab[i] as usize - 1] { kill[i] = true; } }
    }
    let mut specks = 0u32;
    {
        let (lab, comps) = components(&half, hw, hh, 160);
        let max_a = ((40.0 * (p.dpi / 300.0).powi(2)) / 4.0).max(1.0) as u32;
        let big: Vec<u8> = (0..hw * hh).map(|i| if lab[i] != 0 && comps[lab[i] as usize - 1].area > max_a { 1 } else { 0 }).collect();
        let near = dilate_u8(&big, hw, hh, ((4.0 * p.dpi / 300.0) as i32).max(1));
        let mut keep = vec![false; comps.len()];
        for i in 0..hw * hh { if lab[i] != 0 && near[i] != 0 { keep[lab[i] as usize - 1] = true; } }
        for (k, c) in comps.iter().enumerate() { if c.area <= max_a && !keep[k] { specks += 1; } }
        for i in 0..hw * hh { let l = lab[i]; if l != 0 { let k = l as usize - 1; if comps[k].area <= max_a && !keep[k] { kill[i] = true; } } }
    }
    // apply: only the killed cells and the frame are touched
    for yy in 0..hh { for xx in 0..hw { if kill[yy * hw + xx] { for dy in 0..2 { for dx in 0..2 {
        let o = ((2 * yy + dy) * ow + 2 * xx + dx) * 4; rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255;
    } } } } }
    let m = m.min(oh / 2).min(ow / 2);
    for yy in 0..oh {
        let row = &mut rgba[yy * ow * 4..(yy + 1) * ow * 4];
        if yy < m || yy + m >= oh { for v in row.iter_mut() { *v = 255; } }
        else { for v in row[..m * 4].iter_mut() { *v = 255; } for v in row[(ow - m) * 4..].iter_mut() { *v = 255; } }
    }    Cleaned { rgba, lum_half, norm, nw, nh, hw, hh, white: hi.round() as u8, black: lo.round() as u8, specks, glare, paper_sigma: sigma }
}
