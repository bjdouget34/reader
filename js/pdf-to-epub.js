// Making an EPUB copy of a PDF, on the device.
//
// A PDF is pages; an EPUB is text that flows to fit the screen, so the text
// can be made bigger, recoloured by the themes, and read on a phone without
// zooming. This reads each page's text (pdf-text.js decides what is a
// paragraph, a heading, a picture), cuts out the pictures by drawing the page
// and keeping the part that is the picture, and packs the lot into an EPUB
// that goes into the library beside the PDF. The PDF is not changed.
//
// It is a reading of the layout and not a certainty, so what it cannot reflow
// it keeps as it was: a table, or a scanned page, is a picture of that page.

import { ask, progress, timeLeft } from './convert-dialog.js';
import { readPage, planDocument, buildEpub } from './pdf-text.js';
import { loadDocument, OPS } from './pdf-engine.js';

// How wide a whole page is drawn when it is kept as a picture -- enough to
// read a table on a tablet, zoomed in -- and a cap on any one drawing, which
// a phone would otherwise refuse to allocate.
const PAGE_PX = 1400;
const MAX_PIXELS = 12e6;

// Shares of the progress bar: reading every page is most of the work.
const READ_SHARE = 0.75;
const PICTURE_SHARE = 0.22;

// A reason worth telling the reader, as opposed to something going wrong.
export class ConvertError extends Error {
  constructor(message) { super(message); this.name = 'ConvertError'; }
}

// Resolves to { bytes, summary } -- or { cancelled: true }.
export async function convertPdfToEpub(record, { replacing = false } = {}) {
  const yes = await ask({
    title: 'Make an EPUB copy?',
    text: `The text of "${record.title}" is laid out again so it flows to fit the screen: `
      + 'it can be made bigger, and the colour themes change it properly. '
      + 'Pictures stay where they were; tables and pages too complicated to lay out again '
      + 'are kept as pictures of the page.\n\n'
      + (replacing
        ? 'This replaces the EPUB copy made before, along with its highlights and place. '
        : 'The copy goes into your library beside the PDF, which stays as it is. ')
      + 'Highlights are not copied across from the PDF. Keep the app open until it finishes.',
    go: 'Make EPUB',
  });
  if (!yes) return { cancelled: true };

  let cancelled = false;
  const dialog = progress({
    title: 'Making the EPUB…',
    text: 'Keep the app open until this finishes. The PDF stays as it is.',
    onCancel: () => { cancelled = true; },
  });
  dialog.status('Opening the PDF…');
  const task = loadDocument(record.file);
  try {
    const doc = await task.promise;
    const total = doc.numPages;
    const started = performance.now();
    const elapsed = () => (performance.now() - started) / 1000;
    const show = (line, fraction) => {
      const left = timeLeft(fraction, elapsed());
      dialog.status(left ? `${line} · ${left}` : line, fraction);
    };

    const pages = [];
    for (let n = 1; n <= total; n++) {
      if (cancelled) return { cancelled: true };
      const page = await doc.getPage(n);
      pages.push(await readPage(page, OPS));
      page.cleanup();
      show(`Reading page ${n} of ${total}`, (READ_SHARE * n) / total);
    }

    const plan = planDocument(pages);
    const words = plan.blocks.reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0), 0);
    if (words < 50) {
      throw new ConvertError('This PDF has almost no text to lay out again -- it is most likely scanned pages, '
        + 'which are pictures of text. An EPUB of it would be the same pictures, so none was made.');
    }

    const images = await drawPictures(doc, plan.figures, {
      cancelled: () => cancelled,
      step: (done, count) => show(`Pictures ${done} of ${count}`, READ_SHARE + (PICTURE_SHARE * done) / count),
    });
    if (cancelled) return { cancelled: true };
    // A picture that could not be drawn is left out rather than shown broken.
    plan.blocks = plan.blocks.filter(b => b.type !== 'figure' || images.has(b.id));

    dialog.status('Putting the EPUB together…', READ_SHARE + PICTURE_SHARE);
    const cover = record.cover ? new Uint8Array(await record.cover.arrayBuffer()) : null;
    const bytes = await buildEpub(globalThis.JSZip, {
      plan, title: record.title, author: record.author, images, cover,
      sourceName: `${record.title} (PDF)`,
    });

    const chapters = plan.blocks.filter(b => b.type === 'h' && b.level === 2).length;
    const wholePages = plan.figures.filter(f => f.whole && images.has(f.id)).length;
    const pictures = images.size - wholePages;
    return { bytes, summary: { pages: total, chapters, pictures, wholePages } };
  } finally {
    dialog.close();
    task.destroy().catch(() => {});
  }
}

// Each picture, as a JPEG: its page drawn once, and the picture's part of it
// kept. Drawing the page, rather than lifting the image out of the file, is
// what gets masks, colour spaces and anything drawn over the image right.
async function drawPictures(doc, figures, { cancelled, step }) {
  const images = new Map();
  const byPage = new Map();
  for (const f of figures) {
    if (!byPage.has(f.page)) byPage.set(f.page, []);
    byPage.get(f.page).push(f);
  }
  let done = 0;
  for (const [n, list] of byPage) {
    if (cancelled()) break;
    let page = null;
    const canvas = document.createElement('canvas');
    try {
      page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(PAGE_PX / base.width, Math.sqrt(MAX_PIXELS / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      for (const f of list) {
        const box = f.whole ? { x0: 0, y0: 0, x1: base.width, y1: base.height } : f.box;
        const pad = f.whole ? 0 : 3;
        const sx = Math.max(0, Math.floor((box.x0 - pad) * scale));
        const sy = Math.max(0, Math.floor((box.y0 - pad) * scale));
        const sw = Math.min(canvas.width, Math.ceil((box.x1 + pad) * scale)) - sx;
        const sh = Math.min(canvas.height, Math.ceil((box.y1 + pad) * scale)) - sy;
        if (sw < 4 || sh < 4) continue;
        const out = document.createElement('canvas');
        out.width = sw;
        out.height = sh;
        out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        const blob = await new Promise(res => out.toBlob(res, 'image/jpeg', 0.85));
        out.width = out.height = 0;
        if (blob) images.set(f.id, new Uint8Array(await blob.arrayBuffer()));
        step(++done, figures.length);
      }
    } catch (err) {
      console.warn('[pdf-to-epub] page', n, 'could not be drawn', err);
    } finally {
      canvas.width = canvas.height = 0;
      page?.cleanup();
    }
  }
  return images;
}
