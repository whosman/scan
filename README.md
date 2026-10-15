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
node test/pwa.mjs                      Home Screen app and offline cache
node test/live.mjs                     the published site
```

## Not yet tested on an iPhone

I tested on a desktop browser, a phone-sized screen, and a one-worker mode that stands in for a slow phone. I have not run it on a real iPhone. The first things to check: the live camera in Safari, the share sheet with a PDF, and how long a page takes on an old phone.
