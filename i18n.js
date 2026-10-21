/* i18n.js - every word the student sees. To add a language, copy the `en` block, translate it, and add it to LANGS. MIT licence. */
(function (root) {
  'use strict';
  const LANGS = { en: 'English', es: 'Español' };
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
    oldphone: 'This phone is too old for the app. Try a newer browser, such as Chrome or Firefox.',

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
    colour: 'Colour',
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
    details: 'Details for experts',

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
    searchableHelp: 'Lets you search the PDF and have it read aloud. Slower. Needs a few MB the first time you use it.',
    backBleed: 'Ink from the back of the sheet',
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

  S.es = {
    tagline: 'Fotografía tu tarea. Obtén un PDF limpio.',
    loading: 'Preparando. La primera vez tarda un momento.',
    ready: 'Listo. Funciona sin internet.',
    cleaning: 'Limpiando tus fotos…',
    making: 'Creando tu PDF…',
    reading: 'Leyendo la página {n} de {total}…',
    crashed: 'Algo salió mal. Vuelve a cargar la página.',
    noscript: 'Esta aplicación necesita JavaScript. Actívalo y vuelve a cargar.',
    oldphone: 'Este teléfono es demasiado antiguo. Prueba con un navegador más nuevo, como Chrome o Firefox.',

    add: 'Agrega tus páginas',
    take: 'Tomar una foto',
    takeMore: 'Tomar otra foto',
    choose: 'Elegir fotos',
    tips: 'Pon la hoja plana sobre una mesa. Que llene la pantalla. No te muevas. Funciona mejor con luz del día, o con una lámpara a un lado.',
    check: 'Revísalas',
    none: 'Todavía no hay páginas.',
    make: 'Crea tu PDF',
    makeBtn: 'Crear PDF',
    restored: 'Guardamos tus páginas de la última vez.',
    startOver: 'Empezar de nuevo',
    startOverAsk: 'Toca otra vez para quitar todas las páginas',

    page: 'Página {n}',
    cleaningPage: 'Limpiando esta página…',
    good: 'Se ve bien.',
    edit: 'Editar',
    left: 'Girar a la izquierda',
    right: 'Girar a la derecha',
    up: 'Subir',
    down: 'Bajar',
    retake: 'Repetir foto',
    remove: 'Quitar',
    cantRead: 'No pudimos leer esta foto. Tómala otra vez.',
    preview: 'Vista previa de la página {n}',

    done: 'Listo',
    back: 'Atrás',
    colour: 'Color',
    gray: 'Gris',
    bw: 'Blanco y negro',
    look: 'Aspecto',
    lighter: 'Más claro',
    darker: 'Más oscuro',
    brightness: 'Claro y oscuro',
    edges: 'Ajustar los bordes',
    wholePhoto: 'Usar toda la foto',
    autoEdges: 'Buscar los bordes otra vez',
    cropHelp: 'Arrastra cada punto a una esquina de la hoja.',
    cropApply: 'Usar estos bordes',
    cancel: 'Cancelar',
    details: 'Detalles para expertos',

    pdfDone: 'Tu PDF está listo.',
    pdfInfo: '{pages} · {mb} MB',
    page_one: '1 página',
    page_other: '{n} páginas',
    share: 'Compartir',
    save: 'Guardar en este teléfono',
    saveImages: 'Guardar como imágenes',
    pdfHelp: 'Si no se abrió nada, busca {name} en tus Descargas.',

    settings: 'Ajustes',
    fileName: 'Nombre del archivo',
    fileNameHint: 'Mate-Tarea3-Lopez-Ana',
    language: 'Idioma',
    paper: 'Tamaño del papel',
    letter: 'Carta',
    a4: 'A4',
    fit: 'Ajustar a cada página',
    quality: 'Calidad',
    qSmall: 'Archivo pequeño',
    qStandard: 'Estándar',
    qHigh: 'Alta',
    defaultLook: 'Aspecto habitual',
    advanced: 'Avanzado',
    advancedOn: 'Mostrar opciones avanzadas',
    searchable: 'Hacer el texto buscable',
    searchFail: 'No se pudo hacer buscable el texto. Conéctate a internet una vez y vuelve a intentarlo.',
    searchableHelp: 'Permite buscar en el PDF y que se lea en voz alta. Es más lento. La primera vez necesita unos MB.',
    backBleed: 'Tinta del reverso de la hoja',
    gentle: 'Conservarla',
    normal: 'Normal',
    strong: 'Quitarla',
    autorotate: 'Enderezar las páginas automáticamente',
    install: 'Pon HW Scan en tu pantalla de inicio',
    installHelp: 'En el menú del navegador, elige «Añadir a la pantalla de inicio».',
    erase: 'Borrar todo lo guardado en este teléfono',
    eraseAsk: 'Toca otra vez para borrar',
    erased: 'Todo está borrado.',
    footer: 'Gratis y de código abierto. Tus fotos nunca salen de este teléfono.',
    'w.small': 'La foto es demasiado pequeña para leerse bien. Acerca el teléfono.',
    'w.blur': 'La foto está borrosa. No te muevas y toca la pantalla para enfocar.',
    'w.glare': 'Hay reflejo en la página. Inclina el teléfono o mueve la luz.',
    'w.cut': 'Falta un trozo de la página. Mantén las cuatro esquinas a la vista.',
    'w.edges': 'Los bordes de la hoja casi no se ven. Usa una mesa más oscura y mantén las cuatro esquinas a la vista.',
    'w.up': 'No pudimos saber cuál es la parte de arriba. Revisa esta página.',
  };

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
