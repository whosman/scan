# Scan

Photograph handwritten pages. Get one clean PDF. It all happens in the browser on your phone. Nothing is uploaded.

## Use it

1. Open the link in Safari. Tap Share, then Add to Home Screen. If you do not see it, scroll the Share sheet and tap More or Edit Actions.
2. **Take photos.** The camera stays open. Tap the round button once per page. Tap Done. Lay each page flat on a dark surface with the whole page in view. Scan finds the edges and straightens it. If the camera will not open, the app uses the phone's own camera. You can also choose files you already have.
3. **Review.** Your page fills the screen. Pinch to zoom, drag to move, double-tap to jump in. The controls step aside as soon as you touch the page. Tap once to bring them back.
4. **Save.** One tap on Save builds the PDF. The next file name numbers itself: "HW 5" becomes "HW 6". Change the name before you share. Tap Share or save, then choose Files, Mail or any app. Add the file to your D2L dropbox from there. D2L will not take a submission from outside its own page, so that step is yours.

**Tools** holds Rotate, Crop, Hold to compare (shows the original photo), Photo mode (for diagrams), move earlier or later, and Delete. **Adjust** holds Faithful, Clean and Bold, three sliders, ruled-line removal, and a stamp of your name and page number on every page. While you move a slider the panel fades so you can see the page.

**Size.** Standard is 200 dpi, about 0.15 MB a page. Smaller is 150 dpi, about 0.1 MB. Sharper is 300 dpi, about 0.35 MB. Many instructors want under 1.5 MB for four to six pages.

## Why it is fast

The first version took about 5 seconds a page on a desktop, and over a minute on a phone. It cleaned each page twice, once for the preview and once for the PDF, with no progress shown. The cleaning is now one pass that serves both. Measured on a desktop, with the same photos:

| | before | now |
|---|---|---|
| Clean one page (200 dpi) | 2.4 s | 0.35 s |
| First page on screen | 2.3 s | 0.9 s |
| Fifteen pages ready | not possible | 4 s |
| Save three pages | 5 s | 0.4 s |

- The straightened colour page shows right away. The cleaned version replaces it when ready.
- One brightness plane is built once, then flattened with a single illumination estimate.
- Blurs are box filters computed by running sums. Side maps are a quarter size.
- The saved analysis is 3 bytes a pixel, so many pages fit in an old phone's memory.
- Workers start and warm up while you are still taking photos. Page finding runs in the worker.
- Progress moves at every stage. The bar never sits still.
- **The heavy loops are WebAssembly** (`assembly/kernels.ts`, compiled with AssemblyScript, 4.7 KB). A JavaScript engine starts slow and speeds up as it learns the code. That hurts most on an old phone, and most on the first page. WebAssembly runs at a steady speed from the first call. At startup each worker checks the WebAssembly against the JavaScript on a test page, and times both. It uses WebAssembly only if the two agree and it is faster. If WebAssembly is missing or fails at any point, the app falls back to JavaScript. `node build.mjs` with `NO_WASM=1` or `BAD_WASM=1` builds those fallback cases, and the tests pass on both.
- Camera shots make their thumbnail from the frame already in hand. Files you pick get numbered boxes until processed, so no photo is decoded twice.

The cleaning keeps what matters. Against the first version it matches the ink closely, and it now removes ruled and grid paper completely. A stress test (`test/stress.mjs`) covers shadows, colour casts, dim light, noise, glare and ruled paper.

## Old iPhones

The floor is Safari 12, which runs on the iPhone 5s and 6. The design follows from what that Safari lacks:

