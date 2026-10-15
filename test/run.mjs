import sharp from 'sharp';
import fs from 'node:fs';
import { rectifyPage, extractInk, renderGray } from '../core.js';

const src = process.argv[2];
const tag = process.argv[3] || 'out';
const extra = {};
for (const kv of process.argv.slice(4)) { const [k, v] = kv.split('='); extra[k] = Number(v); }
const { data, info } = await sharp(src).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const img = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
console.time('rectify');
const r = rectifyPage(img, extra);
console.timeEnd('rectify');
console.log('quad', r.quad.map((p) => p.map(Math.round)), 'size', r.image.w, r.image.h, 'conf', r.confidence.toFixed(3));
console.time('ink');
const ink = extractInk(r.image, extra);
console.timeEnd('ink');
console.log('stats', ink.stats);
const g = renderGray(ink);
fs.mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const base = new URL(`./out/${tag}`, import.meta.url).pathname.replace(/^\//, '');
await sharp(Buffer.from(g.data), { raw: { width: g.w, height: g.h, channels: 1 } }).png().toFile(base + '.png');
// rectified colour for comparison
await sharp(Buffer.from(r.image.data), { raw: { width: r.image.w, height: r.image.h, channels: 4 } }).jpeg({ quality: 85 }).toFile(base + '_rect.jpg');
console.log('wrote', base);
