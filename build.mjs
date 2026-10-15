// Builds dist/app.html (single file) and dist/HomeworkScan.js (the Scriptable script).
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const plain = (src) => src.replace(/^export\s+(async\s+)?(function|const|let)/gm, (m, a, k) => (a ? 'async ' : '') + k).replace(/^export\s*\{[^}]*\};?\s*$/gm, '');

const lib = [plain(read('./core.js')), plain(read('./pdf.js'))].join('\n');
if (/<\/script/i.test(lib)) throw new Error('lib contains </script');
const html = read('./app.template.html').replace('/*__LIB__*/', () => lib);
fs.mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('./dist/app.html', import.meta.url), html);
fs.writeFileSync(new URL('./index.html', import.meta.url), html);   // the copy GitHub Pages serves

// Scriptable wrapper: embeds the HTML as a string.
const wrapper = read('./scriptable/HomeworkScan.template.js').replace('/*__HTML__*/', () => JSON.stringify(html).split(String.fromCharCode(8232)).join('\\u2028').split(String.fromCharCode(8233)).join('\\u2029'));
fs.writeFileSync(new URL('./dist/HomeworkScan.js', import.meta.url), wrapper);
console.log('built', { appHtmlKB: Math.round(html.length / 1024), scriptableKB: Math.round(wrapper.length / 1024) });
