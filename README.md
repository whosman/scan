# Scan

Photograph your handwritten homework. Get a clean PDF on your phone.

```
open Scan from your Home Screen
  -> take photos (the camera stays open)
  -> review and adjust
  -> one tap: "Save to MATH201"
  -> share the PDF: Mail, Files, anywhere
```

It runs entirely in your browser. No account, no server, no upload. Your pages never leave your phone. After the first visit it works with no internet.

## Use it on your phone

1. Open the link for this app in **Safari**.
2. Tap the Share button, then **Add to Home Screen**. If you do not see it, scroll the Share sheet to the bottom and tap **More** or **Edit Actions**.
3. Open Scan from your Home Screen. The first time, allow the camera.

## Take photos

Tap the black button. The camera opens and stays open. Tap the round button once per page. Tap Done. Lay the page flat on a dark surface and keep it all in the frame. Scan finds the edges and straightens it.

If the camera will not open, the app uses the phone's own camera instead. You can also choose photos or files you already have.

## Review

Swipe the thumbnails and pinch to zoom. Hold "Hold to compare" to see the original photo. Rotate, crop, reorder or delete a page. Choose Faithful, Clean or Bold. Under Adjust you can tune the ink, and stamp your name and page number on every page. A blank page offers a one-tap Remove.

## Save and share

Tap the black button. It reads "Save to" and your last course, with the next file name beneath. "HW 5" becomes "HW 6". The first time, tap it, add a course, and type a name. Tap Change to pick another course, name or size. Then tap Share PDF. Choose Save to Files, Mail, or any app. Add the file to your D2L dropbox from there. D2L will not accept a submission from outside its own page, so that step is yours.

### Size

| Choice | Resolution | Per page |
|---|---|---|
| Sharp | 300 dpi | about 0.35 MB |
| Standard | 200 dpi | about 0.15 MB |
| Small | 150 dpi | about 0.09 MB |

A file over 12 MB shrinks on its own. Many instructors want under 1.5 MB for four to six pages. Pick Standard or Small for those.

## Host it yourself

The app is one file, `index.html`. GitHub Pages serves it from this repository.

1. Fork or clone the repository.
2. In Settings, Pages, choose the main branch and the root folder.
3. Open the link GitHub gives you.

To change the app, edit `app.template.html`, `core.js` or `pdf.js`, run `npm install` and `node build.mjs`, then commit the new `index.html`.

## Optional: Scriptable

`dist/HomeworkScan.js` runs the same app inside Scriptable and saves PDFs to Files, On My iPhone, Scriptable, `HomeworkOut`. Nothing is ever deleted. Paste it into a new script in Scriptable and run it. A Shortcut can also drop scanned pages into `HomeworkInbox`, and the app will load them.

## Tests

These run on a desktop in headless Edge.

```
node test/run.mjs photo.jpeg out              one image through the cleanup
node test/stress.mjs rectified-page.jpg       lighting, noise and ruling stress test
node test/e2e4.mjs                            the whole app, with a fake camera
node test/pwa.mjs                             Home Screen app and offline cache
```

## Not yet tested on an iPhone

- The live camera in Safari. If iOS refuses it, the app uses the phone's own camera.
- The share sheet with a PDF.
- Memory on long scans.
