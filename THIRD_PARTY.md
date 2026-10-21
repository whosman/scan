# Third-party parts

## Shipped in the app

The engine (`engine/`) is our own code and has no dependencies. The only third-party part in the app is the optional text reader.

| Part | Licence | Use |
|---|---|---|
| Tesseract.js 7 and Tesseract core 7 (`app/ocr/`, from the npm packages `tesseract.js` and `tesseract.js-core`) | Apache-2.0 | Optional: makes PDF text searchable. Downloaded only when the student turns it on |
| Tesseract English model, `4.0.0_best_int` (`app/ocr/lang/`, from `@tesseract.js-data/eng`) | Apache-2.0 | Same, language data |

## Used only to build or test (not shipped)

| Part | Licence | Use |
|---|---|---|
| DejaVu fonts | Bitstream Vera / public-domain style licence | Training text for the orientation model |
| 15 handwriting-style fonts from Google Fonts (Caveat, Patrick Hand, Indie Flower, Shadows Into Light, Gochi Hand, Kalam, Architects Daughter, Reenie Beanie, Nothing You Could Do, Covered By Your Grace, Gloria Hallelujah, Neucha, Handlee, Delius, Sriracha) | SIL Open Font License 1.1 | Training text for the orientation model |
| SmartDoc 2015 Challenge 1 dataset | See the dataset terms | Page-detection test and weight fitting |
| IAM handwriting (test lines, via Hugging Face `Teklia/IAM-line`) | Research use only | Synthetic test pages |
| MathWriting (human test split, via Hugging Face `deepcopy/MathWriting-human`) | CC BY-NC-SA 4.0 | Synthetic test pages |
| OpenCV (Python, 4.10), used by the old reference pipeline in `python/` and by the test scripts to read images | Apache-2.0 | Tests and tools only |
| puppeteer, playwright (Node.js test tools); wasmtime (runs the engine in Python tests) | Apache-2.0 | Tests only |

The shipped orientation model (`updown.bin`) is trained only on the open-licence fonts above.
The page-detection weights are a few dozen numbers. They are fitted on SmartDoc frames and on synthetic scenes;
some synthetic pages contain IAM or MathWriting lines. The weights contain no image or text data.
To remove all dependence on those datasets, run `tools/fit_rank2.py` on scenes made without them.
