// Display preferences. These are small and non-precious, so localStorage is
// the right home for them -- books and reading positions go in IndexedDB.

const KEY = 'my-reader:settings';

// Shown in the library footer so "is the tablet actually running the new
// code?" is answerable at a glance. Bump it together with CACHE in sw.js.
export const BUILD = 'v4';

const DEFAULTS = {
  theme: 'light',       // a key of THEMES below
  fontSize: 100,        // epub text size, percent
  zoom: 100,            // pdf zoom, percent of fit-to-width
  chromeHidden: false,  // reading with the top toolbar collapsed
};

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  localStorage.setItem(KEY, JSON.stringify({ ...loadSettings(), ...patch }));
}

// Both engines paint their own background, and the page around them needs to
// match, so the palette lives here rather than in either engine.
//
// `bg` and `fg` are the book's own page colours. The surrounding chrome reads
// its colours from a matching `body[data-theme="..."]` block in css/app.css --
// adding a theme means adding it in both places, plus nothing else: the picker
// in the toolbar is built from this object.
export const THEMES = {
  light:    { label: 'Light',          bg: '#ffffff', fg: '#1a1a1a' },
  sepia:    { label: 'Sepia',          bg: '#f4ecd8', fg: '#3a3128' },
  dark:     { label: 'Dark',           bg: '#151515', fg: '#c9c9c9' },
  night:    { label: 'Amber on black', bg: '#0b0b0b', fg: '#d8a94e' },
  green:    { label: 'Green on black', bg: '#000000', fg: '#45de6c' },
  contrast: { label: 'High contrast',  bg: '#000000', fg: '#ffffff' },
};

// Highlight colors. Add one here and it appears in the selection toolbar.
// These are drawn as SVG over the text, so they need to be light enough to
// read through in every theme.
export const HIGHLIGHT_COLORS = [
  { name: 'yellow', value: '#ffd54a' },
  { name: 'green', value: '#8fd97f' },
  { name: 'blue', value: '#7fc4ee' },
  { name: 'pink', value: '#f2a0c0' },
];
