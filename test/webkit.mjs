// Run the app in WebKit, the engine Safari uses (JavaScriptCore), on an iPhone 5s-sized touch screen.
// Catches Safari-only problems that a Chrome-family test cannot, and times Safari's JavaScript on the cleaning code.
import { webkit } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import http from 'node:http';

const photos = ['../IMG_6142.jpeg', '../IMG_6145.jpeg', '../IMG_6146.jpeg', '../IMG_6147.jpeg'].map((f) => path.resolve(f));
// serve the built app over http (as GitHub Pages does) unless a URL is given
let srv = null, url = process.argv[2];
if (!url) {
  const root = path.resolve('.'), types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  srv = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f)); });
  await new Promise((r) => srv.listen(8795, '127.0.0.1', r)); url = 'http://127.0.0.1:8795/';
}
const browser = await webkit.launch();
const ctx = await browser.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
let errors = 0;
page.on('pageerror', (e) => { errors++; console.log('[pageerror]', e.message); });
page.on('console', (m) => { if (m.type() === 'error') { errors++; console.log('[console.error]', m.text().slice(0, 200)); } });
fs.mkdirSync('test/out/e2e', { recursive: true });
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) errors++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto(url);
console.log('engine:', await page.evaluate(() => navigator.userAgent.replace(/.*(AppleWebKit\/[\d.]+).*/, '$1')), '| cores', await page.evaluate(() => navigator.hardwareConcurrency));
ok(await page.evaluate(() => !!window.HW && !!window.Worker && typeof Uint32Array !== 'undefined'), 'app and Worker are available');
await page.setInputFiles('#fPick', photos);
await page.waitForFunction(() => !document.getElementById('hGo').disabled && document.querySelectorAll('#hThumbs .th').length === 4);
await page.screenshot({ path: 'test/out/e2e/webkit_home.png' });
const t0 = Date.now();
await page.click('#hGo');
await page.waitForFunction(() => window.__scan.pages[0].state === 'ready', null, { timeout: 120000 });
console.log('first page ready:', ((Date.now() - t0) / 1000).toFixed(1), 's');
await page.waitForFunction(() => window.__scan.pages.every((p) => p.state === 'ready'), null, { timeout: 120000 });
console.log('four pages ready:', ((Date.now() - t0) / 1000).toFixed(1), 's');
console.log('per page (ms):', JSON.stringify(await page.evaluate(() => window.__scan.pages.map((p) => p.t))));
await sleep(300);
await page.screenshot({ path: 'test/out/e2e/webkit_review.png' });

// touch: tap toggles the bars, drag moves the page, double tap zooms
const bars = () => page.evaluate(() => document.body.classList.contains('off'));
await page.touchscreen.tap(160, 300); await sleep(500);
ok(await bars(), 'one tap hides the controls');
await page.touchscreen.tap(160, 300); await sleep(500);
ok(!(await bars()), 'one tap brings them back');
await page.touchscreen.tap(160, 300); await sleep(120); await page.touchscreen.tap(160, 300); await sleep(300);
const zoomed = await page.evaluate(() => document.getElementById('pw').style.transform);
ok(/scale\((?!1\))/.test(zoomed), 'double tap zooms: ' + zoomed.slice(0, 60));
await page.screenshot({ path: 'test/out/e2e/webkit_zoomed.png' });

// adjust sheet and a slider
await page.evaluate(() => { document.body.classList.remove('off'); document.getElementById('bAdj').click(); });
await page.evaluate(() => { const r = document.getElementById('sInk'); r.value = 1.4; r.dispatchEvent(new Event('input')); });
await sleep(400);
ok((await page.textContent('#oInk')) === '1.40', 'slider changes the ink value');
await page.evaluate(() => document.getElementById('aClose').click());

// save
const ts = Date.now();
await page.evaluate(() => document.getElementById('bSave').click());
await page.waitForFunction(() => /ready/.test(document.getElementById('rHead').textContent), null, { timeout: 120000 });
console.log('save four pages:', ((Date.now() - ts) / 1000).toFixed(1), 's |', await page.textContent('#rText'));
await page.screenshot({ path: 'test/out/e2e/webkit_result.png' });
// the PDF bytes come back through the host hook
await page.evaluate(() => { window.__done = null; });
const bytes = await page.evaluate(() => { const s = window.__scan; return Array.from(s.pdf.bytes.subarray(0, 8)); });
ok(String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-', 'PDF header is right');
const pdfLen = await page.evaluate(() => window.__scan.pdf.bytes.length);
const b64 = await page.evaluate(() => { const u = window.__scan.pdf.bytes; let s = ''; for (let i = 0; i < u.length; i += 16384) s += String.fromCharCode.apply(null, u.subarray(i, i + 16384)); return btoa(s); });
const doc = await PDFDocument.load(Buffer.from(b64, 'base64'));
ok(doc.getPageCount() === 4, 'PDF has 4 pages, ' + pdfLen + ' bytes');
console.log(errors ? errors + ' problem(s)' : 'WebKit: no errors');
await browser.close(); if (srv) srv.close();
process.exit(errors ? 1 : 0);
