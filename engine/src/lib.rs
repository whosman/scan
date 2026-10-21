// HW Scan engine: finds the page in a photo, straightens it, cleans it. Built as a WebAssembly module with a plain C interface.
// All buffers live in the module's memory; the host allocates them with hw_alloc and reads results through the hw_* getters.

mod clean;
mod detect;
mod img;
mod orient;
mod util;
mod warp;

use detect::*;

struct State { det: Option<Detection>, info: Vec<f32>, cand: Vec<f32>, out_rgba: Vec<u8>, out_w: usize, out_h: usize, pinfo: Vec<f32>, model: Option<orient::Model> }
static mut STATE: State = State { det: None, info: Vec::new(), cand: Vec::new(), out_rgba: Vec::new(), out_w: 0, out_h: 0, pinfo: Vec::new(), model: None };
fn st() -> &'static mut State { unsafe { &mut *core::ptr::addr_of_mut!(STATE) } }

#[no_mangle]
pub extern "C" fn hw_version() -> i32 { 1 }

#[no_mangle]
pub extern "C" fn hw_alloc(n: usize) -> *mut u8 { let mut v = Vec::<u8>::with_capacity(n.max(1)); let p = v.as_mut_ptr(); core::mem::forget(v); p }

#[no_mangle]
pub extern "C" fn hw_free(p: *mut u8, n: usize) { unsafe { drop(Vec::from_raw_parts(p, 0, n.max(1))); } }

#[no_mangle]
pub extern "C" fn hw_set_conf(p: *const f32, n: usize) {
    let w = unsafe { core::slice::from_raw_parts(p, n) };
    unsafe { let dst = &mut *core::ptr::addr_of_mut!(CONF); for i in 0..n.min(NF + 4) { dst[i] = w[i]; } }
}

#[no_mangle]
pub extern "C" fn hw_set_weights(p: *const f32, n: usize) {
    let w = unsafe { core::slice::from_raw_parts(p, n) };
    unsafe { let dst = &mut *core::ptr::addr_of_mut!(WEIGHTS); for i in 0..n.min(NF + 1) { dst[i] = w[i]; } }
}

#[no_mangle]
pub extern "C" fn hw_set_stage(n: i32) { unsafe { STAGE = n; } }

static mut PSTAGE: i32 = 99;
#[no_mangle]
pub extern "C" fn hw_set_pstage(n: i32) { unsafe { PSTAGE = n; } }
#[no_mangle]
pub extern "C" fn hw_set_cstage(n: i32) { unsafe { clean::CSTAGE = n; } }

#[no_mangle]
pub extern "C" fn hw_nf() -> i32 { NF as i32 }

// Detect the page. Returns 1 when a page was found, 0 when the whole frame should be used.
#[no_mangle]
pub extern "C" fn hw_detect(rgba: *const u8, w: i32, h: i32) -> i32 {
    let (w, h) = (w as usize, h as usize);
    let px = unsafe { core::slice::from_raw_parts(rgba, w * h * 4) };
    let d = detect(px, w, h, 320.0);
    let s = st();
    let mut info = vec![0.0f32; 40];
    // the quad as the whole pipeline would finish it: refined on the full-resolution photo
    if d.found { let img = warp::Rgba { d: px, w, h }; let mut q = [[0.0f32; 2]; 4]; for i in 0..4 { q[i] = [d.qw[i][0] / d.s, d.qw[i][1] / d.s]; } let r = warp::refine_quad(&img, &q); for i in 0..4 { info[27 + 2 * i] = r[i][0]; info[28 + 2 * i] = r[i][1]; } }
    info[0] = if d.found { 1.0 } else { 0.0 }; info[1] = d.src as f32; info[2] = d.score; info[3] = d.margin; info[4] = d.frame_sides as f32;
    info[26] = d.conf; info[5] = d.cands.len() as f32; info[6] = d.s; info[7] = d.ww as f32; info[8] = d.wh as f32;
    for i in 0..4 { info[9 + 2 * i] = d.qw[i][0]; info[10 + 2 * i] = d.qw[i][1]; info[17 + 2 * i] = d.qw[i][0] / d.s; info[18 + 2 * i] = d.qw[i][1] / d.s; }
    s.info = info;
    let mut c = Vec::with_capacity(d.cands.len() * (10 + NF));
    for k in &d.cands {
        c.push(k.src as f32); c.push(k.score);
        for i in 0..4 { c.push(k.q[i][0] / d.s); c.push(k.q[i][1] / d.s); }
        for v in k.f.iter() { c.push(*v); }
    }
    s.cand = c; let found = d.found; s.det = Some(d);
    if found { 1 } else { 0 }
}

