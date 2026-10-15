import sharp from 'sharp';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { buildPdf } from '../pdf.js';

const files = process.argv.slice(2);
const pages = [];
for (const f of files) {
  const { data, info } = await sharp(f).greyscale().raw().toBuffer({ resolveWithObject: true });
  pages.push({ w: info.width, h: info.height, gray: new Uint8Array(data), dpi: 300 });
}
const pdf = await buildPdf(pages, { title: 'Test HW', deflate: async (b) => new Uint8Array(zlib.deflateSync(b, { level: 9 })) });
fs.writeFileSync('test/out/test.pdf', pdf);
console.log('pdf bytes', pdf.length, 'pages', pages.length);
