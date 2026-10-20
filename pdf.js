/* pdf.js - smallest useful PDF writer: one JPEG image per page, no dependencies. MIT licence. */
(function (root) {
  'use strict';
  function makePDF(pages, title) {
    // pages: [{ jpeg: Uint8Array, pxW, pxH, ptW, ptH, gray: bool }]
    const enc = new TextEncoder(), parts = [], offsets = [];
    let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const n = pages.length, kids = [];
    for (let i = 0; i < n; i++) kids.push(`${3 + 3 * i} 0 R`);
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${kids.join(' ')}] >>`));
    pages.forEach((p, i) => {
      const pg = 3 + 3 * i, im = pg + 1, ct = pg + 2;
      obj(pg, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.ptW} ${p.ptH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`));
      obj(im, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} /ColorSpace /${p.gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
        push(p.jpeg); push('\nendstream');
      });
      const s = `q ${p.ptW} 0 0 ${p.ptH} 0 0 cm /Im0 Do Q`;
      obj(ct, () => push(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`));
    });
    const info = 3 + 3 * n;
    const esc = (t) => t.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?');
    obj(info, () => push(`<< /Title (${esc(title || 'scan')}) /Producer (hwscan) >>`));
    const xref = len;
    let x = `xref\n0 ${info + 1}\n0000000000 65535 f \n`;
    for (let k = 1; k <= info; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    push(x);
    push(`trailer\n<< /Size ${info + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len); let o = 0;
    for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  }
  const api = { makePDF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDFMini = api;
})(typeof self !== 'undefined' ? self : this);
