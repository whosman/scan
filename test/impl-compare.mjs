import { webkit } from 'playwright-core';
import puppeteer from 'puppeteer-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const photos = ['../IMG_6142.jpeg', '../IMG_6145.jpeg', '../IMG_6146.jpeg', '../IMG_6147.jpeg'].map((f) => path.resolve(f));
const root = path.resolve('.'), types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f)); });
await new Promise((r) => srv.listen(8796, '127.0.0.1', r));
const url = 'http://127.0.0.1:8796/';
async function trial(name, page0, upload) {
  const page = name === 'WebKit' ? page0 : { goto: (u) => page0.goto(u), evaluate: (f) => page0.evaluate(f), click: (s) => page0.click(s), waitForFunction: (f, a, o) => page0.waitForFunction(f, o) };
  await page.goto(url);
  await page.waitForFunction(() => window.__scan && window.__scan.hot, null, { timeout: 30000 });
  const info = await page.evaluate(() => ({ impl: window.__scan.impl, hot: +window.__scan.hot.toFixed(1), js: +(window.__scan.jsHot || 0).toFixed(1), wasm: +(window.__scan.wasmHot || 0).toFixed(1), note: window.__scan.note || '' }));
  await upload(); await page.waitForFunction(() => !document.getElementById('hGo').disabled);
  const t = Date.now(); await page.click('#hGo');
  await page.waitForFunction(() => window.__scan.pages[0].state === 'ready', null, { timeout: 120000 });
  const first = Date.now() - t;
  await page.waitForFunction(() => window.__scan.pages.every((p) => p.state === 'ready'), null, { timeout: 120000 });
  const all = Date.now() - t;
  const per = await page.evaluate(() => window.__scan.pages.map((p) => p.t.worker));
  console.log(name.padEnd(9), JSON.stringify(info), '| first page', (first / 1000).toFixed(2) + 's', '| 4 pages', (all / 1000).toFixed(2) + 's', '| worker ms per page', per.join(' '));
}
for (let i = 0; i < 2; i++) {
  const b = await webkit.launch(); const c = await b.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true }); const p = await c.newPage();
  await trial('WebKit', p, () => p.setInputFiles('#fPick', photos)); await b.close();
}
for (let i = 0; i < 2; i++) {
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage(); await p.setViewport({ width: 320, height: 568, isMobile: true, hasTouch: true });
  await trial('Chromium', p, async () => { await (await p.$('#fPick')).uploadFile(...photos); }); await b.close();
}
srv.close();
