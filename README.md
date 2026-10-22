# HW Scan

HW Scan turns phone photos of homework into one clean PDF.
All processing runs on the phone. No photo leaves the phone.
After the first visit, the app works with no internet.
It has no ads, no account and nothing to buy.

## What the student does

1. Open the app link one time while online. The browser keeps all app files.
2. Optional: choose "Add to Home screen" in the browser menu.
3. Tap **Take a photo** for each page, or **Choose photos**.
4. Read what the app says about each page. Tap **Retake** if it asks you to.
5. Tap **Edit** to change a page: colour, gray, or black and white; lighter or darker; turn it; drag the four corners.
6. Tap **Make PDF**. The phone opens its share menu, or saves the file.

**Settings** holds the file name, paper size and quality.
**Show advanced options** adds: the usual look of a page and automatic turning.

The pages are saved on the phone as the student works. If the browser closes, they are still there.
**Erase everything saved on this phone** removes them.

## What the app does to each photo

The work is done by the engine (`../engine/`), a small WebAssembly module written in Rust. See `../engine/README.md`.

1. Finds the page. It looks for the paper by colour, by straight edges, and by the writing on it, and checks each possible page against the photo.
   If it is not sure, it uses the whole photo and says so.
2. Moves each corner onto the page edge, and straightens the page to its true shape (letter or A4 when close).
3. Removes shadows and uneven light. Stretches the page by its own ink strength, so faint pencil shows. Removes the paper's colour cast and specks.
4. Turns the page upright.
5. Warns about blur, low resolution, glare, a cut-off page and page edges that it cannot find.

## Files

| File | Use |
|---|---|
| `index.html`, `app.js` | Screen and controls |
| `i18n.js` | Every word the student sees |
| `db.js` | Saves pages on the phone (IndexedDB) |
| `worker.js` | Runs the engine in a background thread; decodes photos there when the browser can |
| `engine-simd.wasm`, `engine.wasm` | The engine (about 250 KB each; the SIMD one is used when the browser has it) |
| `engine-js.js` | The same engine as plain JavaScript (1.7 MB), for phones with no WebAssembly. About 20 times slower. Fetched only on those phones |
| `updown.bin`, `updown.json` | Orientation model weights (0.9 MB) |
| `pdf.js` | PDF writer |
| `sw.js`, `manifest.webmanifest`, `icon*` | Offline cache and home-screen install |

## How to put the app online

The app is a set of static files. Any static web host works.
The host must use HTTPS, because browsers allow offline mode only on HTTPS (or `localhost`).

Free hosts that work: GitHub Pages, Cloudflare Pages, Netlify, a school web server.

1. Copy all files in this folder to the host.
2. Open the address on a phone. Wait until the words "Getting ready" go away.
3. Turn on airplane mode and reload the page to test offline use.

A page that is open reloads itself when a new version arrives (once no page is being cleaned), and Settings shows the version.
When you change a file, change `CACHE = 'hwscan-v28'` in `sw.js` to a new name.
Phones then get the new files the next time they are online.

## Size and speed

The first visit downloads about 1.3 MB over the network. After that, the app uses no data.

The app is ready in about 0.2 s. A page takes about 0.3 s to clean on a laptop, and photos are cleaned several at a time on phones with more than two cores.
Photos are reduced to 2400 px on the long side (1800 px on phones with 2 GB of memory or less).

## Add a language

Copy the `en` block in `i18n.js`, translate it, and add the language to `LANGS`.
`npm run test:i18n` checks that no word is missing. The warnings from the engine are matched by their English text,
so keep the `WARN` table in `i18n.js` in step with the table in `worker.js`.

## Privacy

The app sends no data to any server. It stores the student's settings and unfinished pages in the phone's own storage.

## Licence

App code and engine: MIT.
The orientation model is trained only on open-licence fonts (DejaVu, SIL OFL fonts).
No IAM or MathWriting data is in the shipped model.

## Progress and time left
The engine reports its stages (and each row of the ink network) through the import `env.hw_progress`. The worker passes them on; `app.js` turns them into a percentage on each page and a time left in the status line. The time left comes from the clock (time spent divided by share done, and the average page time on this phone), not from fixed numbers. A worker is restarted only after 60 seconds of silence (10 minutes without WebAssembly), so slow work is never cut off.

