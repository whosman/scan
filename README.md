# HW Scan

HW Scan turns phone photos of homework into one clean PDF.
All processing runs on the phone. No photo leaves the phone.
After the first visit, the app works with no internet.

## What the student does

1. Open the app link one time while online. The browser keeps all app files.
2. Optional: tap "Add to Home screen" in the browser menu.
3. Type the file name, for example `MATH252-HW07-Lee-Ana`.
4. Tap **Take photo** for each page, or **Add from gallery**.
5. Read the warnings. Tap **Retake** if a warning tells you to.
6. Use the rotate and move buttons if a page is wrong.
7. Tap **Make PDF**. The phone opens its share menu, or saves the file.

## What the app does to each photo

1. Finds the paper edges. It uses colour edges, straight lines and paper-like regions.
   It ranks every possible page shape by edge support, colour contrast and paper size.
2. Moves each corner onto the strongest edge.
3. Removes perspective. It calculates the true page shape from the camera geometry
   and uses letter or A4 when the shape is close.
4. Removes shadows and uneven light. It removes show-through from the back of the sheet.
5. Turns the page upright. It uses the stroke direction, the page layout
   and a small model that reads printed text.
6. Gives warnings for blur, low resolution, glare, a cut-off page
   and page edges that it cannot find.

## Files

| File | Use |
|---|---|
| `index.html`, `app.js` | Screen and controls |
| `worker.js` | Runs the processing in a background thread |
| `hwscan-core.js` | The processing steps (same algorithm as `hwscan2.py`) |
| `opencv.js` | OpenCV 4.10 for the web (Apache-2.0) |
| `updown.bin`, `updown.json` | Orientation model weights (0.9 MB) |
| `pdf.js` | PDF writer |
| `sw.js`, `manifest.webmanifest`, `icon*` | Offline cache and home-screen install |

## How to put the app online

The app is a set of static files. Any static web host works.
The host must use HTTPS, because browsers allow offline mode only on HTTPS (or `localhost`).

Free hosts that work: GitHub Pages, Cloudflare Pages, Netlify, a school web server.

1. Copy all files in this folder to the host.
2. Open the address on a phone. Wait until the top bar shows "Ready (offline)".
3. Turn on airplane mode and reload the page to test offline use.

When you change a file, change `CACHE = 'hwscan-v1'` in `sw.js` to a new name.
Phones then get the new files the next time they are online.

## Size and speed

The first download is about 11.4 MB, most of it `opencv.js`.
After that, the app uses no data.

Photos are reduced to 2400 px on the long side before processing.
This limits memory use on phones with 2 GB of RAM or less.

## Privacy

The app sends no data to any server. It stores only the file name,
the paper size and the quality setting, in the phone's own storage.

## Licence

App code: MIT. OpenCV: Apache-2.0.
The orientation model is trained only on open-licence fonts (DejaVu, SIL OFL fonts).
No IAM or MathWriting data is in the shipped model.
