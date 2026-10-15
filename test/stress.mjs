// Stress test: degrade a clean page in many ways and score the new pipeline against its own clean result.
// Usage: node test/stress.mjs [clean-page.jpg] [case,case]
import sharp from 'sharp';
import fs from 'node:fs';
import * as core from '../core.js';

const refPath = process.argv[2] || 'test/out/a2_rect.jpg';
const only = process.argv[3] ? process.argv[3].split(',') : null;
const DPI = 200;
const { data, info } = await sharp(refPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height;
const base = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
const clone = () => new Uint8ClampedArray(base);

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
const mulField = (img, f) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = f(x / W, y / H); const i = (y * W + x) * 4; for (let c = 0; c < 3; c++) img[i + c] *= k; } };
const gain = (img, g) => { for (let i = 0; i < img.length; i += 4) for (let c = 0; c < 3; c++) img[i + c] *= g[c]; };
const noise = (img, s) => { for (let i = 0; i < img.length; i += 4) { const n = gauss() * s; for (let c = 0; c < 3; c++) img[i + c] += n + gauss() * s * 0.4; } };
const addBlob = (img, cx, cy, r, amt) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const d = Math.hypot(x / W - cx, (y / H - cy) * (H / W)) / r; const k = Math.exp(-d * d); const i = (y * W + x) * 4; for (let c = 0; c < 3; c++) img[i + c] += amt * k; } };
const lines = (img, step, g) => { for (let y = 120; y < H; y += step) for (let x = 0; x < W; x++) for (let t = 0; t < 3; t++) { const j = ((y + t) * W + x) * 4; img[j] *= g[0]; img[j + 1] *= g[1]; img[j + 2] *= g[2]; } };

const cases = {
  clean: (i) => i,
  gradient: (i) => { mulField(i, (u, v) => 1 - 0.55 * (0.5 * u + 0.5 * v)); return i; },
  handShadow: (i) => { mulField(i, (u, v) => { const d = Math.hypot(u - 0.55, (v - 0.4) * 1.3) / 0.28; return 1 - 0.55 * Math.exp(-d * d); }); return i; },
  warmDim: (i) => { gain(i, [0.75, 0.6, 0.38]); noise(i, 4); return i; },
  lowLightNoisy: (i) => { gain(i, [0.35, 0.35, 0.35]); noise(i, 11); return i; },
  glare: (i) => { addBlob(i, 0.7, 0.3, 0.12, 110); return i; },
  coolFluorescent: (i) => { gain(i, [0.7, 0.85, 1.0]); return i; },
  overexposed: (i) => { gain(i, [1.35, 1.35, 1.35]); return i; },
  jpegHeavy: (i) => i,
  lowRes: (i) => i,
  lined: (i) => { lines(i, 72, [0.80, 0.84, 0.97]); return i; },
  grid: (i) => { lines(i, 60, [0.85, 0.9, 0.98]); for (let x = 60; x < W; x += 60) for (let y = 0; y < H; y++) { const j = (y * W + x) * 4; i[j] *= 0.85; i[j + 1] *= 0.9; i[j + 2] *= 0.98; } return i; },
  worst: (i) => { mulField(i, (u, v) => 0.85 - 0.5 * (0.6 * u + 0.4 * v)); gain(i, [0.8, 0.65, 0.45]); noise(i, 8); return i; },
};

async function viaSharp(name, img) {
  const buf = Buffer.from(img.buffer, img.byteOffset, img.length);
  if (name === 'jpegHeavy') { const j = await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).jpeg({ quality: 18, chromaSubsampling: '4:2:0' }).toBuffer(); return new Uint8ClampedArray(await sharp(j).ensureAlpha().raw().toBuffer()); }
  if (name === 'lowRes') { const s = await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).resize(Math.round(W * 0.42)).raw().toBuffer({ resolveWithObject: true }); return new Uint8ClampedArray(await sharp(s.data, { raw: { width: s.info.width, height: s.info.height, channels: s.info.channels } }).resize(W, H).ensureAlpha().raw().toBuffer()); }
  return img;
}
function run(img) {
  const t = performance.now();
  const geom = core.pageGeometry(W, H, null, DPI);
  const an = core.analyze(img, W, H, geom, {}, null);
  const gray = new Uint8Array(an.w * an.h); const q = core.shape(an, {}, gray);
  return { gray, q, w: an.w, h: an.h, ms: Math.round(performance.now() - t), st: an.stats };
}
const dilate = (m, w, h, r) => core.maxFilter(m, w, h, r);
const ref = run(clone());
const refMask = new Float32Array(ref.gray.length); for (let i = 0; i < refMask.length; i++) refMask[i] = ref.gray[i] < 128 ? 1 : 0;
const refNear = dilate(refMask, ref.w, ref.h, 3);
fs.mkdirSync('test/out/stress', { recursive: true });
const rows = [];
for (const [name, fn] of Object.entries(cases)) {
  if (only && !only.includes(name)) continue;
  let img = await viaSharp(name, fn(clone()));
  const res = run(img);
  const lo = new Float32Array(res.gray.length); for (let i = 0; i < lo.length; i++) lo[i] = res.gray[i] < 217 ? 1 : 0;   // alpha > 0.15
  const loNear = dilate(lo, res.w, res.h, 1);
  let tp = 0, fnn = 0, fp = 0, dirty = 0, bg = 0;
  for (let i = 0; i < refMask.length; i++) {
    if (refMask[i]) { if (loNear[i]) tp++; else fnn++; }
    if (res.gray[i] < 128 && !refNear[i]) fp++;
    if (!refNear[i]) { bg++; if (res.gray[i] < 245) dirty++; }
  }
  rows.push({ name, recall: +(tp / Math.max(1, tp + fnn)).toFixed(3), precision: +(1 - fp / Math.max(1, res.gray.length * 0.05)).toFixed(3), bgDirty: (dirty / bg * 100).toFixed(2) + '%', ms: res.ms, noiseK: +res.st.noiseK.toFixed(2), flags: Object.entries(res.q).filter(([k, v]) => v === true).map(([k]) => k).join('|') });
  await sharp(Buffer.from(res.gray), { raw: { width: res.w, height: res.h, channels: 1 } }).resize(900).png().toFile(`test/out/stress/${name}.png`);
  await sharp(Buffer.from(img.buffer, img.byteOffset, img.length), { raw: { width: W, height: H, channels: 4 } }).resize(450).jpeg({ quality: 70 }).toFile(`test/out/stress/${name}_in.jpg`);
}
console.table(rows);
