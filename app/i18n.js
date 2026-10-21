/* i18n.js - every word the student sees, in one place. To add a language, copy the `en` block, translate it, and add it to LANGS. MIT licence. */
(function (root) {
  'use strict';
  const LANGS = { en: 'English' };
  const S = {};

  S.en = {
    tagline: 'Photograph your homework. Get one clean PDF.',
    loading: 'Getting ready. This takes a moment the first time.',
    ready: 'Ready. Works without internet.',
    cleaning: 'Cleaning your photos…',
    making: 'Making your PDF…',
    reading: 'Reading page {n} of {total}…',
    crashed: 'Something went wrong. Please reload the page.',
    noscript: 'This app needs JavaScript. Please turn it on and reload.',
    stuck: 'This is taking too long. Reload the page. If it still fails, try a newer browser, such as Chrome or Firefox.',

    add: 'Add your pages',
    take: 'Take a photo',
    takeMore: 'Take another photo',
    choose: 'Choose photos',
    tips: 'Lay the page flat on a table. Fill the screen with it. Hold still. Daylight, or a lamp to one side, works best.',
    check: 'Check them',
    none: 'No pages yet.',
    make: 'Make your PDF',
    makeBtn: 'Make PDF',
    restored: 'We saved your pages from last time.',
    startOver: 'Start over',
    startOverAsk: 'Tap again to remove all pages',

    page: 'Page {n}',
    cleaningPage: 'Cleaning this page…',
    good: 'Looks good.',
    edit: 'Edit',
    left: 'Turn left',
    right: 'Turn right',
    up: 'Move up',
    down: 'Move down',
    retake: 'Retake',
    remove: 'Remove',
    cantRead: 'We could not read this photo. Please take it again.',
    preview: 'Preview of page {n}',

    done: 'Done',
    back: 'Back',
    colour: 'Color',
    gray: 'Gray',
    bw: 'Black and white',
    look: 'Look',
    lighter: 'Lighter',
    darker: 'Darker',
    brightness: 'Light and dark',
    edges: 'Adjust the edges',
    wholePhoto: 'Use the whole photo',
    autoEdges: 'Find the edges again',
    cropHelp: 'Drag each dot to a corner of the page.',
    cropApply: 'Use these edges',
    cancel: 'Cancel',
    details: 'Technical details',

    pdfDone: 'Your PDF is ready.',
    pdfInfo: '{pages} · {mb} MB',
    page_one: '1 page',
    page_other: '{n} pages',
    share: 'Share',
    save: 'Save to this phone',
    saveImages: 'Save as pictures',
    pdfHelp: 'If nothing opened, look for {name} in your Downloads.',

    settings: 'Settings',
    fileName: 'File name',
    fileNameHint: 'Math-HW3-Lee-Sam',
    language: 'Language',
    paper: 'Paper size',
    letter: 'Letter',
    a4: 'A4',
    fit: 'Match each page',
    quality: 'Quality',
    qSmall: 'Small file',
    qStandard: 'Standard',
    qHigh: 'High',
    defaultLook: 'Usual look',
    advanced: 'Advanced',
    advancedOn: 'Show advanced options',
    searchable: 'Make the text searchable',
    searchFail: 'The text could not be made searchable. Connect to the internet once and try again.',
    searchableHelp: 'Lets you search the PDF and hear it read aloud. Slower. Downloads about 5 MB the first time.',
    backBleed: 'Show-through from the back of the sheet',
    gentle: 'Keep it',
    normal: 'Normal',
    strong: 'Remove it',
    autorotate: 'Turn pages upright by themselves',
    install: 'Put HW Scan on your home screen',
    installHelp: 'In your browser menu, choose “Add to Home screen”.',
    erase: 'Erase everything saved on this phone',
    eraseAsk: 'Tap again to erase',
    erased: 'Everything is erased.',
    footer: 'Free and open source. Your photos never leave this phone.',
  };

  // Warnings come from the scanning code in English. Each one maps to a key here.
  const WARN = {
    'The photo is too small to read well. Move the phone closer.': 'w.small',
    'The photo is blurry. Hold still and tap the screen to focus.': 'w.blur',
    'There is glare on the page. Tilt the phone or move the light.': 'w.glare',
    'Part of the page is cut off. Keep all four corners in view.': 'w.cut',
    'The page edges are hard to see. Use a darker table and keep all four corners in view.': 'w.edges',
    'We could not tell which way is up. Please check this page.': 'w.up',
  };
  for (const [en, key] of Object.entries(WARN)) S.en[key] = en;


  let lang = 'en';
  function t(key, vars) {
    let s = (S[lang] && S[lang][key]) || S.en[key] || key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : vars[k]));
    return s;
  }
  function count(n) { return t(n === 1 ? 'page_one' : 'page_other', { n }); }
  function warn(text) { const k = WARN[text]; return k ? t(k) : text; }
  function set(l) {
    lang = S[l] ? l : 'en';
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll('[data-i]')) el.textContent = t(el.getAttribute('data-i'));
    for (const el of document.querySelectorAll('[data-ph]')) el.setAttribute('placeholder', t(el.getAttribute('data-ph')));
    return lang;
  }
  function detect() {
    const l = ((navigator.languages && navigator.languages[0]) || navigator.language || 'en').slice(0, 2).toLowerCase();
    return S[l] ? l : 'en';
  }
  const api = { LANGS, S, WARN, t, count, warn, set, detect, get lang() { return lang; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.I18N = api;
})(typeof self !== 'undefined' ? self : this);
