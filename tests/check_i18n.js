// Every warning the engine can raise must have a translation and match the Python harness; every word on the page must exist.
const fs = require('fs'), path = require('path');
const I18N = require('../app/i18n.js');
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const worker = read('../app/worker.js'), harness = read('../tools/engine_rs.py');
let bad = 0;
const inWorker = new Map(), inHarness = new Map();
for (const m of worker.matchAll(/\[(\d+), '([^']+)'\]/g)) inWorker.set(+m[1], m[2]);
for (const m of harness.matchAll(/\((\d+), "([^"]+)"\)/g)) inHarness.set(+m[1], m[2]);
if (inWorker.size < 6) { console.log('could not find the warning table in worker.js'); bad++; }
for (const [bit, text] of inWorker) {
  if (inHarness.get(bit) !== text) { console.log('warning', bit, 'differs between worker.js and tools/engine_rs.py'); bad++; }
  if (!I18N.WARN[text]) { console.log('no translation key for warning:', text); bad++; }
}
for (const w of Object.keys(I18N.WARN)) if (![...inWorker.values()].includes(w)) { console.log('translation for a warning the engine no longer raises:', w); bad++; }
for (const lang of Object.keys(I18N.LANGS)) for (const k of Object.keys(I18N.S.en)) if (!(k in I18N.S[lang])) { console.log(lang, 'is missing', k); bad++; }
for (const lang of Object.keys(I18N.LANGS)) for (const k of Object.keys(I18N.S[lang])) if (!(k in I18N.S.en)) { console.log(lang, 'has an unknown key', k); bad++; }
const html = read('../app/index.html');
for (const m of html.matchAll(/data-(?:i|ph)="(\w+)"/g)) if (!(m[1] in I18N.S.en)) { console.log('index.html uses an unknown key', m[1]); bad++; }
console.log(inWorker.size, 'warnings,', Object.keys(I18N.LANGS).length, 'language,', bad ? bad + ' problems' : 'all covered');
process.exit(bad ? 1 : 0);
