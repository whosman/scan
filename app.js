/* app.js - UI for HW Scan. All processing stays on the phone. MIT licence. */
(function () {
  'use strict';
  window.HWSTARTED = true;
  const T = (k, v) => I18N.t(k, v);
  const $ = (id) => document.getElementById(id);
  // Cap the photo size: old phones have little memory. Phones that report 2 GB or less, or only two cores, get a smaller cap.
  const LOW_MEMORY = navigator.deviceMemory ? navigator.deviceMemory <= 2 : (navigator.hardwareConcurrency || 4) <= 2;
  let maxSide = LOW_MEMORY ? 2400 : 3600; // the longest side of a photo kept for cleaning; a 12-megapixel photo is 4000 px, so this loses almost nothing
  // Safari before 15 has no createImageBitmap: a decoded image draws the same way
  if (!window.createImageBitmap) {
    window.createImageBitmap = (blob) => new Promise((res, rej) => {
      const url = URL.createObjectURL(blob), im = new Image();
      im.onload = () => { URL.revokeObjectURL(url); res(im); }; im.onerror = (e) => { URL.revokeObjectURL(url); rej(e); }; im.src = url;
    });
  }
  const pages = [];                 // see newPage()
  let nextId = Date.now(), lastPdf = null, statusKey = 'loading', engineReady = false;
  const pending = new Map();

  // ---------- settings remembered on this phone only ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hwscan.' + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('hwscan.' + k, v); } catch (e) { /* private mode */ } },
  };
  const BOX = { advanced: 'checkbox', autorotate: 'checkbox', searchable: 'checkbox' };
  const DEFAULTS = { name: '', paper: 'letter', quality: '300', look: 'gray', autorotate: '1', searchable: '', advanced: '' };
  function loadSettings() {
    for (const k of Object.keys(DEFAULTS)) {
      const v = store.get(k, DEFAULTS[k]);
      if (BOX[k]) $(k).checked = v === '1'; else $(k).value = v;
    }
  }
  function saveSetting(k) { store.set(k, BOX[k] ? ($(k).checked ? '1' : '') : $(k).value); }
  const setting = (k) => BOX[k] ? $(k).checked : $(k).value;

  // ---------- language ----------
  function applyLang() {
    I18N.set('en');
    setStatus(statusKey); render(); if (!$('editor').hidden) drawEditor();
    $('install').hidden = !deferredInstall;
    $('installhelp').hidden = !!deferredInstall;
  }

  // ---------- small helpers ----------
  function setStatus(key) { statusKey = key; $('status').textContent = key === 'ready' ? '' : T(key); }
  function toBlob(canvas, type, q) { return new Promise((res) => canvas.toBlob(res, type || 'image/jpeg', q)); }
  function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function el(tag, cls, text) { const x = document.createElement(tag); if (cls) x.className = cls; if (text) x.textContent = text; return x; }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- workers ----------
  // One worker a core (at most three, one fewer than the cores so the page stays responsive). Pages are cleaned side by side.
  const LANES = LOW_MEMORY ? 1 : Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  const lanes = [], idle = [], jobs = [];
  let running = 0, canOffscreen = false, slowMode = false; // slowMode: the phone has no WebAssembly, so the engine runs as plain JavaScript
  function startLane(i) {
    const w = new Worker('worker.js' + (/nooffscreen/.test(location.search) ? '?nooffscreen' : /nowasm/.test(location.search) ? '?nowasm' : '')); // ?nooffscreen: test the path for browsers that cannot decode in a worker
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { canOffscreen = !!m.canOffscreen; if (m.slow && !slowMode) { slowMode = true; maxSide = Math.min(maxSide, 1200); } if (readyLanes.add(i).size === LANES) engineIsReady(); return; }
      const p = pending.get(m.id); if (!p) return;
      if (m.type === 'decoded') { if (p.onDecoded) p.onDecoded(m); return; }
      pending.delete(m.id); clearTimeout(p.timer); p.res(m);
    };
    w.onerror = () => setStatus('crashed');
    lanes[i] = w;
  }
  const readyLanes = new Set();
  function restartLane(i) { // a job that never answers must not freeze the app
    try { lanes[i].terminate(); } catch (e) { /* already gone */ }
    for (const [id, p] of pending) if (p.lane === i) { pending.delete(id); clearTimeout(p.timer); p.res({ ok: false, error: 'restart' }); }
    startLane(i);
  }
  function submit(msg, transfer, lane, onDecoded) {
    return new Promise((res) => {
      const p = { res, onDecoded, lane }; pending.set(msg.id, p);
      p.timer = setTimeout(() => { if (pending.has(msg.id)) { pending.delete(msg.id); res({ ok: false, error: 'timeout' }); restartLane(lane); } }, slowMode ? 900000 : 120000);
      lanes[lane].postMessage(msg, transfer);
    });
  }
  function enqueue(job) { jobs.push(job); pump(); } // job(lane) runs on the first free worker
  function pump() {
    while (jobs.length && idle.length && engineReady) {
      const lane = idle.shift(), job = jobs.shift();
      running++; setStatus('cleaning');
      Promise.resolve().then(() => job(lane)).catch(() => { /* the job marks its own page */ }).then(() => {
        running--; idle.push(lane);
        if (!running && !jobs.length) setStatus('ready');
        pump();
      });
    }
  }
  function engineIsReady() { engineReady = true; document.documentElement.setAttribute('data-ready', '1'); setStatus(running ? 'cleaning' : 'ready'); render(); pump(); }

  // ---------- one page ----------
  function newPage() {
    return { id: nextId++, src: null, sw: 0, sh: 0, quad: null, w: 0, h: 0, blob: null, info: null, rot: 0, look: setting('look'), light: 0, busy: true, error: false, ver: 0 };
  }
  const MARGIN = 8; // how far below the paper's white a mark must be to count as ink; ink from the back of the sheet is weaker than the writing, and the engine's ink ramp turns it white
  async function decodeMain(file) { // for browsers that cannot decode in a worker. EXIF rotation is applied by the browser.
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) { bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); }); }
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = canvasOf(w, h), g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return { canvas: c, w, h };
  }
  function thumbOfBitmap(bmp) { const c = canvasOf(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0); if (bmp.close) bmp.close(); return c; }
  // photo -> clean colour page; sets pg.blob, pg.src, pg.info, pg.quad. `file` is the photo (a File, or the saved copy when re-cleaning)
  async function clean(pg, file, quad, lane) {
    // always clean at the most the photo can give; the quality setting is applied when the PDF is made
    const opts = { paper: setting('paper') === 'a4' ? 'a4' : 'letter', dpi: slowMode ? 150 : LOW_MEMORY ? 200 : 300, margin: MARGIN, autorotate: setting('autorotate'), quad: quad || null };
    let r;
    if (canOffscreen) {
      r = await submit({ kind: 'file', id: pg.id, file, maxSide, opts }, undefined, lane, (m) => { pg.sw = m.w; pg.sh = m.h; pg.raw = thumbOfBitmap(m.thumb); render(); }); // the photo shows at once
      if (!r.ok) throw new Error(r.error);
      pg.blob = r.blob; if (r.srcBlob) { pg.src = r.srcBlob; pg.sw = r.sw; pg.sh = r.sh; }
    } else {
      const d = await decodeMain(file); pg.sw = d.w; pg.sh = d.h;
      const ts = Math.min(1, 192 / Math.max(d.w, d.h)); pg.raw = canvasOf(Math.max(1, Math.round(d.w * ts)), Math.max(1, Math.round(d.h * ts))); pg.raw.getContext('2d').drawImage(d.canvas, 0, 0, pg.raw.width, pg.raw.height); render();
      const img = d.canvas.getContext('2d').getImageData(0, 0, d.w, d.h), srcSaved = toBlob(d.canvas, 'image/jpeg', 0.92);
      r = await submit({ kind: 'rgba', id: pg.id, width: d.w, height: d.h, rgba: img.data.buffer, opts }, [img.data.buffer], lane);
      pg.src = await srcSaved; d.canvas.width = 0;
      if (!r.ok) throw new Error(r.error);
      const out = canvasOf(r.width, r.height); out.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.pixels), r.width, r.height), 0, 0);
      pg.blob = await toBlob(out, 'image/jpeg', 0.95); out.width = 0;
    }
    pg.w = r.width; pg.h = r.height; pg.info = r.info; pg.dpi = r.info.dpiEff;
    pg.quad = r.info.found ? r.info.quad : null; pg.rot = 0; pg.ver++; pg._th = null;
  }
  // Saved as plain bytes, not Blobs: some browsers cannot keep a Blob in IndexedDB, and old Safari is unreliable at it.
  const toBytes = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsArrayBuffer(blob); });
  const fromBytes = (buf) => new Blob([buf], { type: 'image/jpeg' });
  async function persist(pg) {
    if (pg.busy || pg.error || !pg.blob) return;
    const [src, blob] = await Promise.all([toBytes(pg.src), toBytes(pg.blob)]);
    if (!src || !blob) return;
    HWDB.putPage({ id: pg.id, dpi: pg.dpi, src, sw: pg.sw, sh: pg.sh, quad: pg.quad, w: pg.w, h: pg.h, blob, info: pg.info, rot: pg.rot, look: pg.look, light: pg.light });
  }
  const persistOrder = () => HWDB.setOrder(pages.map((p) => p.id));

  function addFiles(files, replaceId) {
    for (const f of files) {
      let pg;
      if (replaceId) { pg = pages.find((p) => p.id === replaceId); pg.busy = true; pg.error = false; pg.info = null; }
      else { pg = newPage(); pages.push(pg); }
      replaceId = null; render();
      enqueue(async (lane) => {
        try { await clean(pg, f, null, lane); } catch (err) { pg.error = true; }
        pg.busy = false; pg.raw = null; render(); persist(pg); persistOrder();
      });
    }
  }
  function reclean(pg, quad) {
    pg.busy = true; pg.error = false; render();
    enqueue(async (lane) => {
      try { await clean(pg, pg.src, quad, lane); } catch (err) { pg.error = true; }
      pg.busy = false; pg.raw = null; render(); if (!$('editor').hidden && cur() === pg) drawEditor(); persist(pg);
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
      if (pg.busy && pg.raw) {
        const th = el('canvas', 'thumb dim'); th.width = pg.raw.width; th.height = pg.raw.height; th.getContext('2d').drawImage(pg.raw, 0, 0); row.appendChild(th);
      }
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
    P.forEach((p, i) => { g.beginPath(); g.arc(p[0], p[1], i === crop.drag ? 9 : 14, 0, 7); g.fillStyle = '#fff'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#000'; g.stroke(); });
    drawLoupe();
  }
  // A close-up of the corner being moved, shown on the side away from the finger, so the exact spot can be seen.
  function drawLoupe() {
    const L = $('loupe'); L.hidden = crop.drag < 0; if (L.hidden) return;
    const c = $('cropc'), g = L.getContext('2d'), P = crop.pts, p = P[crop.drag], reg = 34, k = L.width / reg, bw = crop.bmp.width, bh = crop.bmp.height;
    g.fillStyle = '#fff'; g.fillRect(0, 0, L.width, L.height);
    // the part of the photo around the corner, cut to the photo's edges (some browsers refuse a source box that sticks out)
    let sx = (p[0] - reg / 2) / crop.s, sy = (p[1] - reg / 2) / crop.s; const sw = reg / crop.s, sh = reg / crop.s;
    const x0 = Math.max(0, sx), y0 = Math.max(0, sy), x1 = Math.min(bw, sx + sw), y1 = Math.min(bh, sy + sh);
    if (x1 > x0 && y1 > y0) g.drawImage(crop.bmp, x0, y0, x1 - x0, y1 - y0, (x0 - sx) / sw * L.width, (y0 - sy) / sh * L.height, (x1 - x0) / sw * L.width, (y1 - y0) / sh * L.height);
    const at = (q) => [(q[0] - p[0]) * k + L.width / 2, (q[1] - p[1]) * k + L.height / 2];
    g.beginPath(); P.forEach((q, i) => { const a = at(q); if (i) g.lineTo(a[0], a[1]); else g.moveTo(a[0], a[1]); }); g.closePath();
    g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke();
    g.beginPath(); g.arc(L.width / 2, L.height / 2, 7, 0, 7); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); g.lineWidth = 1.5; g.strokeStyle = '#000'; g.stroke();
    // put the close-up in a top corner, on the side away from the corner being moved
    const left = p[0] / c.width > 0.5;
    L.style.left = left ? '8px' : 'auto'; L.style.right = left ? 'auto' : '8px';
  }
  function cropPos(p) { const r = $('cropc').getBoundingClientRect(), c = $('cropc'); return [(p.clientX - r.left) * c.width / r.width, (p.clientY - r.top) * c.height / r.height]; }
  // Touching anywhere picks the nearest corner, and the corner then moves by the same amount as the finger. The finger never has to cover the corner.
  function dragStart(p, e) { // p: anything with clientX and clientY
    const [x, y] = cropPos(p); let best = 0, bd = Infinity;
    crop.pts.forEach((q, i) => { const d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = i; } });
    crop.drag = best; crop.from = [x, y]; crop.start = crop.pts[best].slice(); e.preventDefault(); drawCrop();
    return true;
  }
  function dragMove(p, e) {
    if (!crop || crop.drag < 0) return; const [x, y] = cropPos(p), c = $('cropc');
    crop.pts[crop.drag] = [Math.max(0, Math.min(c.width - 1, crop.start[0] + x - crop.from[0])), Math.max(0, Math.min(c.height - 1, crop.start[1] + y - crop.from[1]))]; drawCrop(); e.preventDefault();
  }
  const endDrag = () => { if (crop) { crop.drag = -1; drawCrop(); } };
  const cc = $('cropc');
  if (window.PointerEvent) {
    cc.addEventListener('pointerdown', (e) => { if (dragStart(e, e)) { try { cc.setPointerCapture(e.pointerId); } catch (err) { /* nothing to capture */ } } });
    cc.addEventListener('pointermove', (e) => dragMove(e, e));
    cc.addEventListener('pointerup', endDrag); cc.addEventListener('pointercancel', endDrag);
  } else { // Safari before 13 has touch events only
    cc.addEventListener('touchstart', (e) => { if (e.touches.length === 1) dragStart(e.touches[0], e); });
    cc.addEventListener('touchmove', (e) => { if (e.touches.length === 1) dragMove(e.touches[0], e); });
    cc.addEventListener('touchend', endDrag); cc.addEventListener('touchcancel', endDrag);
    cc.addEventListener('mousedown', (e) => dragStart(e, e)); cc.addEventListener('mousemove', (e) => dragMove(e, e));
    cc.addEventListener('mouseup', endDrag);
  }
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
  async function fitCanvas(pg, cap) { // the page on its sheet of paper, at the resolution the student chose (never more than the photo gave, or `cap`)
    const pic = await drawPage(pg, 0), paper = setting('paper'), native = pg.dpi || +setting('quality');
    const dpi = Math.min(+setting('quality'), native, cap), s0 = dpi / native, sw = Math.round(pic.width * s0), sh = Math.round(pic.height * s0);
    let c, ptW, ptH;
    if (paper === 'fit') {
      c = pic; if (s0 < 1) { c = canvasOf(sw, sh); const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(pic, 0, 0, sw, sh); }
      ptW = Math.round(c.width / dpi * 72); ptH = Math.round(c.height / dpi * 72);
    } else {
      const [wi, hi] = PAPER[paper], Wp = Math.round(wi * dpi), Hp = Math.round(hi * dpi);
      // the page is already cut to the shape of the paper, so it fills the sheet; shrinking it onto the sheet would blur the writing
      const s = Math.min(1, Wp / sw, Hp / sh), w = Math.round(sw * s), h = Math.round(sh * s);
      c = canvasOf(Wp, Hp); const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, Wp, Hp); g.imageSmoothingQuality = 'high';
      g.drawImage(pic, Math.round((Wp - w) / 2), Math.round((Hp - h) / 2), w, h);
      ptW = Math.round(wi * 72); ptH = Math.round(hi * 72);
    }
    if (pic !== c) pic.width = 0; // give the memory back at once: a phone holds only a few big canvases
    return { c, ptW, ptH };
  }
  async function bytesOf(canvas) {
    const blob = await toBlob(canvas, 'image/jpeg', +setting('quality') <= 150 ? 0.85 : 0.93);
    if (!blob) throw new Error('the phone could not make the picture'); // too big for this phone's memory
    return new Uint8Array(await blob.arrayBuffer());
  }
  // One pass over every page at a size cap. A phone that runs out of memory at full size gets a second try at a smaller size.
  async function buildPdf(cap, good, ocr) {
    const out = [], t0 = Date.now(); let ocrFailed = false, ocrSkipped = false;
    for (let i = 0; i < good.length; i++) {
      const f = await fitCanvas(good[i], cap), item = { jpeg: await bytesOf(f.c), pxW: f.c.width, pxH: f.c.height, ptW: f.ptW, ptH: f.ptH, gray: false };
      if (ocr && Date.now() - t0 > 90000) ocrSkipped = true; // the text reader gets about a minute and a half in all; the pictures are what matter
      else if (ocr) {
        $('status').textContent = T('reading', { n: i + 1, total: good.length });
        try { item.words = await HWOCR.read(f.c, I18N.lang); } catch (e) { if (e && e.message === 'slow') ocrSkipped = true; else ocrFailed = true; /* no text layer; the page itself is fine */ }
      }
      out.push(item); f.c.width = 0;
    }
    const name = fileName();
    return { bytes: PDFMini.makePDF(out, name, { lang: I18N.lang }), name, count: out.length, ocrFailed, ocrSkipped };
  }
  $('make').addEventListener('click', async () => {
    $('make').disabled = true; $('result').hidden = true; setStatus('making');
    const good = pages.filter((p) => !p.error), ocr = setting('searchable') && window.HWOCR; let res = null;
    for (const cap of [400, 220, 150]) { try { res = await buildPdf(cap, good, ocr); break; } catch (err) { /* try a smaller size */ } }
    $('make').disabled = false;
    if (!res) { setStatus('pdfFail'); return; } // keep the message on the screen
    setStatus('ready');
    lastPdf = { file: new File([res.bytes], res.name + '.pdf', { type: 'application/pdf' }), pages: res.count };
    $('pdfinfo').textContent = T('pdfInfo', { pages: I18N.count(res.count), mb: (res.bytes.length / 1e6).toFixed(1) }) + '. ' + T('pdfHelp', { name: lastPdf.file.name }) + (res.ocrFailed ? ' ' + T('searchFail') : res.ocrSkipped ? ' ' + T('searchSlow') : '');
    $('result').hidden = false; $('share').hidden = !canShareFiles([lastPdf.file]);
    $('result').scrollIntoView && $('result').scrollIntoView();
    await deliver(lastPdf.file);
  });  const canShareFiles = (files) => !!(navigator.canShare && navigator.canShare({ files }));
  function download(file) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  async function deliver(file) { // share sheet if the phone has one, otherwise save
    if (canShareFiles([file])) {
      try { await navigator.share({ files: [file] }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; /* closed the share sheet; anything else falls back to saving */ }
    }
    download(file);
  }
  $('share').addEventListener('click', () => lastPdf && navigator.share({ files: [lastPdf.file] }).catch(() => {}));
  $('save').addEventListener('click', () => lastPdf && download(lastPdf.file));
  $('pics').addEventListener('click', async () => {
    const files = [], base = fileName(), good = pages.filter((p) => !p.error);
    for (let i = 0; i < good.length; i++) { const f = await fitCanvas(good[i]); files.push(new File([await toBlob(f.c, 'image/jpeg', 0.9)], base + '-' + (i + 1) + '.jpg', { type: 'image/jpeg' })); }
    if (canShareFiles(files)) { try { await navigator.share({ files }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    for (const f of files) { download(f); await wait(400); }
  });

  // ---------- settings ----------
  for (const k of Object.keys(BOX).concat(['name', 'paper', 'quality', 'look'])) $(k).addEventListener('change', () => saveSetting(k));
  $('advanced').addEventListener('change', () => { $('advopts').hidden = !$('advanced').checked; });
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
  applyLang();
  for (let i = 0; i < LANES; i++) { startLane(i); idle.push(i); } // each worker loads the engine and says "ready"
  setTimeout(() => { if (!engineReady) setStatus('stuck'); }, 90000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  HWDB.loadAll().then((saved) => {
    if (!saved.length || pages.length) return;
    for (const r of saved) {
      if (!(r.src instanceof ArrayBuffer) || !(r.blob instanceof ArrayBuffer)) continue; // a record from an older version
      pages.push(Object.assign(newPage(), r, { src: fromBytes(r.src), blob: fromBytes(r.blob), busy: false, error: false, ver: 0 })); nextId = Math.max(nextId, r.id + 1);
    }
    if (!pages.length) return;
    $('restored').hidden = false; render();
  });
  render();
})();
