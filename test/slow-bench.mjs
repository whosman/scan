// per-page cost of the new pipeline on this machine, at a few working resolutions
import sharp from 'sharp';
import * as ref from './ref/core-ref.js';
import * as fast from '../core.js';
const { data, info } = await sharp('../IMG_6145.jpeg').rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const img = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
// the app decodes the photo to a long side of 11*dpi*1.25 before analysis; do the same
const det = ref.detectPage(img); const quadN = det.quad.map((q) => [q[0] / img.w, q[1] / img.h]);
for (const dpi of [200, 160, 130]) {
  const side = Math.round(11 * dpi * 1.25), k = Math.min(1, side / Math.max(img.w, img.h));
  const small = await sharp(data, { raw: { width: img.w, height: img.h, channels: 4 } }).resize(Math.round(img.w * k), Math.round(img.h * k)).raw().toBuffer({ resolveWithObject: true });
  const src = new Uint8Array(small.data.buffer, small.data.byteOffset, small.data.length);
  const geom = fast.pageGeometry(small.info.width, small.info.height, quadN, dpi);
  const times = [];
  for (let r = 0; r < 4; r++) { const t = performance.now(); const an = fast.analyze(src, small.info.width, small.info.height, geom, {}, null); const g = new Uint8Array(an.w * an.h); fast.shape(an, {}, g); times.push(performance.now() - t); }
  console.log(`${String(dpi).padStart(3)} dpi ${geom.w}x${geom.h}  runs(ms): ${times.map((x) => x | 0).join(' ')}  best ${Math.min(...times) | 0}`);
}
