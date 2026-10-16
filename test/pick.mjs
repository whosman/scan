// "Choose files": a tap on the button opens the picker; chosen files show, even if Safari fires no event.
// Also checks the tools row: arrows sit beside the row and never over its text.
import { webkit } from 'playwright-core';
import path from 'node:path'; import http from 'node:http'; import fs from 'node:fs';
const root = path.resolve('.');
const srv = http.createServer((q, r) => { let p = new URL(q.url, 'http://x').pathname; if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' }); r.end(fs.readFileSync(f)); });
await new Promise((r) => srv.listen(8802, '127.0.0.1', r));
const b = await webkit.launch(); const c = await b.newContext({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }); const p = await c.newPage();
let bad = 0; const ok = (v, m) => { console.log(v ? 'ok  ' : 'FAIL', m); if (!v) bad++; };
const photo = path.resolve('../IMG_6142.jpeg');
await p.goto('http://127.0.0.1:8802/');
const box = await p.evaluate(() => { const r = document.getElementById('hPick').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
// 1. a real tap on the visible button reaches the file input
const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null), p.touchscreen.tap(box.x, box.y)]);
ok(!!chooser, 'tapping "Choose files" opens the picker');
if (chooser) await chooser.setFiles(photo);
await p.waitForFunction(() => document.querySelectorAll('#hThumbs .th').length === 1, null, { timeout: 5000 }).catch(() => {});
ok(await p.evaluate(() => document.querySelectorAll('#hThumbs .th').length === 1), 'the chosen photo shows on the home screen');
// 2. no event at all: the files appear in the input and nothing fires. The poll must still find them.
await p.evaluate(() => { document.getElementById('hClearA').click(); });
await p.evaluate(() => { const i = document.getElementById('fPick'); i.dispatchEvent(new Event('click')); });
await p.evaluate(async () => { const r = await fetch('/icons/icon-192.png'); const blob = await r.blob(); const dt = new DataTransfer(); dt.items.add(new File([blob], 'x.png', { type: 'image/png' })); document.getElementById('fPick').files = dt.files; });
await p.waitForFunction(() => document.querySelectorAll('#hThumbs .th').length >= 1, null, { timeout: 6000 }).catch(() => {});
ok(await p.evaluate(() => document.querySelectorAll('#hThumbs .th').length >= 1), 'files that arrive with no event are found by the poll');
// 3. the tools row
await p.evaluate(() => { document.getElementById('hClearA').click(); });
await p.setInputFiles('#fOne', [photo]);
await p.waitForFunction(() => !document.getElementById('hGo').disabled);
await p.click('#hGo'); await p.waitForFunction(() => window.__scan.pages[0].state === 'ready', null, { timeout: 60000 }); await p.waitForTimeout(400);
await p.click('#bTools'); await p.waitForTimeout(300);
const geo = await p.evaluate(() => { const g = (id) => document.getElementById(id).getBoundingClientRect(), row = g('toolsRow'), l = g('tmL'), r = g('tmR'); return { rowL: row.left, rowR: row.right, lR: l.right, rL: r.left }; });
ok(geo.rowL >= geo.lR - 0.5 && geo.rowR <= geo.rL + 0.5, 'arrows sit beside the row, not over it: ' + JSON.stringify(geo));
await p.screenshot({ path: 'test/out/tools3.png' });
await p.click('#tmR'); await p.waitForTimeout(500);
await p.screenshot({ path: 'test/out/tools4.png' });
await b.close(); srv.close(); process.exit(bad ? 1 : 0);
