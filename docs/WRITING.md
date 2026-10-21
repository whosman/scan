# Writing rules for HW Scan

Every word a student sees is in `app/i18n.js`. The rules follow William Zinsser, *On Writing Well*.
Check any new or changed string against this list.

1. **One idea per sentence.** If a sentence has two, split it.
2. **Short words.** "Use", not "utilize". "Start", not "initiate".
3. **Active voice.** "We saved your pages", not "Your pages were saved".
4. **Say what to do.** A warning names the fix: "Hold still and tap the screen to focus."
5. **No clutter.** Cut "please" unless it softens a failure, "simply", "just", "in order to", "note that".
6. **No jargon.** No "OCR", "crop", "render", "cache", "wasm". Say "edges", "searchable", "saved on this phone".
7. **Same word for the same thing.** A photo you take is a *photo*; what you edit is a *page*; the result is a *PDF*.
8. **Buttons are verbs.** "Make PDF", "Retake", "Done".
9. **Blame the app, not the student.** "We could not read this photo", not "You took a bad photo".
10. **No emoji, no exclamation marks, no capital-letter shouting.**
11. **US spelling and Letter paper by default.** Plain words that a reader on a second language can follow.
12. **Read it aloud.** If you stumble, rewrite it.

Warnings come from the engine in English (`app/worker.js`, `tools/engine_rs.py`) and map to keys in `app/i18n.js`.
`npm run test:i18n` fails if the three lists differ.
