// Draws the app icon: a black square with a white serif "S". Run once: node icons.mjs
import sharp from 'sharp';
import fs from 'node:fs';

fs.mkdirSync(new URL('./icons/', import.meta.url), { recursive: true });
const svg = (n) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#0b0b0c"/>
  <text x="50" y="73" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="74" fill="#ffffff">S</text>
</svg>`);
for (const n of [180, 192, 512]) {
  await sharp(svg(n)).png().toFile(new URL(`./icons/icon-${n}.png`, import.meta.url).pathname.replace(/^\//, ''));
}
console.log('icons written');
