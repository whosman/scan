// The whole app in one place: home screen, live camera, review, save. No network anywhere.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { PDFDocument } from 'pdf-lib';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const imgs = ['../IMG_6142.jpeg', '../IMG_6145.jpeg'];
const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('test/out/e2e', { recursive: true });

async function open(url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url);
  return page;
}
const fileUrl = 'file:///' + path.resolve('dist/app.html').replace(/\\/g, '/');
async function reviewReady(page) { await page.waitForFunction(() => document.getElementById('busy').hidden === true, { timeout: 300000 }); }

// 1. embedded, nothing preloaded: home screen, live camera, then real photos
let page = await open(fileUrl);
await page.evaluate((cfg) => { window.__done = null; HW.run(cfg, (r) => { window.__done = r; }); }, { namePrefix: 'HW', maxMB: 12, settings: {} });
await page.waitForFunction(() => !document.getElementById('landing').hidden, { timeout: 10000 });
await page.screenshot({ path: 'test/out/e2e/home_0_empty.png' });
console.log('home:', await page.$eval('#lSub', (e) => e.textContent), '| review disabled:', await page.$eval('#lGo', (e) => e.disabled));
await page.click('#lCamLive');
await page.waitForFunction(() => !document.getElementById('camera').hidden && document.getElementById('camVideo').videoWidth > 0, { timeout: 10000 });
await sleep(400);
await page.click('#shutter'); await sleep(400); await page.click('#shutter'); await sleep(400);
await page.screenshot({ path: 'test/out/e2e/home_1_camera.png' });
console.log('camera pages:', await page.$eval('#camSub', (e) => e.textContent));
await page.click('#camDone'); await sleep(300);
console.log('home after camera:', await page.$eval('#lSub', (e) => e.textContent));
await page.screenshot({ path: 'test/out/e2e/home_2_two.png' });
for (let i = 0; i < 2; i++) await page.click('#lThumbs .lt .lx');   // remove the two test frames
console.log('after remove:', await page.$eval('#lSub', (e) => e.textContent));
await (await page.$('#lPick')).uploadFile(...imgs.map((f) => path.resolve(f)));
await page.waitForFunction(() => !document.getElementById('lGo').disabled, { timeout: 10000 });
console.log('go label:', await page.$eval('#lGo', (e) => e.textContent));
await page.screenshot({ path: 'test/out/e2e/home_3_ready.png' });
await page.click('#lGo');
await reviewReady(page);
await page.waitForFunction(() => { const b = document.getElementById('btnQuick'); return b && !b.disabled; }, { timeout: 20000 });
console.log('first label:', await page.$eval('#btnQuick', (e) => e.innerText.replace(/\n/g, ' | ')));
await page.click('#btnQuick');
await page.waitForSelector('#newFolder', { visible: true });
await page.type('#newFolder', 'PHYS140'); await page.click('#btnNewFolder'); await sleep(300);
await page.$eval('#fname', (e) => (e.value = '')); await page.type('#fname', 'HW 5');
await page.click('#btnUpload');
await page.waitForFunction(() => document.querySelector('#resultBox .result'), { timeout: 300000 });
console.log('RESULT', await page.$eval('#resultBox h2', (e) => e.textContent));
await page.click('#bDone');
await page.waitForFunction(() => window.__done, { timeout: 5000 });
const d = await page.evaluate(() => ({ status: __done.status, name: __done.name, path: __done.path, pages: __done.pages, local: __done.settings.local, pdf: __done.pdfB64 }));
console.log('completion', d.status, d.name, d.path, 'pages', d.pages);
const doc = await PDFDocument.load(Buffer.from(d.pdf, 'base64'));
console.log('pdf pages', doc.getPageCount(), 'title', doc.getTitle());
await page.close();

// 2. second run: one tap with the remembered course and next number
page = await open(fileUrl);
await page.evaluate((cfg) => { window.__done = null; HW.run(cfg, (r) => { window.__done = r; }); }, { namePrefix: 'HW', maxMB: 12, settings: { local: d.local } });
await page.waitForFunction(() => !document.getElementById('landing').hidden, { timeout: 10000 });
await (await page.$('#lPick')).uploadFile(path.resolve(imgs[1]));
await page.waitForFunction(() => !document.getElementById('lGo').disabled, { timeout: 10000 });
await page.click('#lGo'); await reviewReady(page);
await page.waitForFunction(() => /Save to/.test(document.getElementById('btnQuick').textContent), { timeout: 20000 });
console.log('second label:', await page.$eval('#btnQuick', (e) => e.innerText.replace(/\n/g, ' | ')));
await page.screenshot({ path: 'test/out/e2e/home_4_review.png' });
await page.click('#btnQuick');
await page.waitForFunction(() => document.querySelector('#resultBox .result'), { timeout: 300000 });
await page.click('#bDone'); await page.waitForFunction(() => window.__done, { timeout: 5000 });
console.log('one tap ->', await page.evaluate(() => __done.status + ' ' + __done.name + ' ' + __done.path));
await page.close();

// 3. hosted: opens straight to the home screen
const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync('dist/app.html')); });
await new Promise((r) => srv.listen(8791, r));
page = await open('http://127.0.0.1:8791/');
await page.waitForFunction(() => !document.getElementById('landing').hidden, { timeout: 10000 });
console.log('hosted home visible:', await page.$eval('#lSub', (e) => e.textContent));
srv.close(); await browser.close();
