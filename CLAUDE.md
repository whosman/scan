# CLAUDE.md — working notes for Claude Code

## Goal
Free, open-source, offline phone app for low-income students: photos of homework -> one clean PDF.
Must work on old phones with poor photos and no internet. All processing on the phone.

## Ground rules
- The Rust engine (`engine/`) is the single source of truth. The app and the Python tools run the same `.wasm` file.
  `python/hwscan2.py` is the older OpenCV version, kept as a reference only; do not keep it in step.
- After any engine change: build (`engine/build.sh` or `engine/build.ps1`), commit BOTH `app/engine.wasm` and `app/engine-simd.wasm`,
  run `npm run test:engine`, bump CACHE in `app/sw.js`.
- Detector weights (`WEIGHTS`, `CONF` in `engine/src/detect.rs`) are written by `tools/fit_rank_rs.py --apply` and `tools/fit_conf_rs.py --apply`. Do not edit by hand.
- Shipped model data must come only from open-licence sources (fonts). IAM/MathWriting are for test pages only.
- Never commit `data/` (large, licensed, or private: `data/raw` holds a user's own homework photos).
- English only. No Spanish, no "simple version" fallback (both removed on purpose).
- Writing style for anything the student sees: Zinsser (short, plain, active, no jargon). Black on white, no emoji, no colour, works on old phones (no build step, ES2017, no frameworks).

## Layout
- `app/` index.html, app.js (UI), i18n.js (all user-visible words; the only place to edit copy), db.js (IndexedDB drafts),
  worker.js (loads the engine in a Worker pool), pdf.js (PDF writer, optional invisible text layer), ocr.js + ocr/ (optional Tesseract.js, fetched on demand),
  sw.js (offline cache), updown.bin/json (orientation model), engine.wasm + engine-simd.wasm.
- `engine/` Rust source: detect.rs, warp.rs, clean.rs, orient.rs, lib.rs (C interface). See engine/README.md.
- `tools/` paths.py (all data paths; $HWSCAN_DATA), gen_suite.py + hwdata.py (synthetic suite), engine_rs.py (wasmtime wrapper),
  eval_detect_rs.py / eval_sd_rs.py (dump candidates), fit_rank_rs.py / fit_conf_rs.py (fit and apply weights),
  e2e_rs.py + report.py (end-to-end scoring), diag_*.py / viz_*.py (why a page was missed), train_orient2.py + export_model.py (orientation model).
- `tests/` check_engine.py, check_i18n.js, browser_test.js (Puppeteer: add, edit, crop, PDF, restore after offline reload, erase; `OLD=1` tests the no-OffscreenCanvas path).

## Common commands
```
npm install && pip install -r requirements.txt
npm run build            # engine -> app/*.wasm
npm run test:engine && npm run test:i18n
npm run serve & HWSCAN_URL=http://localhost:8765/ npm run test:browser
scripts/fetch_data.sh  (or python3 scripts/fetch_data.py on Windows)   # ~2.2 GB into data/
python3 tools/gen_suite.py 400 0 21           # repeat with START=400,800,... for 2,400 scenes
python3 tools/eval_detect_rs.py 0 1600 data/rs_train.pkl; python3 tools/eval_detect_rs.py 1600 2400 data/rs_test.pkl
python3 tools/eval_sd_rs.py data/rs_sd_all.pkl all
python3 tools/fit_rank_rs.py "data/rs_train.pkl,data/rs_sd_all.pkl:half" "data/rs_test.pkl,data/rs_sd_all.pkl:rest" --sdw 1.0 --apply
python3 tools/fit_conf_rs.py  (same arguments) --apply     # then rebuild
python3 tools/e2e_rs.py 1600 2400 data/e2e.jsonl 120 && python3 tools/report.py data/e2e.jsonl 0.097
```

## Status (2026-10-21)
Done: Rust/WebAssembly engine (about 0.3 s a page, 250 KB; replaced OpenCV.js at about 2 s and 10 MB), colour pages, manual corners, PDF (optional searchable text),
offline PWA, English UI, drafts on the phone, advanced settings, worker pool, school guide (docs/FOR-SCHOOLS.md), CI tests.
Live: https://whosman.github.io/scan/ (gh-pages branch). Results: docs/RESULTS.md.

Next tasks, in order:
1. Push `main` to GitHub. The stored gh token lacks the `workflow` scope; run `gh auth refresh -s workflow`, then `git push origin main`.
   Until then deploy by hand: `git subtree split --prefix=app -b gh-pages-local`, push it to `gh-pages`. Bump CACHE in app/sw.js each release.
2. Test on real phones (iPhone with Safari 12–14, a cheap Android, Lockdown Mode). Nothing has run on a real phone yet.
3. Detection on cluttered tables and on white paper on a pale table is the weak spot (see docs/RESULTS.md). The ranker is near its ceiling;
   the candidate generator has to produce the missing pages (see "Improving the detector" in engine/README.md).
4. Optional: quantise updown.bin to int8 (0.9 MB -> 0.25 MB).
5. Optional: refit detector weights on scenes made without IAM/MathWriting lines (licence hygiene).

Windows notes: see requirements.txt for pins (numpy<2.3, opencv<5, pyarrow<26); cargo cannot write in Documents, so `engine/build.ps1` builds in %TEMP%.
