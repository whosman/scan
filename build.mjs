// Builds index.html (the whole app in one file), dist/app.html (same) and dist/HomeworkScan.js (Scriptable).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const plain = (src) => src.replace(/^export\s+(async\s+)?(function|const|let)/gm, (m, a, k) => (a ? 'async ' : '') + k).replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

// fflate (MIT, by Arjun Barrett) gives small, fast, synchronous zlib that works on iOS 12. It defines a global `fflate`.
const fflate = '/* fflate, MIT licence, https://github.com/101arrowz/fflate */\n' + read('./node_modules/fflate/umd/index.js') + '\n';
// WebAssembly kernels (AssemblyScript). The compiled file is committed, so a build without the compiler still works.
try {
  fs.mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
  execFileSync(process.execPath, ['node_modules/assemblyscript/bin/asc.js', 'assembly/kernels.ts', '--outFile', 'build/kernels.wasm', '--optimizeLevel', '3', '--shrinkLevel', '0', '--runtime', 'stub', '--noAssert', '--importMemory', '--initialMemory', '16', '--maximumMemory', '8192'], { stdio: 'pipe' });
} catch (e) { console.log('wasm compile skipped:', String(e.message).split('\n')[0]); }
let wasmB64 = '';
try { wasmB64 = fs.readFileSync(new URL('./build/kernels.wasm', import.meta.url)).toString('base64'); } catch (e) { console.log('no wasm: the app will use JavaScript only'); }
// test hooks: build without WebAssembly, or with a broken module, to prove the JavaScript fallback
if (process.env.NO_WASM) wasmB64 = '';
if (process.env.BAD_WASM) wasmB64 = Buffer.from('not a wasm module, but long enough to be tried'.repeat(4)).toString('base64');
const lib = ['const WASM_B64 = "' + wasmB64 + '";', fflate, plain(read('./core.js')), plain(read('./pdf.js'))].join('\n');
if (/<\/script/i.test(lib)) throw new Error('lib contains </script');
const html = read('./app.template.html').replace('/*__LIB__*/', () => lib);
fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/app.html', import.meta.url), html);
fs.writeFileSync(new URL('./index.html', import.meta.url), html);   // the copy GitHub Pages serves

const wrapper = read('./scriptable/HomeworkScan.template.js').replace('/*__HTML__*/', () => JSON.stringify(html).split(String.fromCharCode(8232)).join('\\u2028').split(String.fromCharCode(8233)).join('\\u2029'));
fs.writeFileSync(new URL('./dist/HomeworkScan.js', import.meta.url), wrapper);
console.log('built', { appHtmlKB: Math.round(html.length / 1024), scriptableKB: Math.round(wrapper.length / 1024) });
