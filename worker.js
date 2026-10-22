/* worker.js - runs the HW Scan engine (WebAssembly) off the main thread. MIT licence.
   Two kinds of job:
     { kind: 'file', id, file, maxSide, opts }  the worker decodes the photo itself (needs OffscreenCanvas) and answers with a JPEG
     { kind: 'rgba', id, width, height, rgba, opts }  the page already decoded the photo; the worker answers with the clean pixels
   The first message the page gets is { type: 'ready', canOffscreen } once the engine and the orientation model are loaded. */
'use strict';
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const CAN_OFFSCREEN = !/nooffscreen/.test(self.location.search) && typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined' &&
  typeof OffscreenCanvas.prototype.convertToBlob === 'function';

let X = null; // engine exports
const WARN = [
  [1, 'The photo is too small to read well. Move the phone closer.'],
  [2, 'The photo is blurry. Hold still and tap the screen to focus.'],
  [4, 'There is glare on the page. Tilt the phone or move the light.'],
  [8, 'Part of the page is cut off. Keep all four corners in view.'],
  [16, 'The page edges are hard to see. Use a darker table and keep all four corners in view.'],
  [32, 'We could not tell which way is up. Please check this page.'],
];

let usingJs = false;
// The engine runs as WebAssembly. A phone that has none (older iOS, iOS Lockdown Mode, some school browsers) runs the same engine as plain JavaScript: about 20 times slower, but it works.
async function loadEngine() {
  if (typeof WebAssembly === 'object' && WebAssembly.instantiate && !/nowasm/.test(self.location.search)) {
    try {
      const url = WebAssembly.validate(SIMD_PROBE) ? 'engine-simd.wasm' : 'engine.wasm';
      const bytes = await (await fetch(url)).arrayBuffer();
      return (await WebAssembly.instantiate(bytes, {})).instance.exports;
    } catch (e) { /* blocked or failed: fall through to the JavaScript build */ }
  }
  importScripts('engine-js.js');
  usingJs = true;
  return self.HWENGINE;
}

const ready = (async () => {
  X = await loadEngine();
  if (usingJs) X.hw_set_cp(10, 9); // the ink network is for WebAssembly speed; the JavaScript engine keeps the plain cleaner
  // orientation model
  const meta = await (await fetch('updown.json')).json();
  const raw = await (await fetch('updown.bin')).arrayBuffer();
  const p = X.hw_alloc(raw.byteLength);
  new Uint8Array(X.memory.buffer, p, raw.byteLength).set(new Uint8Array(raw));
  X.hw_set_model(p, raw.byteLength / 4, meta.mu[0], meta.sd[0], meta.W1[0], meta.b1[0], meta.W2[0], meta.b2[0], meta.b1[1]);
  X.hw_free(p, raw.byteLength);
  self.postMessage({ type: 'ready', canOffscreen: CAN_OFFSCREEN, slow: usingJs });
})();

const PAPERS = { letter: [11 / 8.5, 11], a4: [11.69 / 8.27, 11.69] };

// run the engine on RGBA pixels; returns { w, h, pixels: Uint8ClampedArray (RGBA), info }
function run(rgba, width, height, o) {
  const t0 = performance.now();
  const n = width * height * 4;
  const pin = X.hw_alloc(n);
  new Uint8Array(X.memory.buffer, pin, n).set(rgba);
  const [ratio, longIn] = PAPERS[o.paper] || PAPERS.letter;
  const q = o.quad;
  const opts = new Float32Array([ratio, longIn, o.dpi, o.margin, o.autorotate ? 1 : 0, q ? 1 : 0].concat(q ? [q[0][0], q[0][1], q[1][0], q[1][1], q[2][0], q[2][1], q[3][0], q[3][1]] : [0, 0, 0, 0, 0, 0, 0, 0]));
  const po = X.hw_alloc(opts.byteLength);
  new Uint8Array(X.memory.buffer, po, opts.byteLength).set(new Uint8Array(opts.buffer));
  const found = X.hw_process(pin, width, height, po);
  X.hw_free(pin, n); X.hw_free(po, opts.byteLength);
  const w = X.hw_out_w(), h = X.hw_out_h();
  const pixels = new Uint8ClampedArray(X.memory.buffer, X.hw_out_rgba(), w * h * 4).slice();
  const pi = new Float32Array(X.memory.buffer, X.hw_proc_info(), 32).slice();
  const bits = pi[19] | 0;
  const info = {
    found: !!found, page: found ? 'page found' : 'whole photo',
    quad: [[pi[1], pi[2]], [pi[3], pi[4]], [pi[5], pi[6]], [pi[7], pi[8]]],
    white: pi[9], black: pi[10], specks: pi[11], glare: pi[12], dpiEff: pi[13], rotation: pi[17], orientConf: pi[18],
    warn: WARN.filter((x) => bits & x[0]).map((x) => x[1]),
    ms: Math.round(performance.now() - t0),
  };
  return { w, h, pixels, info };
}

async function decode(file, maxSide) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(file); }
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height)), w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const oc = new OffscreenCanvas(w, h), g = oc.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return { oc, g, w, h };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    await ready;
    if (m.kind === 'file') {
      const d = await decode(m.file, m.maxSide);
      // a small copy of the photo for the page to show at once
      const ts = Math.min(1, 192 / Math.max(d.w, d.h)), tw = Math.max(1, Math.round(d.w * ts)), th = Math.max(1, Math.round(d.h * ts));
      const tc = new OffscreenCanvas(tw, th); tc.getContext('2d').drawImage(d.oc, 0, 0, tw, th);
      const thumb = tc.transferToImageBitmap();
      self.postMessage({ type: 'decoded', id: m.id, w: d.w, h: d.h, thumb }, [thumb]);
      const img = d.g.getImageData(0, 0, d.w, d.h);
      const r = run(img.data, d.w, d.h, m.opts);
      const out = new OffscreenCanvas(r.w, r.h); out.getContext('2d').putImageData(new ImageData(r.pixels, r.w, r.h), 0, 0);
      const [blob, srcBlob] = await Promise.all([out.convertToBlob({ type: 'image/jpeg', quality: 0.95 }), d.oc.convertToBlob({ type: 'image/jpeg', quality: 0.92 })]);
      self.postMessage({ type: 'done', id: m.id, ok: true, width: r.w, height: r.h, blob, srcBlob, sw: d.w, sh: d.h, info: r.info });
    } else {
      const r = run(new Uint8ClampedArray(m.rgba), m.width, m.height, m.opts);
      self.postMessage({ type: 'done', id: m.id, ok: true, width: r.w, height: r.h, pixels: r.pixels.buffer, info: r.info }, [r.pixels.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'done', id: m.id, ok: false, error: String((err && err.message) || err) });
  }
};