// Features and score of an arbitrary quad (8 floats, photo coordinates) against the last detection. Used by the training tools.
#[no_mangle]
pub extern "C" fn hw_quad_features(q: *const f32, out: *mut f32) {
    let s = st(); let d = match s.det.as_ref() { Some(d) => d, None => return };
    let qq = unsafe { core::slice::from_raw_parts(q, 8) };
    let mut quad = [[0.0f32; 2]; 4]; for i in 0..4 { quad[i] = [qq[2 * i] * d.s, qq[2 * i + 1] * d.s]; }
    let f = features(&d.wk, &d.edges, &d.masks, &quad);
    let o = unsafe { core::slice::from_raw_parts_mut(out, NF + 1) };
    for i in 0..NF { o[i] = f[i]; } o[NF] = score_of(&f);
}

#[no_mangle]
pub extern "C" fn hw_debug_mask_ptr() -> *const u8 { unsafe { (*core::ptr::addr_of!(DEBUG_MASK)).as_ptr() } }
#[no_mangle]
pub extern "C" fn hw_debug_mask_len() -> i32 { unsafe { (*core::ptr::addr_of!(DEBUG_MASK)).len() as i32 } }

#[no_mangle]
pub extern "C" fn hw_lines_count() -> i32 { unsafe { (*core::ptr::addr_of!(DEBUG_LINES)).len() as i32 } }
#[no_mangle]
pub extern "C" fn hw_lines_buf() -> *const f32 { unsafe { (*core::ptr::addr_of!(DEBUG_LINES)).as_ptr() as *const f32 } }

#[no_mangle]
pub extern "C" fn hw_det_info() -> *const f32 { st().info.as_ptr() }
#[no_mangle]
pub extern "C" fn hw_cand_count() -> i32 { st().det.as_ref().map_or(0, |d| d.cands.len() as i32) }
#[no_mangle]
pub extern "C" fn hw_cand_stride() -> i32 { (10 + NF) as i32 }
#[no_mangle]
pub extern "C" fn hw_cand_buf() -> *const f32 { st().cand.as_ptr() }

// ---------- the whole pipeline ----------
// Load the orientation model. `all` holds every float of updown.bin; the others are offsets into it (from updown.json).
#[no_mangle]
pub extern "C" fn hw_set_model(all: *const f32, n: usize, mu: usize, sd: usize, w1: usize, b1: usize, w2: usize, b2: usize, nh: usize) {
    let a = unsafe { core::slice::from_raw_parts(all, n) };
    st().model = Some(orient::Model { mu: a[mu..mu + 1188].to_vec(), sd: a[sd..sd + 1188].to_vec(), w1: a[w1..w1 + 1188 * nh].to_vec(), b1: a[b1..b1 + nh].to_vec(), w2: a[w2..w2 + nh].to_vec(), b2: a[b2], nh });
}

