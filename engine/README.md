# The engine

The engine finds the page in a photo, straightens it, and cleans it. It is written in Rust, compiled to WebAssembly, and has no dependencies.
The same file runs in the phone's browser (`app/worker.js`) and in the tests and benchmarks (`tools/engine_rs.py`, through `wasmtime`).
What the tests measure is what the students get.

It replaced an OpenCV.js pipeline that took about 2 s a page and a 10 MB download. The engine is 250 KB and takes about 0.3 s a page.

## Build

```
sh engine/build.sh                          # Linux, macOS (needs: rustup target add wasm32-unknown-unknown)
powershell -File engine/build.ps1           # Windows (compiles in a temp folder; Windows can block compilers inside Documents)
```

Two files come out: `app/engine-simd.wasm` (WebAssembly SIMD, used when the browser has it) and `app/engine.wasm` (plain, for older browsers).
Commit both: the site serves `app/` as it is.

## How it works

1. **Find the page** (`src/detect.rs`), on a 320 px copy of the photo.
   - *Candidates.* Four sources: (a) segmentation: the table is modelled from the frame border as a small colour mixture in Lab, and everything unlike it is paper;
     (b) Hough lines on noise-normalised colour edges, paired into quadrilaterals; (c) the text: writing is found by gradient energy, its minimum-area rectangle is
     pushed outward to the nearest clear colour step, which finds paper edges too faint for any line detector (white paper on a pale table);
     (d) hill-climbing: the best seeds have their corners moved to maximise the score.
   - *Verifier.* Each candidate is scored on: how much of each side is supported by real edges; the colour step across each side, integrated along its length;
     how much the inside differs from the outside; precision and recall against the segmentation; text inside versus outside; paper-like shape (true aspect from
     camera geometry); edges that continue past the corners. The score is linear, with weights fitted offline (`tools/fit_rank_rs.py`).
   - *Confidence.* A second small model says how likely the pick is right (`tools/fit_conf_rs.py`). If it is unsure, the engine uses the whole photo and says so.
   - *Refine.* Each side is moved onto the strongest colour step in the full-resolution photo.
2. **Straighten** (`src/warp.rs`): the true paper shape (letter or A4 when close), warped with integer bilinear weights.
3. **Clean** (`src/clean.rs`): shading removed with a coarse grid; ink strength measured against the paper; the whole page is stretched by its own ink strength, so faint
   pencil shows and ruling stays light; one gain per colour channel removes the paper's cast; specks and edge shadows are removed on a half-size copy.
4. **Turn upright** (`src/orient.rs`): page layout (writing starts at the top left) plus a small text-patch model (HOG into a one-layer network, trained on open fonts).
5. **Warnings**: too small, blurry, glare, cut off, edges hard to see, unsure which way is up.

## The interface

A plain C interface; all buffers live in the module's memory. `app/worker.js` is the reference for how to call it:
`hw_alloc`, `hw_set_model`, `hw_process(rgba, width, height, options)`, then `hw_out_w`, `hw_out_h`, `hw_out_rgba`, `hw_proc_info`.
`hw_detect` and the `hw_set_stage` / `hw_set_pstage` / `hw_set_cstage` switches are for the training and timing tools.

## Improving the detector

```
python3 tools/eval_detect_rs.py 1600 2400 data/rs_test.pkl      # synthetic scenes; -> found, and the best candidate's overlap ("oracle")
python3 tools/eval_sd_rs.py data/rs_sd_all.pkl all               # SmartDoc frames (real photographs)
python3 tools/fit_rank_rs.py "data/rs_train.pkl,data/rs_sd_all.pkl:half" "data/rs_test.pkl,data/rs_sd_all.pkl:rest" --apply
python3 tools/fit_conf_rs.py "data/rs_train.pkl,data/rs_sd_all.pkl:half" "data/rs_test.pkl,data/rs_sd_all.pkl:rest" --apply
```

Always look at the oracle: it is the share of scenes where the true page is among the candidates at all. When the ranker's pick is close to the oracle, more weight
fitting cannot help; the candidate generator has to produce the missing page. `tools/diag_sides.py`, `tools/diag_misses.py`, `tools/viz_lines.py` and
`tools/viz_smartdoc.py` show why a page was missed.
