// Builds index.html (the whole app in one file), dist/app.html (same) and dist/HomeworkScan.js (Scriptable).
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const plain = (src) => src.replace(/^export\s+(async\s+)?(function|const|let)/gm, (m, a, k) => (a ? 'async ' : '') + k).replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

// fflate (MIT, by Arjun Barrett) gives small, fast, synchronous zlib that works on iOS 12. It defines a global `fflate`.
const fflate = '/* fflate, MIT licence, https://github.com/101arrowz/fflate */\n' + read('./node_modules/fflate/umd/index.js') + '\n';
const lib = [fflate, plain(read('./core.js')), plain(read('./pdf.js'))].join('\n');
if (/<\/script/i.test(lib)) throw new Error('lib contains </script');
const html = read('./app.template.html').replace('/*__LIB__*/', () => lib);
fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/app.html', import.meta.url), html);
fs.writeFileSync(new URL('./index.html', import.meta.url), html);   // the copy GitHub Pages serves

const wrapper = read('./scriptable/HomeworkScan.template.js').replace('/*__HTML__*/', () => JSON.stringify(html).split(String.fromCharCode(8232)).join('\\u2028').split(String.fromCharCode(8233)).join('\\u2029'));
fs.writeFileSync(new URL('./dist/HomeworkScan.js', import.meta.url), wrapper);
console.log('built', { appHtmlKB: Math.round(html.length / 1024), scriptableKB: Math.round(wrapper.length / 1024) });
