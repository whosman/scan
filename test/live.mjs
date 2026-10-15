// Checks the published site: service worker, live camera over https, offline reload.
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'https://whosman.github.io/scan/';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new', args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const pg = await b.newPage();
await pg.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
pg.on('pageerror', (e) => console.log('[pageerror]', e.message));
await pg.goto(url, { waitUntil: 'networkidle2' });
await pg.waitForFunction(() => !document.getElementById('home').hidden, { timeout: 15000 });
const sw = await pg.evaluate(async () => { const r = await navigator.serviceWorker.ready; await new Promise((s) => setTimeout(s, 1500)); const k = await caches.keys(); const c = await caches.open(k[0]); return { active: !!r.active, cached: (await c.keys()).length }; });
console.log('service worker active:', sw.active, '| files cached:', sw.cached);
await pg.click('#hCam');
await pg.waitForFunction(() => !document.getElementById('cam').hidden && document.getElementById('cv').videoWidth > 0, { timeout: 10000 });
await pg.click('#shutter'); await new Promise((s) => setTimeout(s, 500));
console.log('live camera over https:', await pg.$eval('#cn', (e) => e.textContent));
await pg.click('#cDone');
await pg.setOfflineMode(true); await pg.reload();
await pg.waitForFunction(() => !document.getElementById('home').hidden, { timeout: 15000 });
console.log('offline reload works:', await pg.$eval('#hGo', (e) => e.textContent));
await pg.screenshot({ path: 'test/out/e2e/live_home.png' });
await b.close();

