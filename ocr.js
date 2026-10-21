/* ocr.js - optional: reads the words on a page so the PDF can be searched and read aloud. MIT licence.
   Tesseract.js (Apache-2.0) and its language data live in app/ocr/. They are fetched the first time the student turns this on,
   then kept by the service worker, so it works offline afterwards. */
(function (root) {
  'use strict';
  let loading = null, worker = null, workerLang = null;
  function script(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('no ocr')); document.head.appendChild(s); }); }
  async function get(lang) {
    if (!root.Tesseract) await (loading = loading || script('ocr/tesseract.min.js'));
    const l = 'eng';
    if (worker && workerLang === l) return worker;
    if (worker) { await worker.terminate(); worker = null; }
    worker = await root.Tesseract.createWorker(l, 1, { workerPath: 'ocr/worker.min.js', corePath: 'ocr', langPath: 'ocr/lang', gzip: true, cacheMethod: 'none' });
    workerLang = l; return worker;
  }
  // canvas -> [{ t, x, y, w, h }] in canvas pixels
  // The reader needs far fewer pixels than the PDF keeps: a page 1200 px wide reads nearly as well as one 2550 px wide, in a quarter of the time.
  // A page that takes more than 30 s is skipped (it keeps its picture, just no hidden text) so one hard page cannot hold up the PDF.
  const READ_WIDTH = 1200, LIMIT_MS = 30000;
  async function read(canvas, lang) {
    const s = Math.min(1, READ_WIDTH / canvas.width); let src = canvas;
    if (s < 1) { src = document.createElement('canvas'); src.width = Math.round(canvas.width * s); src.height = Math.round(canvas.height * s); const g = src.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, src.width, src.height); }
    const w = await get(lang); let timer;
    const r = await Promise.race([w.recognize(src, {}, { blocks: true }), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('slow')), LIMIT_MS); })]).catch(async (e) => { await stop(); throw e; });
    clearTimeout(timer); if (src !== canvas) src.width = 0;
    const out = [];
    for (const b of (r.data.blocks || [])) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const x of l.words || []) {
      const t = (x.text || '').trim(); if (!t || x.confidence < 40) continue;
      out.push({ t, x: x.bbox.x0 / s, y: x.bbox.y0 / s, w: (x.bbox.x1 - x.bbox.x0) / s, h: (x.bbox.y1 - x.bbox.y0) / s });
    }
    return out;
  }
  async function stop() { if (worker) { await worker.terminate(); worker = null; } }
  root.HWOCR = { read, stop };
})(typeof self !== 'undefined' ? self : this);
