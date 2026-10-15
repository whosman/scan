// does the WebAssembly path agree with JavaScript on real photos, and how fast is it?
import sharp from 'sharp';
import fs from 'node:fs';
import * as ref from './ref/core-ref.js';
import * as core from '../core.js';
const K = core.initWasm(new Uint8Array(fs.readFileSync('build/kernels.wasm')));
console.log('wasm loaded:', !!K);
const chk = core.checkWasm(K, () => performance.now());
console.log('self-check:', JSON.stringify({ ok: chk.ok, worstDensQ: chk.worst, jsMs: +chk.jsMs.toFixed(1), wasmMs: +chk.wasmMs.toFixed(1) }));
for (const f of ['../IMG_6142.jpeg', '../IMG_6145.jpeg', '../IMG_6146.jpeg', '../IMG_6147.jpeg']) {
  const { data, info } = await sharp(f).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
  const det = ref.detectPage(img); const quadN = det.fullFrame ? null : det.quad.map((q) => [q[0] / img.w, q[1] / img.h]);
  const geom = core.pageGeometry(img.w, img.h, quadN, 200);
  const u8 = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length);
  let t = performance.now(); const a = core.analyze(u8, img.w, img.h, geom, {}, null); const tJs = performance.now() - t;
  t = performance.now(); const b = core.analyzeW(K, u8, img.w, img.h, geom, {}, null); const tW = performance.now() - t;
  t = performance.now(); const b2 = core.analyzeW(K, u8, img.w, img.h, geom, {}, null); const tW2 = performance.now() - t;
  const ga = new Uint8Array(a.w * a.h), gb = new Uint8Array(a.w * a.h); core.shape(a, {}, ga); core.shape(b, {}, gb);
  let diff = 0, ink = 0, maxd = 0; for (let i = 0; i < ga.length; i++) { const d = Math.abs(ga[i] - gb[i]); if (d) diff++; if (d > maxd) maxd = d; if (ga[i] < 200) ink++; }
  console.log(f.replace(/.*\//, '').padEnd(14), 'js', (tJs | 0) + ' ms', '| wasm', (tW | 0) + ' / ' + (tW2 | 0) + ' ms (cold / warm)', '| differing px', diff, '(' + (100 * diff / Math.max(1, ink)).toFixed(3) + '% of ink px)', 'max diff', maxd);
}
