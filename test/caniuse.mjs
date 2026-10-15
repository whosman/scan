import { feature, features } from 'caniuse-lite';
const want = ['pointer','flexbox-gap','css-grid','serviceworkers','stream','createimagebitmap','offscreencanvas','es6-module','web-share','viewport-unit-variants','css-env-function','css-sticky','css-touch-action','css-appearance','input-capture','wasm','wasm-simd','canvas','blobbuilder','bloburls','transforms3d','css-variables','css-supports-api','requestidlecallback','mdn-api_compressionstream','touch','fetch','input-range','details','dialog','css-math-functions','css-clip-path','css-filters','canvas-blending','input-file-multiple','promise-finally','async-functions','object-values','typedarrays','requestanimationframe','css-inset-property','css-aspect-ratio','css-media-interaction','css-overscroll-behavior','css-text-size-adjust'];
const stat = (id, v) => { const f = feature(features[id]); const s = f.stats.ios_saf; return s ? s[v] : '?'; };
const ver = ['11.0-11.2','11.3-11.4','12.0-12.1','12.2-12.5','13.0-13.1','13.2','13.3','13.4-13.7','14.0-14.4','14.5-14.8','15.0-15.1','15.2-15.3','15.4','15.5','15.6-15.8','16.0','16.1','16.2','16.3','16.4'];
console.log('feature'.padEnd(26), '12.0  12.2  13.4  14.5  15.0  15.4  16.4');
for (const id of want) {
  if (!features[id]) { console.log(id.padEnd(26), '(not in data)'); continue; }
  const row = ['12.0-12.1','12.2-12.5','13.4-13.7','14.5-14.8','15.0-15.1','15.4','16.4'].map((v) => { const s = String(stat(id, v) || '?'); return (s[0] === 'y' ? 'yes' : s[0] === 'a' ? 'part' : s[0] === 'n' ? 'NO' : s.slice(0,4)).padEnd(6); }).join('');
  console.log(id.padEnd(26), row);
}
