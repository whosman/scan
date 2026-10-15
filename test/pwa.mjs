// Home Screen app checks: manifest, icons, and the app opening offline after one visit.
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('no'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise((r) => srv.listen(8793, '127.0.0.1', r));

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:8793/');
await page.waitForFunction(() => !document.getElementById('landing').hidden, { timeout: 10000 });
const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; await new Promise((res) => setTimeout(res, 800)); const keys = await caches.keys(); const c = await caches.open(keys[0]); return { active: !!r.active, cached: (await c.keys()).map((k) => new URL(k.url).pathname) }; });
console.log('service worker active:', sw.active, '| cached:', sw.cached.join(', '));
console.log('manifest linked:', await page.$eval('link[rel=manifest]', (e) => e.getAttribute('href')), '| touch icon:', await page.$eval('link[rel=apple-touch-icon]', (e) => e.getAttribute('href')));
await page.setOfflineMode(true);
await page.reload();
await page.waitForFunction(() => !document.getElementById('landing').hidden, { timeout: 10000 });
console.log('offline reload ok, home screen shows:', await page.$eval('#lSub', (e) => e.textContent));
await browser.close(); srv.close();
