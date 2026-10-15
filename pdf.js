// Minimal multi-page PDF writer for 8-bit grayscale pages (lossless Flate + PNG-Up predictor).
// Works in Node and in browsers. `deflate(Uint8Array) -> Promise<Uint8Array>` must produce zlib data.

export async function browserDeflate(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function predictUp(gray, w, h) {
  const out = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w + 1), r = y * w;
    out[o] = 2; // PNG "Up"
    if (y === 0) { for (let x = 0; x < w; x++) out[o + 1 + x] = gray[r + x]; }
    else { for (let x = 0; x < w; x++) out[o + 1 + x] = (gray[r + x] - gray[r - w + x]) & 255; }
  }
  return out;
}

const enc = new TextEncoder();
const ascii = (s) => enc.encode(s);
const esc = (s) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '?');

// Compress one gray page now so only the small compressed form is kept in memory.
export async function compressPage(gray, w, h, dpi = 300, deflate = browserDeflate) {
  return { w, h, dpi, z: await deflate(predictUp(gray, w, h)) };
}

// pages: [{ w, h, dpi, gray: Uint8Array(w*h) } | { w, h, dpi, z: compressed }]
export async function buildPdf(pages, { title = 'Scan', deflate = browserDeflate } = {}) {
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (b) => { chunks.push(b); pos += b.length; };
  const pushStr = (s) => push(ascii(s));

  pushStr('%PDF-1.5\n%\xE2\xE3\xCF\xD3\n');
  const nPages = pages.length;
  // object ids: 1 catalog, 2 pages, 3 info, then per page: page, content, image
  const pageId = (i) => 4 + i * 3, contentId = (i) => 5 + i * 3, imageId = (i) => 6 + i * 3;
  const begin = (id) => { offsets[id] = pos; pushStr(`${id} 0 obj\n`); };

  begin(1); pushStr('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  pushStr(`<< /Type /Pages /Count ${nPages} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>\nendobj\n`);
  begin(3);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  pushStr(`<< /Title (${esc(title)}) /Producer (Homework Scanner) /CreationDate (${stamp}) >>\nendobj\n`);

  for (let i = 0; i < nPages; i++) {
    const { w, h, gray, dpi = 300 } = pages[i];
    const zIn = pages[i].z;
    const pw = (w / dpi) * 72, ph = (h / dpi) * 72;
    const f = (v) => v.toFixed(2);
    begin(pageId(i));
    pushStr(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources << /XObject << /Im0 ${imageId(i)} 0 R >> >> /Contents ${contentId(i)} 0 R >>\nendobj\n`);
    const content = `q ${f(pw)} 0 0 ${f(ph)} 0 0 cm /Im0 Do Q`;
    begin(contentId(i));
    pushStr(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    const z = zIn || (await deflate(predictUp(gray, w, h)));
    begin(imageId(i));
    pushStr(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 8 /Columns ${w} >> /Length ${z.length} >>\nstream\n`);
    push(z);
    pushStr('\nendstream\nendobj\n');
  }

  const total = 4 + nPages * 3;
  const xrefPos = pos;
  pushStr(`xref\n0 ${total}\n`);
  pushStr('0000000000 65535 f \n');
  for (let id = 1; id < total; id++) pushStr(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  pushStr(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
