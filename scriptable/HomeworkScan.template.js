// Scan - Scriptable launcher
// Open it and use the app. It takes the photos, cleans the pages, and saves a PDF on the phone:
//   Files > On My iPhone > Scriptable > HomeworkOut > <name>.pdf
//   Files > On My iPhone > Scriptable > HomeworkOut > latest.pdf   (always the newest)
// Nothing is ever deleted. Nothing uses iCloud or the network.
//
// Optional: a Shortcut can drop scanned pages into HomeworkInbox first. If it did, they load automatically.

const CONFIG = {
  namePrefix: "HW",     // used for the suggested file name
  maxMB: 12,            // a file larger than this shrinks on its own
  afterSave: "preview", // "preview" opens the PDF with a share button. "none" just saves it.
};

// ---------------------------------------------------------------------------
const APP_HTML = /*__HTML__*/;

const fm = FileManager.local();
const root = fm.documentsDirectory();
const dirs = {
  inbox: fm.joinPath(root, "HomeworkInbox"),   // optional: pages a Shortcut left here
  out: fm.joinPath(root, "HomeworkOut"),
  pages: fm.joinPath(root, "HomeworkPages"),   // inbox photos are filed here by PDF name
  settings: fm.joinPath(root, "homework-settings.json"),
};
for (const d of [dirs.inbox, dirs.out, dirs.pages]) if (!fm.fileExists(d)) fm.createDirectory(d, true);

const readB64 = (path) => fm.read(path).toBase64String();
const isImage = (n) => /\.(jpe?g|png|heic|heif)$/i.test(n);
const mime = (n) => (/png$/i.test(n) ? "image/png" : "image/jpeg");
const safeName = (s) => String(s).replace(/[\\\/:*?"<>|]/g, "-");
const stampNow = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

// Move inbox photos into HomeworkPages/<label>. Nothing is deleted.
function filePages(paths, label) {
  if (!paths.length) return;
  let dir = fm.joinPath(dirs.pages, safeName(label)), k = 2;
  while (fm.fileExists(dir)) dir = fm.joinPath(dirs.pages, safeName(label) + " (" + k++ + ")");
  fm.createDirectory(dir, true);
  for (const p of paths) { try { fm.move(p, fm.joinPath(dir, fm.fileName(p, true))); } catch (e) {} }
}

// Pages left in the inbox by an interrupted run must not mix into a new scan. Set them aside.
function setAsideStale() {
  const cutoff = Date.now() - 6 * 3600000;
  const old = [];
  for (const n of fm.listContents(dirs.inbox)) {
    const p = fm.joinPath(dirs.inbox, n);
    try { if (isImage(n) && fm.modificationDate(p).getTime() < cutoff) old.push(p); } catch (e) {}
  }
  filePages(old, "Unfinished " + stampNow());
}

function inboxPages() {
  setAsideStale();
  const names = fm.listContents(dirs.inbox).filter(isImage).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.map((n) => { const p = fm.joinPath(dirs.inbox, n); return { b64: readB64(p), type: mime(n), path: p }; });
}

function loadSettings() { try { return JSON.parse(fm.readString(dirs.settings)); } catch (e) { return null; } }
function saveSettings(s) { try { fm.writeString(dirs.settings, JSON.stringify(s)); } catch (e) {} }

async function main() {
  const items = inboxPages();   // usually empty: the app takes the photos itself

  const wv = new WebView();
  await wv.loadHTML(APP_HTML);
  const shown = wv.present(true);   // resolves when the person closes the window
  for (const it of items) await wv.evaluateJavaScript("HW.addImage('" + it.b64 + "','" + it.type + "')", false);

  const cfg = { ...CONFIG, settings: loadSettings() };
  const result = await Promise.race([
    wv.evaluateJavaScript("HW.run(" + JSON.stringify(cfg) + ", completion)", true),
    shown.then(() => ({ status: "closed" })),
  ]);
  if (result && result.settings) saveSettings(result.settings);

  const paths = items.map((it) => it.path);
  if (result && result.status === "saved" && result.pdfB64) {
    const data = Data.fromBase64String(result.pdfB64);
    const named = fm.joinPath(dirs.out, safeName(result.name) + ".pdf");
    fm.write(named, data);
    fm.write(fm.joinPath(dirs.out, "latest.pdf"), data);
    filePages(paths, result.name);
    Script.setShortcutOutput(result.name);
    if (CONFIG.afterSave === "preview") await QuickLook.present(named, true);
  } else {
    filePages(paths, "Cancelled " + stampNow());
    Script.setShortcutOutput("CANCELLED");
  }
}

await main();
Script.complete();
