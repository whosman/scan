/* pdf.js - smallest useful PDF writer: one JPEG image per page, no dependencies. MIT licence. */
(function (root) {
  'use strict';
  const hex16 = (s) => { let h = 'FEFF'; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0'); return '<' + h + '>'; };
  const pdfDate = (d) => { const p = (n) => String(n).padStart(2, '0'); return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; };

  function makePDF(pages, title, opts) {
    // pages: [{ jpeg: Uint8Array, pxW, pxH, ptW, ptH, gray: bool }]
    opts = opts || {};
    const enc = new TextEncoder(), parts = [], offsets = [];
    let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    const n = pages.length, infoObj = 3 + 3 * n, kids = [];
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    for (let i = 0; i < n; i++) kids.push(`${3 + 3 * i} 0 R`);
    obj(1, () => push(`<< /Type /Catalog /Pages 2 0 R /Lang (${opts.lang || 'en'}) /ViewerPreferences << /DisplayDocTitle true >> >>`));
    obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${kids.join(' ')}] >>`));
    pages.forEach((p, i) => {
      const pg = 3 + 3 * i, im = pg + 1, ct = pg + 2;
      obj(pg, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.ptW} ${p.ptH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`));
      obj(im, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} /ColorSpace /${p.gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
        push(p.jpeg); push('\nendstream');
      });
      const s = `q ${p.ptW} 0 0 ${p.ptH} 0 0 cm /Im0 Do Q`;
      obj(ct, () => { push(`<< /Length ${s.length} >>\nstream\n`); push(s); push('\nendstream'); });
    });
    obj(infoObj, () => push(`<< /Title ${hex16(title || 'scan')} /Producer (HW Scan) /CreationDate (${pdfDate(new Date())}) >>`));
    const xref = len;
    let x = `xref\n0 ${infoObj + 1}\n0000000000 65535 f \n`;
    for (let k = 1; k <= infoObj; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    push(x);
    push(`trailer\n<< /Size ${infoObj + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    const out = new Uint8Array(len); let o = 0;
    for (const b of parts) { out.set(b, o); o += b.length; }
    return out;
  }
  const api = { makePDF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDFMini = api;
})(typeof self !== 'undefined' ? self : this);
