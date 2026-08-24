// Picks an engine, and owns saving your place.
//
// The engines know how to render and navigate; they know nothing about
// storage. All the "remember where I left off" writing happens here, in one
// place, so there is only one thing to get right.

import { db } from './db.js';

export function detectFormat(filename) {
  if (/\.epub$/i.test(filename)) return 'epub';
  if (/\.pdf$/i.test(filename)) return 'pdf';
  return null;
}

// Engines are loaded on demand: opening an epub never pays for pdf.js.
function engineFor(format) {
  if (format === 'pdf') return import('./pdf-engine.js');
  return import('./epub-engine.js');
}

// Both engines hand rendering to a library whose internal queues can, rarely,
// fail to settle -- which would leave the reader on a blank page with no
// explanation. Cap the wait so it surfaces as an error the UI can report.
const OPEN_TIMEOUT_MS = 30000;

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

// Why a file would not open, in words worth showing someone. A reader that
// says "could not be opened" for a DRM-locked file invites you to go looking
// for a bug that is not there.
export function describeFileError(err, filename) {
  const name = err?.name || '';
  const message = String(err?.message || '');

  if (name === 'PasswordException' || /password/i.test(message)) {
    return `${filename} is password-protected, so it cannot be opened.`;
  }
  if (/encryption|encrypted|drm/i.test(message)) {
    return `${filename} is locked by its publisher (DRM). No reader but the publisher's own can open it.`;
  }
  if (/invalid|corrupt|xref|structure|not a|zip/i.test(message)) {
    return `${filename} looks damaged, so it cannot be read.`;
  }
  return `${filename} could not be opened.`;
}

// Anything thrown here means the file itself will not open, and the caller
// should refuse it rather than shelve a book that can never be read. Missing
// titles and covers are handled inside the engines and never throw.
export async function readMetadata(format, bytes, filename) {
  const engine = await engineFor(format);
  const meta = await engine.metadata(bytes);
  return {
    title: meta.title || filename.replace(/\.(epub|pdf)$/i, ''),
    author: meta.author || 'Unknown author',
    cover: meta.cover,
  };
}

export async function openBook(record, container, hooks = {}) {
  const engine = await engineFor(record.format);

  let pending = null;
  let timer = null;

  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const fields = pending;
    pending = null;
    db.patch(record.id, { ...fields, lastRead: Date.now() })
      .catch(err => console.warn('could not save position', err));
  };

  const controller = await withTimeout(engine.open(record, container, {
    onProgress: ({ position, percent, label, toc }) => {
      pending = { position, percent };
      if (!timer) timer = setTimeout(flush, 500);
      hooks.onProgress?.({ percent, label, toc });
    },
    // epub.js builds its locations index lazily; cache it so the next open of
    // this book gets percentages immediately.
    onLocations: (locations) => {
      db.patch(record.id, { locations }).catch(() => {});
    },
    onSelection: (selection) => hooks.onSelection?.(selection),
    onHighlightClick: (info) => hooks.onHighlightClick?.(info),
    onDismiss: () => hooks.onDismiss?.(),
    onNote: (note) => hooks.onNote?.(note),
    onNavState: (state) => hooks.onNavState?.(state),
  }), OPEN_TIMEOUT_MS, 'This book took too long to open. Try again.');

  // Highlights are deliberate actions, so they are written straight away
  // rather than debounced like the reading position.
  let highlights = [...(record.highlights || [])];

  async function persist() {
    await db.patch(record.id, { highlights });
    hooks.onHighlights?.(highlights);
  }

  // If the app is backgrounded or closed mid-page, write immediately. On a
  // tablet this is the common way a reading session ends.
  const onHide = () => flush();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onHide);

  return {
    ...controller,
    capabilities: { highlights: false, ...controller.capabilities },

    highlights: () => highlights,

    async addHighlight(cfi, text, color) {
      if (highlights.some(h => h.cfi === cfi)) return;
      const highlight = { cfi, text, color, created: Date.now() };
      highlights = [...highlights, highlight];
      controller.addHighlight?.(highlight);
      await persist();
    },

    async removeHighlight(cfi) {
      highlights = highlights.filter(h => h.cfi !== cfi);
      controller.removeHighlight?.(cfi);
      await persist();
    },

    async recolorHighlight(cfi, color) {
      const existing = highlights.find(h => h.cfi === cfi);
      if (!existing) return;
      // Redrawing is the only way to change an epub.js annotation's style.
      controller.removeHighlight?.(cfi);
      const updated = { ...existing, color };
      highlights = highlights.map(h => (h.cfi === cfi ? updated : h));
      controller.addHighlight?.(updated);
      await persist();
    },

    close() {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      flush();
      controller.destroy();
    },
  };
}
