// run the in-app phone check in WebKit and Chromium
import { webkit } from 'playwright-core';
import puppeteer from 'puppeteer-core';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve('.');
const srv = http.createServer((req, res) => { let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html' : p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); res.end(fs.readFileSync(f)); });
await new Promise((r) => srv.listen(8798, '127.0.0.1', r));
const url = 'http://127.0.0.1:8798/';
{
  const b = await webkit.launch(); const p = await (await b.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true })).newPage();
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto(url); await p.click('#hDiag');
  await p.waitForFunction(() => !document.getElementById('dCopy').disabled, null, { timeout: 120000 });
  console.log('===== WebKit\n' + await p.textContent('#dOut')); await p.screenshot({ path: 'test/out/e2e/diag_webkit.png' }); await b.close();
}
{
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage(); await p.setViewport({ width: 320, height: 568, isMobile: true, hasTouch: true });
  p.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await p.goto(url); await p.click('#hDiag');
  await p.waitForFunction(() => !document.getElementById('dCopy').disabled, { timeout: 120000 });
  console.log('===== Chromium\n' + await p.$eval('#dOut', (e) => e.textContent)); await b.close();
}
srv.close();
