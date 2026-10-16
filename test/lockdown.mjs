// A stand-in for an iPhone in Lockdown Mode, which is what the first real report looked like:
// no JIT (V8 --jitless, which also removes WebAssembly), no FileReader, no camera API.
// The page must still open a photo, finish a page, and the "Check this phone" report must complete.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const root = path.resolve('.');
const srv = http.createServer((req, res) => { let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); res.end(fs.readFileSync(f)); });
await new Promise((r) => srv.listen(8799, '127.0.0.1', r));
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox', '--js-flags=--jitless'] });
let bad = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) bad++; };
async function fresh() {
  const page = await browser.newPage();
  await page.setViewport({ width: 320, height: 568, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await page.evaluateOnNewDocument(() => { delete window.FileReader; delete window.WebAssembly; Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:8799/');
  return page;
}
// 1. a page, start to finish
let page = await fresh();
ok(await page.evaluate(() => typeof FileReader === 'undefined' && typeof WebAssembly === 'undefined'), 'FileReader and WebAssembly are gone in this page');
await (await page.$('#fPick')).uploadFile(path.resolve('../IMG_6142.jpeg'));
await page.waitForFunction(() => !document.getElementById('hGo').disabled);
const t0 = Date.now(); await page.click('#hGo');
await page.waitForFunction(() => window.__scan.pages[0].state === 'ready' || window.__scan.pages[0].state === 'error', { timeout: 120000 });
const st = await page.evaluate(() => ({ state: window.__scan.pages[0].state, dpi: window.__scan.pages[0].dpi, err: window.__scan.pages[0].error, impl: window.__scan.impl }));
ok(st.state === 'ready', 'page ready in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s at ' + st.dpi + ' dpi, ' + st.impl + (st.err ? ' | ' + st.err : ''));
// save it
await page.evaluate(() => document.getElementById('bSave').click());
await page.waitForFunction(() => window.__scan.pdf && window.__scan.pdf.size, { timeout: 120000 }).catch(() => {});
ok(await page.evaluate(() => !!(window.__scan.pdf && window.__scan.pdf.size)), 'PDF saved: ' + await page.evaluate(() => window.__scan.pdf && window.__scan.pdf.size) + ' bytes');
await page.close();
// 2. the report completes
page = await fresh();
await page.evaluate(() => window.__diag());
await page.waitForFunction(() => /Verdict|FAILED/.test(document.getElementById('dOut').textContent), { timeout: 180000 });
const rep = await page.evaluate(() => document.getElementById('dOut').textContent);
console.log(rep.split('\n').filter((l) => /Worker|camera|canvas|Verdict|FAILED|Total|JavaScript|working res/.test(l)).join('\n'));
ok(/Verdict/.test(rep), 'the report finishes');
await browser.close(); srv.close(); process.exit(bad ? 1 : 0);
