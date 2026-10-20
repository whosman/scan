/* app.js - UI for HW Scan. All processing stays on the phone. MIT licence. */
(function () {
  'use strict';
  const MAX_SIDE = 2400;            // cap the photo size: old phones have little memory
  const $ = (id) => document.getElementById(id);
  const pages = [];                 // { id, w, h, gray: Uint8Array, rot: 0..3, info, busy }
  let nextId = 1, worker = null, queue = Promise.resolve();
  const pending = new Map();

  // ---------- settings remembered on this phone only ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('hwscan.' + k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('hwscan.' + k, v); } catch (e) { /* private mode */ } },
  };
  $('name').value = store.get('name', '');
  $('paper').value = store.get('paper', 'letter');
  $('quality').value = store.get('quality', '200');
  for (const k of ['name', 'paper', 'quality']) $(k).addEventListener('change', () => store.set(k, $(k).value));

  // ---------- worker ----------
  function startWorker() {
    worker = new Worker('worker.js');
    worker.onmessage = (e) => { const p = pending.get(e.data.id); if (p) { pending.delete(e.data.id); p(e.data); } };
    worker.onerror = (e) => setStatus('Error: ' + e.message);
  }
  function runWorker(msg, transfer) {
    return new Promise((res) => { pending.set(msg.id, res); worker.postMessage(msg, transfer); });
  }
  function setStatus(t) { $('status').textContent = t; }

  // ---------- image loading (EXIF rotation is applied by the browser) ----------
  async function decode(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (e) {
      bmp = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = URL.createObjectURL(file); });
    }
    const w0 = bmp.width, h0 = bmp.height, s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
    const w = Math.round(w0 * s), h = Math.round(h0 * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return g.getImageData(0, 0, w, h);
  }

  async function addFiles(files, replaceId) {
    for (const f of files) {
      const pg = replaceId ? pages.find(p => p.id === replaceId) : { id: nextId++, rot: 0 };
      pg.busy = true; pg.info = null;
      if (!replaceId) pages.push(pg);
      render();
      queue = queue.then(async () => {
        setStatus('Working…');
        try {
          const img = await decode(f);
          const opts = { paper: $('paper').value, dpi: +$('quality').value };
          const r = await runWorker({ id: pg.id, width: img.width, height: img.height, rgba: img.data.buffer, opts }, [img.data.buffer]);
          if (!r.ok) throw new Error(r.error);
          pg.w = r.width; pg.h = r.height; pg.gray = new Uint8Array(r.gray); pg.info = r.info; pg.rot = 0;
          pg.paper = opts.paper; pg.dpi = opts.dpi;
        } catch (err) {
          pg.error = 'Could not read this photo: ' + err.message;
        }
        pg.busy = false; render(); setStatus('Ready (offline)');
      });
      replaceId = null;
    }
  }
  $('cam').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
  $('gal').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

  // ---------- page canvas (rotation applied) ----------
  function pageCanvas(pg, scale) {
    const src = document.createElement('canvas'); src.width = pg.w; src.height = pg.h;
    const g = src.getContext('2d'), id = g.createImageData(pg.w, pg.h), d = id.data;
    for (let i = 0, j = 0; i < pg.gray.length; i++, j += 4) { const v = pg.gray[i]; d[j] = d[j + 1] = d[j + 2] = v; d[j + 3] = 255; }
    g.putImageData(id, 0, 0);
    const turn = pg.rot % 2 === 1, W = Math.round((turn ? pg.h : pg.w) * scale), H = Math.round((turn ? pg.w : pg.h) * scale);
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const o = out.getContext('2d'); o.imageSmoothingQuality = 'high';
    o.translate(W / 2, H / 2); o.rotate(pg.rot * Math.PI / 2);
    o.drawImage(src, -pg.w * scale / 2, -pg.h * scale / 2, pg.w * scale, pg.h * scale);
    return out;
  }

  // ---------- list ----------
  function render() {
    const box = $('pages'); box.innerHTML = '';
    if (!pages.length) { box.innerHTML = '<div id="empty">No pages yet.</div>'; }
    pages.forEach((pg, i) => {
      const row = document.createElement('div'); row.className = 'page';
      const meta = document.createElement('div'); meta.className = 'meta';
      meta.innerHTML = `<div class="n">Page ${i + 1}</div>`;
      if (pg.busy) { meta.innerHTML += '<div class="busy">Cleaning the photo…</div>'; }
      else if (pg.error) { meta.innerHTML += `<div class="warn">${pg.error}</div>`; }
      else {
        const th = pageCanvas(pg, 96 / Math.max(pg.w, pg.h)); th.className = 'thumb'; row.appendChild(th);
        for (const w of (pg.info.warn || [])) { const d = document.createElement('div'); d.className = 'warn'; d.textContent = '⚠ ' + w; meta.appendChild(d); }
      }
      const tools = document.createElement('div'); tools.className = 'tools';
      const b = (label, fn, dis) => { const x = document.createElement('button'); x.textContent = label; x.disabled = !!dis; x.onclick = fn; tools.appendChild(x); };
      b('⟲', () => { pg.rot = (pg.rot + 3) % 4; render(); }, pg.busy || pg.error);
      b('⟳', () => { pg.rot = (pg.rot + 1) % 4; render(); }, pg.busy || pg.error);
      b('▲', () => { pages.splice(i, 1); pages.splice(i - 1, 0, pg); render(); }, i === 0);
      b('▼', () => { pages.splice(i, 1); pages.splice(i + 1, 0, pg); render(); }, i === pages.length - 1);
      b('Retake', () => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
        inp.onchange = () => addFiles([...inp.files], pg.id); inp.click(); }, pg.busy);
      b('Delete', () => { pages.splice(i, 1); render(); }, pg.busy);
      meta.appendChild(tools); row.appendChild(meta); box.appendChild(row);
    });
    $('make').disabled = !pages.length || pages.some(p => p.busy) || pages.every(p => p.error);
  }

  // ---------- PDF ----------
  const PAPER = { letter: [8.5, 11.0], a4: [8.27, 11.69] };
  async function jpegOf(canvas, q) {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));
    return new Uint8Array(await blob.arrayBuffer());
  }
  $('make').addEventListener('click', async () => {
    $('make').disabled = true; setStatus('Making PDF…');
    const out = [];
    for (const pg of pages.filter(p => !p.error)) {
      const [wi, hi] = PAPER[pg.paper || 'letter'], dpi = pg.dpi || 200;
      const Wp = Math.round(wi * dpi), Hp = Math.round(hi * dpi), m = Math.round(0.25 * dpi);
      const turn = pg.rot % 2 === 1, pw = turn ? pg.h : pg.w, ph = turn ? pg.w : pg.h;
      const s = Math.min((Wp - 2 * m) / pw, (Hp - 2 * m) / ph);
      const img = pageCanvas(pg, s);
      const c = document.createElement('canvas'); c.width = Wp; c.height = Hp;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, Wp, Hp);
      g.drawImage(img, Math.round((Wp - img.width) / 2), Math.round((Hp - img.height) / 2));
      out.push({ jpeg: await jpegOf(c, 0.8), pxW: Wp, pxH: Hp, ptW: Math.round(wi * 72), ptH: Math.round(hi * 72), gray: false });
    }
    const name = ($('name').value.trim() || 'scan').replace(/[^\w.\- ]+/g, '_');
    const bytes = PDFMini.makePDF(out, name);
    const file = new File([bytes], name.replace(/\.pdf$/i, '') + '.pdf', { type: 'application/pdf' });
    $('pdfinfo').textContent = `${out.length} page(s), ${(bytes.length / 1e6).toFixed(2)} MB`;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: file.name }); } catch (e) { /* user closed the share sheet */ }
    } else {
      const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }
    $('make').disabled = false; setStatus('Ready (offline)');
  });

  // ---------- start ----------
  startWorker();
  runWorker({ id: 0, width: 4, height: 4, rgba: new Uint8ClampedArray(64).buffer, opts: { dpi: 50 } }) // warm up
    .then(() => setStatus('Ready (offline)'));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render();
})();
