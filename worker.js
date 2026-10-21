/* worker.js - runs OpenCV.js + hwscan-core off the UI thread. Everything is loaded from the app's own files. */
/* global cv, HWScan */
let core = null;
const ready = (async () => {
  self.Module = {};
  importScripts('opencv.js');
  if (typeof cv === 'function') self.cv = await cv(); // some builds export a factory
  else if (cv instanceof Promise) self.cv = await cv;
  if (!self.cv.Mat) await new Promise(r => { self.cv.onRuntimeInitialized = r; });
  importScripts('hwscan-core.js');
  const meta = await (await fetch('updown.json')).json();
  const all = new Float32Array(await (await fetch('updown.bin')).arrayBuffer());
  const m = {};
  for (const k of ['mu', 'sd', 'W1', 'b1', 'W2']) m[k] = all.subarray(meta[k][0], meta[k][0] + meta[k][1]);
  m.b2 = all[meta.b2[0]];
  core = HWScan.create(self.cv, m);
})();

self.onmessage = async (e) => {
  const { id, width, height, rgba, opts } = e.data;
  try {
    await ready;
    const t = Date.now();
    const r = core.processRGBA(width, height, new Uint8ClampedArray(rgba), Object.assign({ color: true, fit: false }, opts));
    const c = r.colorClean, out = new Uint8Array(c.data); // copy out of the wasm heap (RGB, 3 bytes a pixel)
    const msg = { id, ok: true, width: c.cols, height: c.rows, color: out.buffer, info: r.info, ms: Date.now() - t };
    r.clean.delete(); c.delete();
    self.postMessage(msg, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
