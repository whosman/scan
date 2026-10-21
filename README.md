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

**Settings** holds the file name, language, paper size and quality.
**Show advanced options** adds: the usual look of a page, how hard to remove ink from the back of the sheet,
automatic turning, and searchable text.

The pages are saved on the phone as the student works. If the browser closes, they are still there.
**Erase everything saved on this phone** removes them.

## What the app does to each photo

1. Finds the paper edges. It uses colour edges, straight lines and paper-like regions.
   It ranks every possible page shape by edge support, colour contrast and paper size.
2. Moves each corner onto the strongest edge. (Or uses the corners the student dragged.)
3. Removes perspective. It calculates the true page shape from the camera geometry
   and uses letter or A4 when the shape is close.
4. Removes shadows and uneven light. It removes show-through from the back of the sheet.
   For colour pages, it also removes the colour cast of the paper.
5. Turns the page upright. It uses the stroke direction, the page layout
   and a small model that reads printed text.
6. Warns about blur, low resolution, glare, a cut-off page
   and page edges that it cannot find.
7. Optional: reads the words (Tesseract) and adds them to the PDF as invisible text, so the PDF can be searched.

## Files

| File | Use |
|---|---|
| `index.html`, `app.js` | Screen and controls |
| `i18n.js` | Every word the student sees, in English and Spanish |
| `db.js` | Saves pages on the phone (IndexedDB) |
| `worker.js` | Runs the processing in a background thread |
| `hwscan-core.js` | The processing steps (same algorithm as `python/hwscan2.py`) |
| `opencv.js` | OpenCV 4.10 for the web (Apache-2.0) |
| `updown.bin`, `updown.json` | Orientation model weights (0.9 MB) |
| `pdf.js` | PDF writer |
| `ocr.js`, `ocr/` | Optional text reader (Tesseract.js, Apache-2.0). Fetched only if the student turns on searchable text |
| `classic/` | The simple version: an earlier, smaller build for old phones and phones without WebAssembly. It has its own service worker. Students reach it from a link on the main page |
| `sw.js`, `manifest.webmanifest`, `icon*` | Offline cache and home-screen install |

## How to put the app online

The app is a set of static files. Any static web host works.
The host must use HTTPS, because browsers allow offline mode only on HTTPS (or `localhost`).

Free hosts that work: GitHub Pages, Cloudflare Pages, Netlify, a school web server.
The repository's `.github/workflows/pages.yml` publishes this folder to GitHub Pages.

1. Copy all files in this folder to the host.
2. Open the address on a phone. Wait until the page says "Ready. Works without internet."
3. Turn on airplane mode and reload the page to test offline use.

When you change a file, change `CACHE = 'hwscan-v3'` in `sw.js` to a new name.
Phones then get the new files the next time they are online.

## Add a language

Copy the `en` block in `i18n.js`, translate it, and add the language to `LANGS`.
`npm run test:i18n` checks that no word is missing. The warnings from the scanning code are
matched by their English text, so keep the `WARN` table in step with `hwscan-core.js`.

## Size and speed

The first download is about 11.4 MB, most of it `opencv.js`. After that, the app uses no data.
Searchable text adds about 6 MB, once.

Photos are reduced to 2400 px on the long side before processing.
This limits memory use on phones with 2 GB of RAM or less.

On a desktop computer, one page takes about 2 seconds. Expect several times that on an old phone.
The app works on the next page while the student checks the last one.

## Privacy

The app sends no data to any server. It stores the student's settings and unfinished pages in the phone's own storage.

## Licence

App code: MIT. OpenCV and Tesseract: Apache-2.0.
The orientation model is trained only on open-licence fonts (DejaVu, SIL OFL fonts).
No IAM or MathWriting data is in the shipped model.
