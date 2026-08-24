// Display preferences. These are small and non-precious, so localStorage is
// the right home for them -- books and reading positions go in IndexedDB.

const KEY = 'my-reader:settings';

const DEFAULTS = {
  theme: 'light',   // light | sepia | dark
  fontSize: 100,    // epub text size, percent
  zoom: 100,        // pdf zoom, percent of fit-to-width
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
export const THEMES = {
  light: { bg: '#ffffff', fg: '#1a1a1a' },
  sepia: { bg: '#f4ecd8', fg: '#3a3128' },
  dark:  { bg: '#151515', fg: '#c9c9c9' },
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
