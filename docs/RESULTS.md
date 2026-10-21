# Results

Measured 2026-10-21 with the Rust engine in `app/engine-simd.wasm`, the same file the phone runs.
Nothing here was measured on a real phone. Treat the speed as a laptop figure.

## Speed

| | Old (OpenCV.js) | Engine |
|---|---|---|
| Download on first visit | about 5 MB | about 1.3 MB |
| App ready | 1.5–2.3 s | 0.15–0.2 s |
| One 2400 px photo, cleaned | about 2.1 s | about 0.3 s |
| Six 2400 px photos in Chrome | 6.5 s (14 s before the worker pool) | 1.9 s |

## Does the page come out usable?

Test: 800 synthetic scenes the engine never trained on (scenes 1600–2399; paper, pen, table, light and camera faults are varied
and the true page is known). A page is *usable* if it was found, is upright, and its content matches the truth.

| | Share |
|---|---|
| Page found (overlap with truth 0.9 or more) | 74.0% |
| Upright | 78.9% |
| Content correct | 87.2% |
| **Usable** | **73.2%** |
| Of the unusable pages, share that showed a retake warning | 82.7% |

So about 95 pages in 100 are either usable or come with a request to retake. Roughly 1 in 20 is wrong without a warning.

By table (usable): plain solid table 90.6%, two-tone 84.1%, fabric 82.5%, wood 77.2%, clutter 72.0%, a sheet of paper under the page 68.0%,
**white paper on a white table 50.0%**.
Faint pencil: 45.8%. Cut-off pages: 57.7%. These scenes are deliberately harsh (hard shadows, glare, 480×640 photos, heavy JPEG).

Compared with the OpenCV version on the same scenes: usable 73.1% there, 73.2% here; warning coverage 87.0% there, 82.7% here; time 0.60 s there, 0.31 s here.
The engine matches the old quality at half the time in this harness and about one seventh of it in the browser, with no 10 MB download.

## Real photographs (SmartDoc 2015, frames the detector never trained on)

Page found by table: plain 100%, 97.5%, 100%; white page on a cream table 85.7%; **cluttered table 0%**.
The cluttered-table set is the clearest limit: the engine does not find the page there and falls back to the whole photo with a warning.
The OpenCV version scored 5% on it, so this is not new.

## Known limits

- White paper on a white or cream table, and cluttered tables, are found less than half the time. The app shows a warning, and the student can drag the corners.
- In 1 in 20 photos the page is wrong without a warning.
- Pencil that is very faint can still be too light.
- Never run on a real phone: Safari 12–14, old Android and Lockdown Mode are untested apart from a WebKit build in Playwright.

## How to repeat

```
python3 tools/gen_suite.py 400 0 21               # 6 times, with START = 0, 400, ... 2000
python3 tools/e2e_rs.py 1600 2400 data/e2e.jsonl 120
python3 tools/report.py data/e2e.jsonl 0.097
python3 tools/eval_sd_rs.py - rest
```
