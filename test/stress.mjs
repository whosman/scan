// Synthetic stress test: degrade a clean rectified page in many ways and score
// the pipeline output against the output for the undegraded page.
import sharp from 'sharp';
import fs from 'node:fs';
import { rectifyPage, analyzeInk, shapeInk, pageQuality, maxFilter, gaussBlur } from '../core.js';

const refPath = process.argv[2] || 'test/out/a2_rect.jpg';
const only = process.argv[3] ? process.argv[3].split(',') : null;
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

const cases = {
  clean: (i) => i,
  gradient: (i) => { mulField(i, (u, v) => 1 - 0.55 * (0.5 * u + 0.5 * v)); return i; },
  handShadow: (i) => { mulField(i, (u, v) => { const d = Math.hypot(u - 0.55, (v - 0.4) * 1.3) / 0.28; return 1 - 0.55 * Math.exp(-d * d); }); return i; },
  warmDim: (i) => { gain(i, [0.75, 0.6, 0.38]); noise(i, 4); return i; },
  lowLightNoisy: (i) => { gain(i, [0.35, 0.35, 0.35]); noise(i, 11); return i; },
  glare: (i) => { addBlob(i, 0.7, 0.3, 0.12, 110); return i; },
  coolFluorescent: (i) => { gain(i, [0.7, 0.85, 1.0]); return i; },
  overexposed: (i) => { gain(i, [1.35, 1.35, 1.35]); return i; },
  jpegHeavy: (i) => i, // handled below
  lowRes: (i) => i,    // handled below
  lined: (i) => { for (let y = 120; y < H; y += 72) for (let x = 0; x < W; x++) for (let t = 0; t < 3; t++) { const j = ((y + t) * W + x) * 4; i[j] *= 0.80; i[j + 1] *= 0.84; i[j + 2] *= 0.97; } return i; },
  grid: (i) => { for (let y = 60; y < H; y += 60) for (let x = 0; x < W; x++) { const j = (y * W + x) * 4; i[j] *= 0.85; i[j + 1] *= 0.9; i[j + 2] *= 0.98; } for (let x = 60; x < W; x += 60) for (let y = 0; y < H; y++) { const j = (y * W + x) * 4; i[j] *= 0.85; i[j + 1] *= 0.9; i[j + 2] *= 0.98; } return i; },
  worst: (i) => { mulField(i, (u, v) => 0.85 - 0.5 * (0.6 * u + 0.4 * v)); gain(i, [0.8, 0.65, 0.45]); noise(i, 8); return i; },
};

async function degradeViaSharp(name, img) {
  const buf = Buffer.from(img.buffer, img.byteOffset, img.length);
  if (name === 'jpegHeavy') {
    const j = await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).jpeg({ quality: 18, chromaSubsampling: '4:2:0' }).toBuffer();
    return new Uint8ClampedArray((await sharp(j).ensureAlpha().raw().toBuffer()));
  }
  if (name === 'lowRes') {
    const s = await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).resize(Math.round(W * 0.42)).raw().toBuffer({ resolveWithObject: true });
    const u = await sharp(s.data, { raw: { width: s.info.width, height: s.info.height, channels: s.info.channels } }).resize(W, H).ensureAlpha().raw().toBuffer();
    return new Uint8ClampedArray(u);
  }
  return img;
}

function toMask(alpha, thr) { const m = new Float32Array(alpha.length); for (let i = 0; i < m.length; i++) m[i] = alpha[i] > thr ? 1 : 0; return m; }

async function run(img, extra = {}) {
  const t0 = Date.now();
  const r = rectifyPage({ data: img, w: W, h: H }, extra);
  const an = analyzeInk(r.image, extra);
  const ink = shapeInk(an, extra);
  const q = pageQuality(ink, an);
  return { r, an, ink, q, ms: Date.now() - t0 };
}

// reference output
const ref = await run(clone());
const refMask = toMask(ref.ink.alpha, 0.5);
const refNear = maxFilter(refMask, ref.ink.w, ref.ink.h, 4);

const rows = [];
fs.mkdirSync('test/out/stress', { recursive: true });
for (const [name, fn] of Object.entries(cases)) {
  if (only && !only.includes(name)) continue;
  let img = fn(clone());
  img = await degradeViaSharp(name, img);
  const res = await run(img);
  if (res.ink.w !== ref.ink.w || res.ink.h !== ref.ink.h) { rows.push({ name, note: `size mismatch ${res.ink.w}x${res.ink.h}` }); continue; }
  const m = toMask(res.ink.alpha, 0.5); const mLo = maxFilter(toMask(res.ink.alpha, 0.15), res.ink.w, res.ink.h, 1);
  let tp = 0, fn_ = 0, fp = 0;
  const n = m.length;
  for (let i = 0; i < n; i++) {
    if (refMask[i] && mLo[i]) tp++;
    else if (refMask[i] && !m[i]) { // missed unless a test pixel is near
      fn_++;
    } else if (m[i] && !refNear[i]) fp++;
  }
  const recall = tp / Math.max(1, tp + fn_), precision = tp / Math.max(1, tp + fp);
  let dirty = 0, bgPx = 0;
  for (let i = 0; i < n; i++) if (!refNear[i]) { bgPx++; if (res.ink.alpha[i] > 0.04) dirty++; }
  rows.push({ name, recall: +recall.toFixed(3), precision: +precision.toFixed(3), bgDirty: +(dirty / bgPx * 100).toFixed(3) + '%', fullFrame: !!res.r.fullFrame, ms: res.ms, flags: Object.entries(res.q).filter(([k, v]) => v === true).map(([k]) => k).join('|') });
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = 255 - Math.round(res.ink.alpha[i] * 255);
  await sharp(Buffer.from(out), { raw: { width: res.ink.w, height: res.ink.h, channels: 1 } }).resize(1000).png().toFile(`test/out/stress/${name}.png`);
  await sharp(Buffer.from(img.buffer, img.byteOffset, img.length), { raw: { width: W, height: H, channels: 4 } }).resize(500).jpeg({ quality: 70 }).toFile(`test/out/stress/${name}_in.jpg`);
  console.log(rows[rows.length - 1]);
}
console.table(rows);