// opts: [paper long/short ratio, paper long side in inches, dpi, ink margin (4 keep, 10 normal, 24 remove), auto-turn (0/1), use given quad (0/1), quad x0 y0 .. x3 y3 (photo pixels)]
// Returns 1 when a page was found (or given), 0 when the whole photo was used. The cleaned page is read with hw_out_rgba / hw_out_gray.
#[no_mangle]
pub extern "C" fn hw_process(rgba: *const u8, w: i32, h: i32, opts: *const f32) -> i32 {
    let (w, h) = (w as usize, h as usize);
    let px = unsafe { core::slice::from_raw_parts(rgba, w * h * 4) };
    let o = unsafe { core::slice::from_raw_parts(opts, 14) };
    let (paper_ratio, long_in, dpi, margin, autorot, use_quad) = (o[0], o[1], o[2], o[3], o[4] > 0.5, o[5] > 0.5);
    let img = warp::Rgba { d: px, w, h };
    let full: util::Quad = [[0.0, 0.0], [w as f32 - 1.0, 0.0], [w as f32 - 1.0, h as f32 - 1.0], [0.0, h as f32 - 1.0]];
    let (mut found, mut frame_sides, mut det_conf) = (false, 0u32, 1.0f32);
    let mut q = full;
    let s = st();
    if use_quad { for i in 0..4 { q[i] = [o[6 + 2 * i], o[7 + 2 * i]]; } found = true; s.det = None; }
    else {
        let d = detect(px, w, h, 320.0);
        if d.found { for i in 0..4 { q[i] = [d.qw[i][0] / d.s, d.qw[i][1] / d.s]; } q = warp::refine_quad(&img, &q); found = true; }
        frame_sides = d.frame_sides; det_conf = d.conf; s.det = Some(d);
    }
    let shape = warp::page_shape(&q, w, h, dpi * long_in, paper_ratio);
    let pstage = unsafe { PSTAGE };
    if pstage == 1 { let _ = warp::refine_quad(&img, &q); return 1; }
    let (page, lum) = warp::warp(&img, &q, shape.w, shape.h);
    if pstage == 2 { s.out_w = shape.w; s.out_h = shape.h; s.out_rgba = page; return 1; }
    let dpi_eff = shape.w.max(shape.h) as f32 / long_in; // resolution of the output bitmap
    let natural_dpi = { let l = |a: [f32; 2], b: [f32; 2]| util::dist(a, b); l(q[0], q[1]).max(l(q[3], q[2])).max(l(q[0], q[3])).max(l(q[1], q[2])) / long_in }; // what the photo itself gives
    let mut c = clean::clean(&page, &lum, shape.w, shape.h, &clean::CleanParams { margin, dpi: dpi_eff, page_found: found });
    if pstage == 3 { s.out_w = shape.w; s.out_h = shape.h; s.out_rgba = c.rgba; return 1; }
    if unsafe { clean::CSTAGE } < 99 { return 1; }
    // which way is up
    let (mut rot, mut conf) = (0u32, 99.0f32);
    if autorot { let r = orient::auto_orient(&c.rgba, shape.w, shape.h, found, s.model.as_ref(), 400); rot = r.0; conf = r.1; }
    let (mut ow, mut oh) = (shape.w, shape.h);
    if rot != 0 { let (r2, a, b) = orient::rotate_cw(&c.rgba, ow, oh, 4, rot); c.rgba = r2; ow = a; oh = b; }
    // warnings
    let mut warn = 0u32;
    if natural_dpi < 90.0 { warn |= 1; }
    if orient::is_blurry(&c.norm, c.nw, c.nh) { warn |= 2; }
    if c.glare > 0.03 { warn |= 4; }
    if frame_sides > 0 { warn |= 8; }
    if !found { // a photo with a light frame edge is probably a scan; a dark one means the table is in view
        let b = (0.03 * w.max(h) as f32).max(2.0) as usize; let mut ring: Vec<f32> = Vec::new();
        for y in 0..h { for x in 0..w { if y < b || y >= h - b || x < b || x >= w - b { let i = (y * w + x) * 4; ring.push(((77 * px[i] as u32 + 151 * px[i + 1] as u32 + 28 * px[i + 2] as u32) >> 8) as f32); } } }
        if util::median(&ring) < 200.0 { warn |= 16; }
    }
    if autorot && conf < 1.0 { warn |= 32; }
    let mut pinfo = vec![0.0f32; 32];
    pinfo[0] = if found { 1.0 } else { 0.0 };
    for i in 0..4 { pinfo[1 + 2 * i] = q[i][0]; pinfo[2 + 2 * i] = q[i][1]; }
    pinfo[9] = c.white as f32; pinfo[10] = c.black as f32; pinfo[11] = c.specks as f32; pinfo[12] = c.glare; pinfo[13] = dpi_eff;
    pinfo[14] = frame_sides as f32; pinfo[15] = shape.used as f32; pinfo[16] = c.paper_sigma; pinfo[17] = rot as f32; pinfo[18] = conf; pinfo[19] = warn as f32; pinfo[20] = det_conf;
    s.pinfo = pinfo; s.out_w = ow; s.out_h = oh; s.out_rgba = c.rgba;
    if found { 1 } else { 0 }
}

#[no_mangle]
pub extern "C" fn hw_out_w() -> i32 { st().out_w as i32 }
#[no_mangle]
pub extern "C" fn hw_out_h() -> i32 { st().out_h as i32 }
#[no_mangle]
pub extern "C" fn hw_out_rgba() -> *const u8 { st().out_rgba.as_ptr() }
#[no_mangle]
pub extern "C" fn hw_proc_info() -> *const f32 { st().pinfo.as_ptr() }