- **No pointer events.** Touch events do everything.
- **No flex gap, `inset`, `dvh` or `overscroll-behavior`.** The layout uses margins and a height set from `innerHeight`.
- **No `createImageBitmap`, `OffscreenCanvas` or `CompressionStream`.** Photos decode through an image and canvas. A bundled compressor (fflate) does the PDF. Everything heavy runs in a Worker.
- **EXIF rotation.** The app tests whether the browser rotates photos itself. If not, it reads the tag by hand.
- **Canvas limits.** A canvas may not exceed about 16.7 million pixels, and total canvas memory is 224 MB. The working resolution drops as the page count grows. Canvases are shrunk to zero when finished.
- **One worker on a two-core phone.** Three on a faster one.
- Native sliders, checkboxes and inputs. The text is 16 px or more so Safari does not zoom.

`node test/compat.mjs` parses the app as ES2018 and fails on any newer API or CSS.

**It tunes itself to the phone.** At start, each worker times a tiny cleaning job, in JavaScript and in WebAssembly, and keeps the faster. It then predicts the time for one page. If that is over about 2.5 seconds, it lowers the working resolution to fit. Long scans lower it further. The Sharper button re-reads the photo at full size when you save.

**What I measured for slow phones.** I have no old iPhone, so I used stand-ins:

- Real WebKit, Safari's engine, on a 320 by 568 touch screen (`test/webkit.mjs`). Taps, double-tap zoom, sliders and saving all pass. WebKit's JavaScript was the slower engine here. The worker took 1.0 to 1.7 seconds a page in JavaScript and 0.4 to 0.8 seconds in WebAssembly. The first page appears in about 1.8 seconds.
- Node with the JavaScript optimizer off and WebAssembly held to its baseline tier, a stand-in for a cold, slow engine (`node --no-opt --liftoff-only --no-wasm-tier-up test/wasm-check.mjs`). One page at 200 dpi takes **6.1 seconds in JavaScript and 0.85 seconds in WebAssembly**. The app picks WebAssembly. WebAssembly and JavaScript agree to within one gray level on 0.02 percent of ink pixels.
- The first version took over a minute for one page on a phone, with no progress shown.

## Host it yourself

The app is one file, `index.html`. GitHub Pages serves it from this repository. To change it, edit `app.template.html`, `core.js` or `pdf.js`, then run `npm install` and `node build.mjs`, and commit the new `index.html`.

## Optional: Scriptable

`dist/HomeworkScan.js` runs the same app inside Scriptable and saves PDFs to Files, On My iPhone, Scriptable, `HomeworkOut`. Nothing is ever deleted.

## Tests

These run on a desktop in headless Edge.

```
node test/compat.mjs index.html        old-Safari syntax and API check
node test/bench.mjs 200                speed and ink match against the first version
node test/stress.mjs                   lighting, noise and ruling stress test
node test/e2e6.mjs                     every feature, on a 320x568 screen with a fake camera
node test/e2e6.mjs lite                the same, as a two-core phone
node test/webkit.mjs                   the app in WebKit (Safari's engine), with touch
node test/wasm-check.mjs               WebAssembly against JavaScript on real photos: agreement and speed
node test/impl-compare.mjs            which implementation each engine picks, with end-to-end times
node test/slow-bench.mjs               cost per page; run with node --no-opt for a slow-CPU stand-in
node test/pwa.mjs                      Home Screen app and offline cache
node test/live.mjs                     the published site
```

## Known limits

- Photos at about a third of normal exposure with heavy noise lose some faint ink. The app tells you to retake them. I tried smoothing along the stroke direction and it made things worse, so I left it out.
- Glare and clipped, overexposed paper hide ink that the camera never recorded. The app warns you.

## Not yet tested on a real iPhone

I tested in Chromium, in real WebKit, on a phone-sized screen, in a one-worker mode, and with a slowed-down CPU. I have not run it on an actual iPhone.

To get real numbers from a real phone, tap **Check this phone** at the bottom of the home screen. It runs a made-up 12-megapixel photo through the whole pipeline on that phone and reports: the browser, whether WebAssembly, workers, the camera and file sharing work, the largest canvas the phone allows, which implementation it chose, and the seconds each step took. Tap Copy the report, or take a screenshot. That settles the open questions: the live camera in Safari, the share sheet with a PDF, and how long a page takes on an old phone.
