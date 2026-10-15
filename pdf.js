// Minimal multi-page PDF writer for 8-bit grayscale pages: lossless Flate with the PNG "Up" predictor.
// Synchronous, no streams, so it runs on old iPhones. Compression comes from fflate (a global in the
// Worker and in Node tests): zlibSync(bytes).

export function predictUp(gray, w, h) {
  const out = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w + 1), r = y * w;
    out[o] = 2; // PNG "Up"
    if (y === 0) { for (let x = 0; x < w; x++) out[o + 1 + x] = gray[r + x]; }
    else { for (let x = 0; x < w; x++) out[o + 1 + x] = (gray[r + x] - gray[r - w + x]) & 255; }
  }
  return out;
}

// Compress one page now so only the small compressed form stays in memory.
export function compressPage(gray, w, h, dpi, deflate) {
  const d = deflate || ((b) => fflate.zlibSync(b, { level: 6 }));
  return { w: w, h: h, dpi: dpi, z: d(predictUp(gray, w, h)) };
}

function ascii(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }
const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?');

// pages: [{ w, h, dpi, z }]
export function buildPdf(pages, opts) {
  const title = (opts && opts.title) || 'Scan';
  const chunks = [], offsets = [];
  let pos = 0;
  const push = (b) => { chunks.push(b); pos += b.length; };
  const pushStr = (s) => push(ascii(s));
  pushStr('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n');
  const nPages = pages.length;
  const pageId = (i) => 4 + i * 3, contentId = (i) => 5 + i * 3, imageId = (i) => 6 + i * 3;
  const begin = (id) => { offsets[id] = pos; pushStr(id + ' 0 obj\n'); };
  begin(1); pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  let kids = ''; for (let i = 0; i < nPages; i++) kids += (i ? ' ' : '') + pageId(i) + ' 0 R';
  pushStr('<< /Type /Pages /Count ' + nPages + ' /Kids [' + kids + '] >>\nendobj\n');
  begin(3);
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const stamp = 'D:' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  pushStr('<< /Title (' + esc(title) + ') /Producer (Scan) /CreationDate (' + stamp + ') >>\nendobj\n');
  for (let i = 0; i < nPages; i++) {
    const pg = pages[i], w = pg.w, h = pg.h, dpi = pg.dpi || 200;
    const pw = (w / dpi) * 72, ph = (h / dpi) * 72, f = (v) => v.toFixed(2);
    begin(pageId(i));
    pushStr('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + f(pw) + ' ' + f(ph) + '] /Resources << /XObject << /Im0 ' + imageId(i) + ' 0 R >> >> /Contents ' + contentId(i) + ' 0 R >>\nendobj\n');
    const content = 'q ' + f(pw) + ' 0 0 ' + f(ph) + ' 0 0 cm /Im0 Do Q';
    begin(contentId(i));
    pushStr('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
    begin(imageId(i));
    pushStr('<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h + ' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns ' + w + ' >> /Length ' + pg.z.length + ' >>\nstream\n');
    push(pg.z);
    pushStr('\nendstream\nendobj\n');
  }
  const total = 4 + nPages * 3, xrefPos = pos;
  pushStr('xref\n0 ' + total + '\n0000000000 65535 f \n');
  for (let id = 1; id < total; id++) pushStr(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  pushStr('trailer\n<< /Size ' + total + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF\n');
  const out = new Uint8Array(pos); let o = 0;
  for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], o); o += chunks[i].length; }
  return out;
}
