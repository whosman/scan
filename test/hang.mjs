// Fault injection: the worker goes silent on the first analysis (as when iOS ends a worker for memory).
// The page must notice, replace the worker, and finish on the retry instead of sitting on "Reading the photo".
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const root = path.resolve('.');
const srv = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(fs.readFileSync(f)); });
await new Promise((r) => srv.listen(8797, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 320, height: 568, hasTouch: true, isMobile: true });
await page.evaluateOnNewDocument(() => {
  const orig = Worker.prototype.postMessage; let dropped = 0;
  Worker.prototype.postMessage = function (m, t) { if (m && m.type === 'analyze' && dropped < 1) { dropped++; window.__dropped = dropped; return; } return orig.call(this, m, t); };
});
await page.goto('http://127.0.0.1:8797/');
await (await page.$('#fPick')).uploadFile(path.resolve('../IMG_6142.jpeg'));
await page.waitForFunction(() => !document.getElementById('hGo').disabled);
const t0 = Date.now(); await page.click('#hGo');
let ok = false;
while (Date.now() - t0 < 120000) {
  const st = await page.evaluate(() => window.__scan.pages[0].state + ' | ' + document.getElementById('statusT').textContent);
  if (/^ready/.test(st)) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 1000));
}
console.log(ok ? 'ok   recovered after ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s (a silent worker was replaced)' : 'FAIL still stuck after 120 s');
await browser.close(); srv.close(); process.exit(ok ? 0 : 1);
