/* pdf.js - smallest useful PDF writer: one JPEG image per page, optional invisible text layer, no dependencies. MIT licence. */
(function (root) {
  'use strict';
  // Helvetica advance widths (per 1000 em) for ASCII 32..126; other Latin-1 letters use 556.
  const HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
  const adv = (ch) => { const c = ch.charCodeAt(0); return c >= 32 && c <= 126 ? HW[c - 32] : 556; };

  // Latin-1 / WinAnsi bytes for a PDF string; characters outside it become '?'
  function winAnsi(s) {
    let o = '';
    for (const ch of s) {
      const c = ch.charCodeAt(0);
      if (c < 32) continue;
      if (c === 0x5c || c === 0x28 || c === 0x29) o += '\\' + ch;
      else if (c <= 126 || (c >= 160 && c <= 255)) o += ch;
      else o += '?';
    }
    return o;
  }
  const hex16 = (s) => { let h = 'FEFF'; for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0'); return '<' + h + '>'; };
  const pdfDate = (d) => { const p = (n) => String(n).padStart(2, '0'); return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; };

  function textLayer(p) {
    // p.words: [{ t, x, y, w, h }] in pixels of the page image, y down. Draws invisible text (render mode 3) on top of the picture.
    const kx = p.ptW / p.pxW, ky = p.ptH / p.pxH, out = ['3 Tr'];
    for (const w of p.words) {
      const t = winAnsi(w.t); if (!t) continue;
      let nat = 0; for (const ch of w.t) nat += adv(ch);
      const fs = Math.max(1, w.h * ky * 0.9), natPt = nat / 1000 * fs;
      const tz = natPt > 0 ? Math.min(400, Math.max(10, (w.w * kx) / natPt * 100)) : 100;
      const x = w.x * kx, y = p.ptH - (w.y + w.h) * ky + w.h * ky * 0.2;
      out.push(`BT /F1 ${fs.toFixed(2)} Tf ${tz.toFixed(1)} Tz ${x.toFixed(2)} ${y.toFixed(2)} Td (${t}) Tj ET`);
    }
    return out.join('\n');
  }

  function makePDF(pages, title, opts) {
    // pages: [{ jpeg: Uint8Array, pxW, pxH, ptW, ptH, gray: bool, words?: [...] }]
    opts = opts || {};
    const enc = new TextEncoder(), parts = [], offsets = [];
    let len = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
    const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); body(); push('\nendobj\n'); };
    const n = pages.length, fontObj = 3 + 3 * n, infoObj = fontObj + 1, kids = [];
    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    for (let i = 0; i < n; i++) kids.push(`${3 + 3 * i} 0 R`);
    obj(1, () => push(`<< /Type /Catalog /Pages 2 0 R /Lang (${opts.lang || 'en'}) /ViewerPreferences << /DisplayDocTitle true >> >>`));
    obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${kids.join(' ')}] >>`));
    pages.forEach((p, i) => {
      const pg = 3 + 3 * i, im = pg + 1, ct = pg + 2, hasText = p.words && p.words.length;
      obj(pg, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.ptW} ${p.ptH}] /Resources << /XObject << /Im0 ${im} 0 R >>${hasText ? ` /Font << /F1 ${fontObj} 0 R >>` : ''} >> /Contents ${ct} 0 R >>`));
      obj(im, () => {
        push(`<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} /ColorSpace /${p.gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
        push(p.jpeg); push('\nendstream');
      });
      const s = `q ${p.ptW} 0 0 ${p.ptH} 0 0 cm /Im0 Do Q` + (hasText ? '\n' + textLayer(p) : '');
      const sb = new Uint8Array(s.length); for (let k = 0; k < s.length; k++) sb[k] = s.charCodeAt(k) & 255; // Latin-1: one byte a letter
      obj(ct, () => { push(`<< /Length ${sb.length} >>\nstream\n`); push(sb); push('\nendstream'); });
    });
    obj(fontObj, () => push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
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
