// Speed and quality: new pipeline vs the reference, same photos, same resolution.
import sharp from 'sharp';
import fs from 'node:fs';
import * as ref from './ref/core-ref.js';
import * as fast from '../core.js';

const files = process.argv.slice(3).length ? process.argv.slice(3) : ['../IMG_6142.jpeg', '../IMG_6145.jpeg', '../IMG_6146.jpeg', '../IMG_6147.jpeg'];
const dpi = Number(process.argv[2] || 200);
fs.mkdirSync('test/out/bench', { recursive: true });
let sumF1 = 0, sumFast = 0, sumRef = 0;
for (const f of files) {
  const { data, info } = await sharp(f).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const img = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
  const tag = f.replace(/.*\//, '').replace('.jpeg', '');

  // reference
  let t = performance.now();
  const r = ref.rectifyPage(img, { dpi });
  const inkRef = ref.extractInk(r.image, { dpi: r.dpi || dpi });
  const tRef = performance.now() - t;

  // new: detect on a small copy exactly as the app does, then analyze + shape
  const det = ref.detectPage(img);
  const quadN = det.fullFrame ? null : det.quad.map((q) => [q[0] / img.w, q[1] / img.h]);
  t = performance.now();
  const geom = fast.pageGeometry(img.w, img.h, quadN, dpi);
  const stages = [];
  let last = performance.now();
  const an = fast.analyze(img.data, img.w, img.h, geom, {}, (fr, label) => { const now = performance.now(); if (!stages.length || stages[stages.length - 1].label !== label) stages.push({ label, at: now - t }); last = now; });
  const tAn = performance.now() - t;
  const gray = new Uint8Array(an.w * an.h);
  t = performance.now();
  const q = fast.shape(an, {}, gray);
  const tShape = performance.now() - t;

  // compare: ink masks
  let tp = 0, fp = 0, fn = 0, diff = 0;
  if (an.w === inkRef.w && an.h === inkRef.h) {
    for (let i = 0; i < gray.length; i++) {
      const a = inkRef.alpha[i] > 0.5, b = gray[i] < 128;
      if (a && b) tp++; else if (b) fp++; else if (a) fn++;
      diff += Math.abs((255 - gray[i]) / 255 - inkRef.alpha[i]);
    }
  } else console.log('size differs', an.w, an.h, inkRef.w, inkRef.h);
  const prec = tp / Math.max(1, tp + fp), rec = tp / Math.max(1, tp + fn), f1 = 2 * prec * rec / Math.max(1e-9, prec + rec);
  sumF1 += f1; sumFast += tAn + tShape; sumRef += tRef;
  console.log(`${tag} ${dpi}dpi ${an.w}x${an.h} | ref ${tRef | 0} ms | new analyze ${tAn | 0} + shape ${tShape | 0} = ${(tAn + tShape) | 0} ms | x${(tRef / (tAn + tShape)).toFixed(1)} | F1 ${f1.toFixed(3)} prec ${prec.toFixed(3)} rec ${rec.toFixed(3)} meanAlphaDiff ${(diff / gray.length).toFixed(4)} | noiseK ref ${inkRef.stats ? '' : ''}new ${an.stats.noiseK.toFixed(2)} noise0 ${an.stats.noise0.toFixed(4)}`);
  if (process.env.STAGES) console.log('   stages:', stages.map((s) => `${s.label}@${s.at | 0}`).join(' | '));
  await sharp(Buffer.from(gray), { raw: { width: an.w, height: an.h, channels: 1 } }).png().toFile(`test/out/bench/${tag}_new.png`);
  const g2 = new Uint8Array(an.w * an.h); for (let i = 0; i < g2.length; i++) g2[i] = 255 - Math.round(inkRef.alpha[i] * 255);
  await sharp(Buffer.from(g2), { raw: { width: an.w, height: an.h, channels: 1 } }).png().toFile(`test/out/bench/${tag}_ref.png`);
}
console.log(`mean F1 ${(sumF1 / files.length).toFixed(3)} | total ref ${sumRef | 0} ms vs new ${sumFast | 0} ms | speedup x${(sumRef / sumFast).toFixed(1)}`);
