// Chrome test of the whole student flow: add photos, edit a page, make the PDF, reload offline, find the pages again.
// Usage: HWSCAN_URL=http://localhost:8765/ node tests/browser_test.js photo1.jpg photo2.jpg   (THROTTLE=4 slows the CPU 4x; SHOTS=dir saves screenshots;
// OLD=1 removes createImageBitmap and pointer events, and stops the worker decoding photos, as on Safari 12, to test the fallbacks)
const puppeteer = require('puppeteer'), fs = require('fs'), path = require('path'), os = require('os');
const files = process.argv.slice(2);
const fail = (m) => { throw new Error(m); };
const ok = (c, m) => { if (!c) fail(m); console.log('ok:', m); };
(async () => {
  const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox'], protocolTimeout: 600000 });
  const page = await browser.newPage();
  await page.setViewport({ width: 360, height: 740, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const dl = path.join(os.tmpdir(), 'hwscan-dl'); fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl);
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const shot = async (name) => { if (process.env.SHOTS) { fs.mkdirSync(process.env.SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.SHOTS, name + '.png'), fullPage: true }); } };
  const ready = () => page.waitForFunction(() => /^Ready/.test(document.getElementById('status').textContent), { timeout: 120000 });
  const idle = (n) => page.waitForFunction((n) => document.querySelectorAll('.page').length === n && !document.querySelector('.busy'), { timeout: 600000 }, n);

  if (process.env.OLD) await page.evaluateOnNewDocument(() => { window.createImageBitmap = undefined; window.PointerEvent = undefined; });
  const t0 = Date.now();
  await page.goto((process.env.HWSCAN_URL || 'http://localhost:8765/') + (process.env.OLD ? '?nooffscreen' : ''), { waitUntil: 'load' });
  await ready(); console.log('app ready in', Date.now() - t0, 'ms');
  const throttle = +(process.env.THROTTLE || 1);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.$eval('#name', el => { el.value = 'TEST-HW01-Student'; el.dispatchEvent(new Event('change')); });
  await shot('1-empty');

  // add photos
  const t1 = Date.now();
  await (await page.$('#gal')).uploadFile(...files); await idle(files.length);
  console.log(files.length, 'pages processed in', Date.now() - t1, 'ms', '(cpu throttle x' + throttle + ')');
  await page.waitForFunction((n) => document.querySelectorAll('.thumb').length === n, {}, files.length);
  ok(true, 'a preview for every page');
  console.log('warnings:', JSON.stringify(await page.$$eval('.warn', els => els.map(e => e.textContent))));
  await shot('2-pages');

  // edit page 1: look, turn, edges
  await page.click('.page .tools button'); // Edit
  await page.waitForFunction(() => !document.getElementById('editor').hidden);
  await page.click('#looks button[data-look=bw]');
  await page.waitForFunction(() => document.querySelector('#looks button[data-look=bw]').getAttribute('aria-pressed') === 'true');
  await shot('3-editor-bw');
  await page.click('#edright'); await page.click('#edleft');
  await page.click('#looks button[data-look=color]');
  await page.click('#edcrop'); await page.waitForFunction(() => !document.getElementById('cropper').hidden);
  await shot('4-crop');
  const box = await (await page.$('#cropc')).boundingBox();
  const sx = box.x + box.width * 0.2, sy = box.y + box.height * 0.2; // drag the nearest corner a little
  await page.mouse.move(sx, sy); await page.mouse.down(); await page.mouse.move(sx + 5, sy + 5); await page.mouse.up();
  await page.click('#cropok'); await idle(files.length);
  ok(true, 'edges adjusted and the page cleaned again');
  await page.click('#make');

  // PDF
  for (let i = 0; i < 80 && !fs.readdirSync(dl).some(f => f.endsWith('.pdf')); i++) await new Promise(r => setTimeout(r, 500));
  const pdfName = fs.readdirSync(dl).find(f => f.endsWith('.pdf')); ok(!!pdfName, 'the PDF was saved: ' + pdfName);
  const pdf = fs.readFileSync(path.join(dl, pdfName)).toString('latin1');
  ok(pdf.startsWith('%PDF-1.4') && pdf.includes('%%EOF'), 'the PDF has a header and an end');
  ok((pdf.match(/\/Type \/Page /g) || []).length === files.length, 'the PDF has one sheet per photo');
  ok(pdfName.startsWith('TEST-HW01-Student'), 'the PDF has the chosen name');
  ok(!(await page.$eval('#result', e => e.hidden)), 'the result card is shown');
  await shot('5-result');

  // the pages survive a reload, offline
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'load' }); await ready();
  await idle(files.length); ok(true, 'offline reload brought the pages back');
  await shot('6-restored');


  // erase
  await page.click('#settings summary'); await page.click('#erase'); await page.click('#erase');
  await page.waitForFunction(() => document.querySelectorAll('.page').length === 0);
  ok(true, 'erase removes every page');

  const bad = errors.filter(e => !/ERR_FILE_NOT_FOUND|favicon/.test(e));
  ok(bad.length === 0, 'no errors in the console' + (bad.length ? ': ' + bad.join(' | ').slice(0, 300) : ''));
  await browser.close();
})().catch(e => { console.error('TEST FAILED', e.message); process.exit(1); });
