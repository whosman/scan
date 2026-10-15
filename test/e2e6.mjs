// Feature coverage: crop, delete, reorder, photo mode, compare, sizes (sharper/smaller), stamp, many pages, old-phone mode.
// Usage: node test/e2e6.mjs [lite]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';

const lite = process.argv[2] === 'lite';
const photos = ['../IMG_6142.jpeg', '../IMG_6145.jpeg', '../IMG_6146.jpeg', '../IMG_6147.jpeg'].map((f) => path.resolve(f));
const url = 'file:///' + path.resolve('index.html').replace(/\\/g, '/');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const page = await browser.newPage();
await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
if (lite) await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 2 }));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200)); });
fs.mkdirSync('test/out/e2e', { recursive: true });
const tag = lite ? 'lite' : 'full';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (cond, msg) => console.log(cond ? 'ok  ' : 'FAIL', msg);
const ready = (n) => page.waitForFunction((n) => window.__scan.pages.length === n && window.__scan.pages.every((p) => p.state === 'ready'), { timeout: 600000 }, n);
const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

await page.goto(url);
await page.evaluate(() => { window.__done = null; HW.run({ namePrefix: 'HW', settings: {} }, (r) => { window.__done = r; }); });
console.log('workers:', await page.evaluate(() => 'cores ' + navigator.hardwareConcurrency));
// live camera: two shots in a row, then discard them
await click('#hCam');
await page.waitForFunction(() => !document.getElementById('cam').hidden && document.getElementById('cv').videoWidth > 0, { timeout: 10000 });
await sleep(400); await click('#shutter'); await sleep(500); await click('#shutter'); await sleep(500);
await page.screenshot({ path: `test/out/e2e/${tag}_camera.png` });
ok((await page.$eval('#cn', (e) => e.textContent)) === '2 pages', 'camera keeps shooting: 2 pages');
await click('#cDone'); await sleep(300);
for (let i = 0; i < 2; i++) await click('#hThumbs .th b');
ok((await page.$$eval('#hThumbs .th', (n) => n.length)) === 0, 'camera shots removed from the home screen');
// 15 pages: the app should lower its working resolution
const files = []; for (let i = 0; i < 15; i++) files.push(photos[i % 4]);
await (await page.$('#fPick')).uploadFile(...files);
await page.waitForFunction(() => !document.getElementById('hGo').disabled && document.querySelectorAll('#hThumbs .th').length === 15, { timeout: 30000 });
const t0 = performance.now();
await click('#hGo');
await page.waitForFunction(() => window.__scan.pages[0].state === 'ready', { timeout: 600000 });
console.log('first page of 15 on screen:', ((performance.now() - t0) / 1000).toFixed(1), 's');
await ready(15);
console.log('all 15 ready:', ((performance.now() - t0) / 1000).toFixed(1), 's | working dpi', await page.evaluate(() => Math.round(window.__scan.pages[0].dpi)));
await page.screenshot({ path: `test/out/e2e/${tag}_15pages.png` });
ok((await page.evaluate(() => window.__scan.pages[0].dpi)) < 200, 'working resolution drops for many pages');

// delete down to 3 pages
for (let i = 0; i < 12; i++) { await click('#bTools'); await click('#tDel'); await sleep(60); }
await page.waitForFunction(() => window.__scan.pages.length === 3);
ok(true, 'deleted 12 pages, 3 left');
// reorder
const idsBefore = await page.evaluate(() => window.__scan.pages.map((p) => p.id));
await click('#bTools'); await click('#tDn'); await sleep(200);
const idsAfter = await page.evaluate(() => window.__scan.pages.map((p) => p.id));
ok(idsAfter[1] === idsBefore[0] && idsAfter[0] === idsBefore[1], 'move later reorders');
await click('#tClose');

// photo mode toggle
await click('#bTools'); await click('#tMode'); await sleep(500);
ok(await page.evaluate(() => window.__scan.pages[window.__scan.cur].mode === 'gray'), 'photo mode on');
await page.screenshot({ path: `test/out/e2e/${tag}_photo_mode.png` });
await click('#tMode'); await sleep(400); await click('#tClose');

// compare (hold)
await page.evaluate(() => { document.getElementById('bTools').click(); });
await page.evaluate(() => document.getElementById('tCmp').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
await sleep(200);
ok(await page.evaluate(() => !document.getElementById('orig').hidden), 'hold shows the original photo');
await page.screenshot({ path: `test/out/e2e/${tag}_compare.png` });
await page.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup')));
await sleep(100);
ok(await page.evaluate(() => document.getElementById('orig').hidden), 'release hides it');
await click('#tClose');

// crop: open, nudge a corner, apply
await click('#bTools'); await click('#tCrop'); await sleep(800);
await page.screenshot({ path: `test/out/e2e/${tag}_crop.png` });
ok(await page.evaluate(() => !document.getElementById('crop').hidden), 'crop screen opens');
await click('#cApply');
await ready(3);
ok(true, 'crop applied and page reprocessed');

console.log('save button label:', await page.$eval('#bSave', (b) => b.textContent));
// stamp + name, then save at three sizes
await click('#bAdj');
await page.evaluate(() => { const c = document.getElementById('cStamp'); c.checked = true; c.dispatchEvent(new Event('change')); });
await page.type('#stampText', 'Dylan Fraser, PHYS 140');
await sleep(300); await click('#aClose');
const sizes = {};
for (const [label, sel] of [['standard', null], ['smaller', '#rSmall'], ['sharper', '#rSharp']]) {
  const ts = performance.now();
  if (!sel) await click('#bSave'); else await click(sel);
  await page.waitForFunction(() => /ready/.test(document.getElementById('rHead').textContent), { timeout: 600000 });
  const text = await page.$eval('#rText', (e) => e.textContent);
  sizes[label] = text; console.log(label.padEnd(9), ((performance.now() - ts) / 1000).toFixed(1) + ' s |', text);
  if (label === 'standard') await page.screenshot({ path: `test/out/e2e/${tag}_result.png` });
}
// hand back and check the file
await page.$eval('#rName', (e) => (e.value = 'HW 7')); await page.evaluate(() => document.getElementById('rName').dispatchEvent(new Event('input')));
await click('#rShare');
await page.waitForFunction(() => window.__done, { timeout: 15000 });
const d = await page.evaluate(() => ({ s: __done.status, n: __done.name, pages: __done.pages, pdf: __done.pdfB64 }));
const doc = await PDFDocument.load(Buffer.from(d.pdf, 'base64'));
ok(d.s === 'saved' && d.n === 'HW 7' && doc.getPageCount() === 3, `host receives ${d.n}, ${doc.getPageCount()} pages, ${Buffer.from(d.pdf, 'base64').length} bytes`);
fs.writeFileSync(`test/out/e2e/${tag}_stamped.pdf`, Buffer.from(d.pdf, 'base64'));
await browser.close();
