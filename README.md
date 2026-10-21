# HW Scan

HW Scan turns phone photos of homework into one clean PDF.
It runs on the phone, in the browser, with no internet after the first visit.
It is free and open source (MIT). It has no ads, no account and nothing to buy.

It finds the page, straightens it, removes shadows, turns it upright, and warns the student when a photo needs retaking.
Students can choose colour, gray or black and white, drag the corners, and make the PDF searchable.
The first visit downloads about 1.3 MB. A page takes under a second to clean.

**For teachers and schools:** [docs/FOR-SCHOOLS.md](docs/FOR-SCHOOLS.md).

- `app/` — the phone app (offline web app). Put this folder on any HTTPS static host. See [app/README.md](app/README.md).
- `engine/` — the image engine (Rust, compiled to WebAssembly). See [engine/README.md](engine/README.md).
- `tools/` — test-suite generator, benchmarks, weight fitting, model training.
- `tests/` — engine, translation and browser tests (the browser test includes an offline reload).
- `python/hwscan2.py` — the older OpenCV version of the algorithm, kept as a reference. The engine replaced it.
- `docs/RESULTS.md` — measured results and known limits.

## Run the app on your computer

```
npm install
npm run serve          # then open http://localhost:8765 on this computer
```

To use a phone, the app must be on HTTPS (for offline mode). Use GitHub Pages (below).

## Put the app online with GitHub Pages (free)

The site is the contents of `app/`, served as it is. Either:

- Push this repository, open **Settings → Pages**, set **Source** to **GitHub Actions**, and push to `main`; `.github/workflows/pages.yml` publishes `app/`.
- Or push the contents of `app/` to a branch named `gh-pages` and set Pages to serve that branch.

The address is `https://<user>.github.io/<repo>/`.

## Change the engine

```
rustup target add wasm32-unknown-unknown
sh engine/build.sh                     # Windows: powershell -File engine/build.ps1
```

Commit the two `.wasm` files that appear in `app/`.

## Tests

```
npm run test:engine    # 3 sample photos: the page is found, straightened, turned upright
npm run test:i18n      # every warning and every word has a translation key
npm run serve & npm run test:browser   # Chrome: 2 photos -> PDF, offline reload, erase
```

The large test sets (SmartDoc 2015, synthetic suite) need `scripts/fetch_data.sh` (about 2.2 GB) and
`python3 tools/gen_suite.py N START SEED`. See `CLAUDE.md` and `engine/README.md` for the full workflow.
