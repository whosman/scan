// Will this run on an old iPhone? Parse the app as ES2018 (what Safari 12 supports) and look for
// APIs and CSS that Safari 12 / 13 / 14 do not have. caniuse data: see test/caniuse.mjs.
import fs from 'node:fs';
import * as acorn from 'acorn';

const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const css = ((html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1]).replace(/\/\*[\s\S]*?\*\//g, '');
let bad = 0;
const fail = (m) => { console.log('FAIL', m); bad++; };

scripts.forEach((s, i) => {
  try { acorn.parse(s, { ecmaVersion: 2018, sourceType: 'script' }); console.log('script', i, 'parses as ES2018:', s.length, 'chars'); }
  catch (e) { fail('script ' + i + ' is not ES2018: ' + e.message + ' at ' + JSON.stringify(s.slice(Math.max(0, e.pos - 60), e.pos + 40))); }
});
// the worker source is a function inside the app script; its text is covered by the parse above.

const apis = [
  [/createImageBitmap\s*\(/, 'createImageBitmap (Safari 15+)'], [/OffscreenCanvas/, 'OffscreenCanvas (Safari 16.4+)'], [/CompressionStream|DecompressionStream/, 'CompressionStream (Safari 16.4+)'],
  [/\bPointerEvent\b|['"]pointer(down|move|up)['"]|setPointerCapture/, 'Pointer Events (Safari 13+)'], [/structuredClone/, 'structuredClone (Safari 15.4+)'],
  [/\.replaceAll\(/, 'replaceAll (Safari 13.1+)'], [/\.at\(-?\d/, 'Array.at (Safari 15.4+)'], [/\.flat\(|\.flatMap\(/, 'flat/flatMap (Safari 12 has them, 11 does not)'],
  [/Object\.fromEntries/, 'Object.fromEntries (Safari 12.1+)'], [/\bBigInt\b|\d+n\b/, 'BigInt (Safari 14+)'], [/requestIdleCallback/, 'requestIdleCallback (not in Safari)'],
  [/ResizeObserver/, 'ResizeObserver (Safari 13.1+)'], [/IntersectionObserver/, 'IntersectionObserver (Safari 12.1+)'], [/\.matchAll\(/, 'matchAll (Safari 13+)'],
  [/\bfetch\(/, 'fetch (fine, but not needed)'], [/import\(/, 'dynamic import (Safari 11.1+)'], [/\?\./, 'optional chaining (Safari 13.1+)'], [/\?\?/, 'nullish coalescing (Safari 13.1+)'],
  [/\.trimStart\(|\.trimEnd\(/, 'trimStart (Safari 12+)'], [/Promise\.allSettled/, 'Promise.allSettled (Safari 13+)'], [/globalThis/, 'globalThis (Safari 12.1+)'],
];
const code = scripts.join('\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');   // ignore comments
// ignore the fflate/vendor block when checking app code
const app = scripts[scripts.length - 1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const [re, label] of apis) { if (re.test(app)) fail('app uses ' + label); }
const lib = scripts.find((s) => s.includes('fflate')) || '';
if (/\?\.\w|\?\?[^?]/.test(lib.replace(/"[^"]*"|'[^']*'/g, ''))) console.log('note: library contains ?. or ?? outside strings (checked by the parse above)');

const cssBad = [[/\bgap\s*:/, 'gap (flexbox gap: Safari 14.1+)'], [/\binset\s*:/, 'inset (Safari 14.1+)'], [/\bdvh\b|\bsvh\b|\blvh\b/, 'dvh units (Safari 15.4+)'], [/aspect-ratio/, 'aspect-ratio (Safari 15+)'],
  [/overscroll-behavior/, 'overscroll-behavior (Safari 16+)'], [/color-mix/, 'color-mix (Safari 16.2+)'], [/clamp\(/, 'clamp() (Safari 13.1+)'], [/backdrop-filter/, 'backdrop-filter (needs -webkit-)'],
  [/:is\(|:where\(|:has\(/, ':is/:where/:has (Safari 14+/15.4+)'], [/@container/, 'container queries'], [/\bscroll-snap/, 'scroll-snap (ok in 11+, avoid)'], [/\bcontain\s*:/, 'contain (Safari 15.4+)']];
for (const [re, label] of cssBad) { if (re.test(css)) fail('css uses ' + label); }
console.log(bad ? bad + ' problem(s)' : 'compat OK: ES2018 syntax, no APIs or CSS newer than Safari 12 in the app code');
process.exit(bad ? 1 : 0);

