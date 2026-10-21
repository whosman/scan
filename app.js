/* app.js - UI for HW Scan. All processing stays on the phone. MIT licence. */
(function () {
  'use strict';
  const T = (k, v) => I18N.t(k, v);
  const $ = (id) => document.getElementById(id);
  const MAX_SIDE = 2400;            // cap the photo size: old phones have little memory
  const pages = [];                 // see newPage()
  let nextId = Date.now(), worker = null, queue = Promise.resolve(), lastPdf = null, statusKey = 'loading', engineReady = false;
  const pending = new Map();

  // ---------- settings remembered on this phone only ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hwscan.' + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('hwscan.' + k, v); } catch (e) { /* private mode */ } },
  };
  const BOX = { advanced: 'checkbox', autorotate: 'checkbox', searchable: 'checkbox' };
  const DEFAULTS = { name: '', paper: 'letter', quality: '200', look: 'color', bleed: 'normal', autorotate: '1', searchable: '', advanced: '', lang: '' };
  function loadSettings() {
    for (const k of Object.keys(DEFAULTS)) {
      const v = store.get(k, DEFAULTS[k]);
      if (BOX[k]) $(k).checked = v === '1'; else if (k !== 'lang') $(k).value = v;
    }
  }
  function saveSetting(k) { store.set(k, BOX[k] ? ($(k).checked ? '1' : '') : $(k).value); }
  const setting = (k) => BOX[k] ? $(k).checked : $(k).value;

  // ---------- language ----------
  for (const [code, name] of Object.entries(I18N.LANGS)) { const o = document.createElement('option'); o.value = code; o.textContent = name; $('lang').appendChild(o); }
  function applyLang(l) {
    $('lang').value = I18N.set(l);
    setStatus(statusKey); render(); if (!$('editor').hidden) drawEditor();
    $('install').hidden = !deferredInstall;
    $('installhelp').hidden = !!deferredInstall;
  }

  // ---------- small helpers ----------
  function setStatus(key) { statusKey = key; $('status').textContent = T(key); }
  function toBlob(canvas, type, q) { return new Promise((res) => canvas.toBlob(res, type || 'image/jpeg', q)); }
  function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function el(tag, cls, text) { const x = document.createElement(tag); if (cls) x.className = cls; if (text) x.textContent = text; return x; }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- worker ----------
  function startWorker() {
    worker = new Worker('worker.js');
    worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
    worker.onerror = () => setStatus('crashed');
  }
  function runWorker(msg, transfer) { return new Promise((res) => { pending.set(msg.id, res); worker.postMessage(msg, transfer); }); }

  // ---------- one page ----------
  function newPage() {
    return { id: nextId++, src: null, sw: 0, sh: 0, quad: null, w: 0, h: 0, blob: null, info: null, rot: 0, look: setting('look'), light: 0, busy: true, error: false, ver: 0 };
  }
  async function decodeFile(file) { // EXIF rotation is applied by the browser; the saved copy is already upright
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); }); }
    const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = canvasOf(w, h), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return { blob: await toBlob(c, 'image/jpeg', 0.9), w, h };
  }
  async function clean(pg, quad) { // photo -> clean colour page; sets pg.blob, pg.info, pg.quad
    const bmp = await createImageBitmap(pg.src), c = canvasOf(bmp.width, bmp.height), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0); if (bmp.close) bmp.close();
    const img = g.getImageData(0, 0, c.width, c.height);
    const opts = { paper: setting('paper') === 'a4' ? 'a4' : 'letter', dpi: +setting('quality'), bleed: setting('bleed'), autorotate: setting('autorotate') };
    if (quad) opts.quad = quad;
    const r = await runWorker({ id: pg.id, width: img.width, height: img.height, rgba: img.data.buffer, opts }, [img.data.buffer]);
    if (!r.ok) throw new Error(r.error);
    const rgb = new Uint8Array(r.color), out = canvasOf(r.width, r.height), og = out.getContext('2d'), id = og.createImageData(r.width, r.height), d = id.data;
    for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = rgb[i]; d[j + 1] = rgb[i + 1]; d[j + 2] = rgb[i + 2]; d[j + 3] = 255; }
    og.putImageData(id, 0, 0);
    const t1 = Date.now(); pg.blob = await toBlob(out, 'image/jpeg', 0.92); pg.w = r.width; pg.h = r.height; pg.info = r.info; pg.info.ms = r.ms; pg.info.msEncode = Date.now() - t1;
    pg.quad = r.info.quad || null; pg.rot = 0; pg.ver++; pg._th = null;
  }
  function persist(pg) {
    if (pg.busy || pg.error || !pg.blob) return;
    HWDB.putPage({ id: pg.id, src: pg.src, sw: pg.sw, sh: pg.sh, quad: pg.quad, w: pg.w, h: pg.h, blob: pg.blob, info: pg.info, rot: pg.rot, look: pg.look, light: pg.light });
  }
  const persistOrder = () => HWDB.setOrder(pages.map((p) => p.id));

  function addFiles(files, replaceId) {
    for (const f of files) {
      let pg;
      if (replaceId) { pg = pages.find((p) => p.id === replaceId); pg.busy = true; pg.error = false; pg.info = null; }
      else { pg = newPage(); pages.push(pg); }
      replaceId = null; render();
      queue = queue.then(async () => {
        setStatus('cleaning');
        try {
          const d = await decodeFile(f);
          pg.src = d.blob; pg.sw = d.w; pg.sh = d.h;
          await clean(pg, null);
        } catch (err) { pg.error = true; }
        pg.busy = false; render(); persist(pg); persistOrder(); setStatus('ready');
      });
    }
  }
  function reclean(pg, quad) {
    pg.busy = true; pg.error = false; render();
    queue = queue.then(async () => {
      setStatus('cleaning');
      try { await clean(pg, quad); } catch (err) { pg.error = true; }
      pg.busy = false; render(); if (!$('editor').hidden && cur() === pg) drawEditor(); persist(pg); setStatus('ready');
    });
  }
  function retake(pg) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
    inp.onchange = () => { if (inp.files.length) { showView('home'); addFiles([...inp.files], pg.id); } };
    inp.click();
  }

  // ---------- drawing a page the way the student chose to see it ----------
  function lutFor(look, light) {
    const lut = new Uint8Array(256);
    if (look === 'bw') { const t = 165 - light * 1.2; for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, Math.round((v - (t - 25)) * 255 / 50))); }
    else { const g = Math.pow(2, -light / 40); for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * Math.pow(v / 255, g)); }
    return lut;
  }
  async function drawPage(pg, maxSide) { // returns a canvas: rotated, with the chosen look
    const bmp = await createImageBitmap(pg.blob), turn = pg.rot % 2 === 1, W0 = turn ? pg.h : pg.w, H0 = turn ? pg.w : pg.h;
    const s = maxSide ? Math.min(1, maxSide / Math.max(W0, H0)) : 1, W = Math.max(1, Math.round(W0 * s)), H = Math.max(1, Math.round(H0 * s));
    const c = canvasOf(W, H), g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high'; g.translate(W / 2, H / 2); g.rotate(pg.rot * Math.PI / 2);
    g.drawImage(bmp, -pg.w * s / 2, -pg.h * s / 2, pg.w * s, pg.h * s);
    if (bmp.close) bmp.close();
    if (pg.look !== 'color' || pg.light !== 0) {
      const id = g.getImageData(0, 0, W, H), d = id.data, lut = lutFor(pg.look, pg.light), gray = pg.look !== 'color';
      for (let i = 0; i < d.length; i += 4) {
        if (gray) { const y = lut[(d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8]; d[i] = d[i + 1] = d[i + 2] = y; }
        else { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
      }
      g.putImageData(id, 0, 0);
    }
    return c;
  }
  function thumbOf(pg) {
    const key = [pg.ver, pg.rot, pg.look, pg.light].join();
    if (pg._th && pg._thKey === key) return Promise.resolve(pg._th);
    return drawPage(pg, 192).then((c) => { pg._th = c; pg._thKey = key; return c; });
  }

  // ---------- page list ----------
  function render() {
    const box = $('pages'); box.innerHTML = '';
    if (!pages.length) { const e = el('p', 'quiet', T('none')); e.id = 'empty'; box.appendChild(e); }
    $('camlabel').textContent = T(pages.length ? 'takeMore' : 'take');
    pages.forEach((pg, i) => {
      const row = el('div', 'page'), meta = el('div', 'meta');
      if (!pg.busy && !pg.error) {
        const th = el('canvas', 'thumb'); th.setAttribute('role', 'img'); th.setAttribute('aria-label', T('preview', { n: i + 1 })); th.onclick = () => openEditor(i);
        thumbOf(pg).then((c) => { th.width = c.width; th.height = c.height; th.getContext('2d').drawImage(c, 0, 0); });
        row.appendChild(th);
      }
      meta.appendChild(el('h3', '', T('page', { n: i + 1 })));
      if (pg.busy) meta.appendChild(el('div', 'busy', T('cleaningPage')));
      else if (pg.error) meta.appendChild(el('p', 'warn note', T('cantRead')));
      else {
        const w = (pg.info && pg.info.warn) || [];
        for (const x of w) meta.appendChild(el('p', 'warn note', I18N.warn(x)));
        if (!w.length) meta.appendChild(el('div', 'quiet', T('good')));
      }
      row.appendChild(meta);
      const tools = el('div', 'tools');
      const b = (label, fn, dis) => { const x = el('button', '', label); x.type = 'button'; x.disabled = !!dis; x.onclick = fn; tools.appendChild(x); };
      b(T('edit'), () => openEditor(i), pg.busy || pg.error);
      b(T('retake'), () => retake(pg), pg.busy);
      b(T('up'), () => { pages.splice(i, 1); pages.splice(i - 1, 0, pg); persistOrder(); render(); }, i === 0);
      b(T('down'), () => { pages.splice(i, 1); pages.splice(i + 1, 0, pg); persistOrder(); render(); }, i === pages.length - 1);
      b(T('remove'), () => { pages.splice(i, 1); HWDB.delPage(pg.id); persistOrder(); render(); }, pg.busy);
      row.appendChild(tools); box.appendChild(row);
    });
    $('make').disabled = !engineReady || !pages.length || pages.some((p) => p.busy) || pages.every((p) => p.error);
    $('clear').hidden = !pages.length; $('clear').textContent = T('startOver');
  }
  $('clear').addEventListener('click', async () => {
    if (pages.some((p) => p.busy)) return;
    if ($('clear').textContent !== T('startOverAsk')) { $('clear').textContent = T('startOverAsk'); return; }
    pages.length = 0; lastPdf = null; $('result').hidden = true; $('restored').hidden = true; await HWDB.clear(); render();
  });

  // ---------- views ----------
  function showView(v) { for (const id of ['home', 'editor', 'cropper']) $(id).hidden = id !== v; window.scrollTo(0, 0); }
  let editing = null;
  const cur = () => editing;

  // ---------- page editor ----------
  function openEditor(i) { editing = pages[i]; if (!editing || editing.busy || editing.error) return; $('edtitle').textContent = T('page', { n: i + 1 }); showView('editor'); drawEditor(); }
  let drawTicket = 0;
  async function drawEditor() {
    const pg = editing; if (!pg || pg.busy || !pg.blob) return;
    const tk = ++drawTicket, c = await drawPage(pg, Math.min(1400, Math.round(Math.min(window.innerWidth, 560) * (window.devicePixelRatio || 1))));
    if (tk !== drawTicket) return;
    const p = $('prev'); p.width = c.width; p.height = c.height; p.getContext('2d').drawImage(c, 0, 0);
    p.setAttribute('aria-label', $('edtitle').textContent);
    for (const b of document.querySelectorAll('#looks button')) b.setAttribute('aria-pressed', b.getAttribute('data-look') === pg.look ? 'true' : 'false');
    $('light').value = pg.light;
    $('eddetails').hidden = !setting('advanced'); $('edinfo').textContent = JSON.stringify(pg.info, (k, v) => typeof v === 'number' ? Math.round(v * 100) / 100 : v, 1);
  }
  for (const b of document.querySelectorAll('#looks button')) b.addEventListener('click', () => { editing.look = b.getAttribute('data-look'); persist(editing); drawEditor(); });
  $('light').addEventListener('input', () => { editing.light = +$('light').value; drawEditor(); });
  $('light').addEventListener('change', () => persist(editing));
  $('edleft').addEventListener('click', () => { editing.rot = (editing.rot + 3) % 4; persist(editing); drawEditor(); });
  $('edright').addEventListener('click', () => { editing.rot = (editing.rot + 1) % 4; persist(editing); drawEditor(); });
  $('edretake').addEventListener('click', () => retake(editing));
  $('edwhole').addEventListener('click', () => { const pg = editing; showView('home'); reclean(pg, [[0, 0], [pg.sw - 1, 0], [pg.sw - 1, pg.sh - 1], [0, pg.sh - 1]]); });
  $('eddone').addEventListener('click', () => { editing = null; showView('home'); render(); });

  // ---------- corner editor ----------
  let crop = null; // { pg, img, scale, pts, drag }
  $('edcrop').addEventListener('click', async () => {
    const pg = editing, bmp = await createImageBitmap(pg.src), c = $('cropc');
    const maxW = Math.min(window.innerWidth - 32, 560), s = Math.min(maxW / pg.sw, (window.innerHeight * 0.65) / pg.sh);
    c.width = Math.round(pg.sw * s); c.height = Math.round(pg.sh * s);
    const m = 0.08, pts = pg.quad ? pg.quad.map((p) => [p[0] * s, p[1] * s]) : [[c.width * m, c.height * m], [c.width * (1 - m), c.height * m], [c.width * (1 - m), c.height * (1 - m)], [c.width * m, c.height * (1 - m)]];
    crop = { pg, bmp, s, pts, drag: -1 }; showView('cropper'); drawCrop();
  });
  function drawCrop() {
    const c = $('cropc'), g = c.getContext('2d'), P = crop.pts;
    g.drawImage(crop.bmp, 0, 0, c.width, c.height);
    g.lineWidth = 3; g.strokeStyle = '#fff'; g.beginPath(); P.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.closePath(); g.stroke();
    g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke();
    for (const p of P) { g.beginPath(); g.arc(p[0], p[1], 14, 0, 7); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#000'; g.stroke(); }
  }
  function cropPos(e) { const r = $('cropc').getBoundingClientRect(), c = $('cropc'); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; }
  $('cropc').addEventListener('pointerdown', (e) => {
    const [x, y] = cropPos(e), k = $('cropc').width / $('cropc').getBoundingClientRect().width; let best = -1, bd = 36 * k;
    crop.pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
    crop.drag = best; if (best >= 0) { try { $('cropc').setPointerCapture(e.pointerId); } catch (err) { /* old browsers */ } e.preventDefault(); }
  });
  $('cropc').addEventListener('pointermove', (e) => {
    if (!crop || crop.drag < 0) return; const [x, y] = cropPos(e), c = $('cropc');
    crop.pts[crop.drag] = [Math.max(0, Math.min(c.width - 1, x)), Math.max(0, Math.min(c.height - 1, y))]; drawCrop(); e.preventDefault();
  });
  const endDrag = () => { if (crop) crop.drag = -1; };
  $('cropc').addEventListener('pointerup', endDrag); $('cropc').addEventListener('pointercancel', endDrag);
  function order4(p) { // tl, tr, br, bl whatever order the student dragged them into
    const sum = p.map((q) => q[0] + q[1]), dif = p.map((q) => q[0] - q[1]), ix = (a, f) => a.indexOf(f(...a));
    return [p[ix(sum, Math.min)], p[ix(dif, Math.max)], p[ix(sum, Math.max)], p[ix(dif, Math.min)]];
  }
  function closeCrop() { if (crop && crop.bmp.close) crop.bmp.close(); crop = null; }
  $('cropcancel').addEventListener('click', () => { closeCrop(); showView('editor'); drawEditor(); });
  $('cropauto').addEventListener('click', () => { const pg = crop.pg; closeCrop(); showView('home'); reclean(pg, null); });
  $('cropok').addEventListener('click', () => {
    const pg = crop.pg, q = order4(crop.pts).map((p) => [p[0] / crop.s, p[1] / crop.s]); closeCrop(); showView('home'); reclean(pg, q);
  });

  // ---------- PDF ----------
  const PAPER = { letter: [8.5, 11.0], a4: [8.27, 11.69] };
  function fileName() { return ($('name').value.trim() || 'Homework').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.pdf$/i, ''); }
  async function fitCanvas(pg) { // the page on its sheet of paper
    const pic = await drawPage(pg, 0), dpi = +setting('quality'), paper = setting('paper');
    if (paper === 'fit') return { c: pic, ptW: Math.round(pic.width / dpi * 72), ptH: Math.round(pic.height / dpi * 72) };
    const [wi, hi] = PAPER[paper], Wp = Math.round(wi * dpi), Hp = Math.round(hi * dpi), m = Math.round(0.25 * dpi);
    const s = Math.min((Wp - 2 * m) / pic.width, (Hp - 2 * m) / pic.height), w = Math.round(pic.width * s), h = Math.round(pic.height * s);
    const c = canvasOf(Wp, Hp), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, Wp, Hp); g.imageSmoothingQuality = 'high';
    g.drawImage(pic, Math.round((Wp - w) / 2), Math.round((Hp - h) / 2), w, h);
    return { c, ptW: Math.round(wi * 72), ptH: Math.round(hi * 72) };
  }
  async function bytesOf(canvas, pg) { return new Uint8Array(await (await toBlob(canvas, 'image/jpeg', pg.look === 'bw' ? 0.7 : 0.8)).arrayBuffer()); }
  $('make').addEventListener('click', async () => {
    $('make').disabled = true; $('result').hidden = true; setStatus('making');
    const good = pages.filter((p) => !p.error), out = [], ocr = setting('searchable') && window.HWOCR; let ocrFailed = false;
    try {
      for (let i = 0; i < good.length; i++) {
        const pg = good[i], f = await fitCanvas(pg), item = { jpeg: await bytesOf(f.c, pg), pxW: f.c.width, pxH: f.c.height, ptW: f.ptW, ptH: f.ptH, gray: false };
        if (ocr) {
          $('status').textContent = T('reading', { n: i + 1, total: good.length });
          try { item.words = await HWOCR.read(f.c, I18N.lang); } catch (e) { ocrFailed = true; /* no text layer; the page itself is fine */ }
        }
        out.push(item); f.c.width = 0;
      }
      const name = fileName(), bytes = PDFMini.makePDF(out, name, { lang: I18N.lang });
      lastPdf = { file: new File([bytes], name + '.pdf', { type: 'application/pdf' }), pages: out.length };
      $('pdfinfo').textContent = T('pdfInfo', { pages: I18N.count(out.length), mb: (bytes.length / 1e6).toFixed(1) }) + '. ' + T('pdfHelp', { name: lastPdf.file.name }) + (ocrFailed ? ' ' + T('searchFail') : '');
      $('result').hidden = false; $('share').hidden = !canShareFiles([lastPdf.file]);
      await deliver(lastPdf.file);
    } catch (err) { setStatus('crashed'); }
    $('make').disabled = false; setStatus('ready');
  });
  const canShareFiles = (files) => !!(navigator.canShare && navigator.canShare({ files }));
  function download(file) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  async function deliver(file) { // share sheet if the phone has one, otherwise save
    if (canShareFiles([file])) {
      try { await navigator.share({ files: [file], title: file.name }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; /* closed the share sheet; anything else falls back to saving */ }
    }
    download(file);
  }
  $('share').addEventListener('click', () => lastPdf && navigator.share({ files: [lastPdf.file], title: lastPdf.file.name }).catch(() => {}));
  $('save').addEventListener('click', () => lastPdf && download(lastPdf.file));
  $('pics').addEventListener('click', async () => {
    const files = [], base = fileName(), good = pages.filter((p) => !p.error);
    for (let i = 0; i < good.length; i++) { const f = await fitCanvas(good[i]); files.push(new File([await toBlob(f.c, 'image/jpeg', 0.9)], base + '-' + (i + 1) + '.jpg', { type: 'image/jpeg' })); }
    if (canShareFiles(files)) { try { await navigator.share({ files }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    for (const f of files) { download(f); await wait(400); }
  });

  // ---------- settings ----------
  for (const k of Object.keys(BOX).concat(['name', 'paper', 'quality', 'look', 'bleed'])) $(k).addEventListener('change', () => saveSetting(k));
  $('advanced').addEventListener('change', () => { $('advopts').hidden = !$('advanced').checked; });
  $('lang').addEventListener('change', () => { store.set('lang', $('lang').value); applyLang($('lang').value); });
  $('erase').addEventListener('click', async () => {
    if ($('erase').textContent !== T('eraseAsk')) { $('erase').textContent = T('eraseAsk'); setTimeout(() => { $('erase').textContent = T('erase'); }, 4000); return; }
    pages.length = 0; lastPdf = null; $('result').hidden = true; await HWDB.clear();
    try { localStorage.clear(); } catch (e) { /* nothing to clear */ }
    if ('caches' in window) { /* the app files stay: the phone still works offline */ }
    loadSettings(); $('advopts').hidden = true; render(); $('erase').textContent = T('erased'); setTimeout(() => { $('erase').textContent = T('erase'); }, 2500);
  });
  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('install').hidden = false; $('installhelp').hidden = true; });
  $('install').addEventListener('click', () => { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; $('install').hidden = true; } });

  // keyboard use of the two picker buttons (they are labels)
  for (const [lab, inp] of [['camlabel', 'cam'], ['gallabel', 'gal']]) {
    $(lab).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(inp).click(); } });
  }
  $('cam').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('gal').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

  // ---------- start ----------
  loadSettings(); $('advopts').hidden = !$('advanced').checked;
  applyLang(store.get('lang', '') || I18N.detect());
  startWorker();
  runWorker({ id: 0, width: 4, height: 4, rgba: new Uint8ClampedArray(64).buffer, opts: { dpi: 50 } }) // warm up
    .then(() => { engineReady = true; setStatus('ready'); render(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  HWDB.loadAll().then((saved) => {
    if (!saved.length || pages.length) return;
    for (const r of saved) { pages.push(Object.assign(newPage(), r, { busy: false, error: false, ver: 0 })); nextId = Math.max(nextId, r.id + 1); }
    $('restored').hidden = false; render();
  });
  render();
})();
