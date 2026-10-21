/* ocr.js - optional: reads the words on a page so the PDF can be searched and read aloud. MIT licence.
   Tesseract.js (Apache-2.0) and its language data live in app/ocr/. They are fetched the first time the student turns this on,
   then kept by the service worker, so it works offline afterwards. */
(function (root) {
  'use strict';
  let loading = null, worker = null, workerLang = null;
  function script(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('no ocr')); document.head.appendChild(s); }); }
  async function get(lang) {
    if (!root.Tesseract) await (loading = loading || script('ocr/tesseract.min.js'));
    const l = lang === 'es' ? 'spa' : 'eng';
    if (worker && workerLang === l) return worker;
    if (worker) { await worker.terminate(); worker = null; }
    worker = await root.Tesseract.createWorker(l, 1, { workerPath: 'ocr/worker.min.js', corePath: 'ocr', langPath: 'ocr/lang', gzip: true, cacheMethod: 'none' });
    workerLang = l; return worker;
  }
  // canvas -> [{ t, x, y, w, h }] in canvas pixels
  async function read(canvas, lang) {
    const w = await get(lang), r = await w.recognize(canvas, {}, { blocks: true }), out = [];
    for (const b of (r.data.blocks || [])) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const x of l.words || []) {
      const t = (x.text || '').trim(); if (!t || x.confidence < 40) continue;
      out.push({ t, x: x.bbox.x0, y: x.bbox.y0, w: x.bbox.x1 - x.bbox.x0, h: x.bbox.y1 - x.bbox.y0 });
    }
    return out;
  }
  async function stop() { if (worker) { await worker.terminate(); worker = null; } }
  root.HWOCR = { read, stop };
})(typeof self !== 'undefined' ? self : this);
