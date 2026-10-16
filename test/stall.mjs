// Does a page ever sit on "Reading the photo"? Runs one real photo under heavy CPU throttle and samples the status line.
// Usage: node test/stall.mjs [throttle] [url]
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const rate = +(process.argv[2] || 12);
let url = process.argv[3], srv = null;
if (!url) {
  const root = path.resolve('.');
  srv = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); res.end(fs.readFileSync(f)); });
  await new Promise((r) => srv.listen(8796, '127.0.0.1', r)); url = 'http://127.0.0.1:8796/';
}
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox'].concat(process.env.JITLESS ? ['--js-flags=--jitless'] : []) });
const page = await browser.newPage();
await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const cdp = await page.createCDPSession(); await cdp.send('Emulation.setCPUThrottlingRate', { rate });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
const input = await page.$('#fPick'); await input.uploadFile(path.resolve('../IMG_6142.jpeg'));
await page.waitForFunction(() => !document.getElementById('hGo').disabled);
await page.evaluate(() => { window.__gap = 0; let l = performance.now(); setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - l); l = n; }, 50); });
const t0 = Date.now(); await page.click('#hGo');
let last = '', done = false;
while (Date.now() - t0 < 180000) {
  const s = await page.evaluate(() => { const st = document.getElementById('status'); return (st.hidden ? '(hidden)' : document.getElementById('statusT').textContent) + ' | ' + window.__scan.pages.map((p) => p.state).join(','); });
  if (s !== last) { console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), s); last = s; }
  if (/ready/.test(s)) { done = true; break; }
  await new Promise((r) => setTimeout(r, 250));
}
console.log('chosen:', JSON.stringify(await page.evaluate(() => ({ dpi: window.__scan.pages[0].dpi, hot: window.__scan.hot, impl: window.__scan.impl, cold: window.__scan.cold }))));
console.log(JSON.stringify(await page.evaluate(() => window.__scan.pages[0].t)), 'longest main-thread freeze (ms):', Math.round(await page.evaluate(() => window.__gap)));
console.log(done ? 'ready after ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s at throttle ' + rate : 'NOT READY after 180 s at throttle ' + rate);
await browser.close(); if (srv) srv.close();
process.exit(done ? 0 : 1);


