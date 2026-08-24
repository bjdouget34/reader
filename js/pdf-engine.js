// PDF engine, built on pdf.js.
//
// A PDF is fixed pages, not reflowable text, so two things differ from the
// EPUB engine: the saved position is a page number rather than a CFI, and the
// scale control is page zoom rather than text size. Everything else exposes
// the same shape so app.js does not care which engine it is talking to.

import * as pdfjs from '../lib/pdf.min.mjs';
import { loadSettings, saveSettings } from './settings.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;

// Everything pdf.js might fetch is vendored in lib/, so a plane works.
const RESOURCES = {
  cMapUrl: new URL('../lib/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../lib/standard_fonts/', import.meta.url).href,
};

// Some tablets refuse to allocate very large canvases. Keeping the backing
// store under this many pixels avoids a blank page at high zoom.
const MAX_CANVAS_PIXELS = 12e6;

// pdf.js hands the buffer to its worker and detaches it, so always give it a
// copy -- otherwise the caller's ArrayBuffer is unusable afterwards.
function copy(bytes) {
  return bytes instanceof ArrayBuffer ? bytes.slice(0) : new Uint8Array(bytes).slice(0);
}

export async function open(record, container, hooks) {
  // Teardown lives on the loading task, not the document -- pdf.js 6 removed
  // PDFDocumentProxy.destroy(), so keep the task around for destroy().
  const task = pdfjs.getDocument({ data: copy(record.file), ...RESOURCES });
  const doc = await task.promise;
  const total = doc.numPages;

  const stage = document.createElement('div');
  stage.className = 'pdf-stage';

  // The page box is sized in CSS pixels. The canvas inside it has a larger
  // backing store for sharpness, while the text layer must line up with the
  // CSS size -- hence the two viewports in render().
  const pageBox = document.createElement('div');
  pageBox.className = 'pdf-page';
  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';

  pageBox.append(canvas, textLayerDiv);
  stage.append(pageBox);
  container.append(stage);
  const ctx = canvas.getContext('2d', { alpha: false });

  let page = clamp(Number(record.position) || 1, 1, total);
  let renderTask = null;
  let textLayer = null;
  let destroyed = false;

  // Outline entries are handed to the UI as opaque tokens; resolving a PDF
  // destination to a page number needs an async call, so we defer it to goto().
  let outlineDests = [];

  async function buildToc() {
    let outline = null;
    try { outline = await doc.getOutline(); } catch { /* many PDFs have none */ }
    const flat = [];
    const walk = (items, depth) => {
      for (const item of items || []) {
        flat.push({ label: (item.title || '').trim(), href: `outline:${outlineDests.length}`, depth });
        outlineDests.push(item.dest);
        if (item.items?.length) walk(item.items, depth + 1);
      }
    };
    walk(outline, 0);
    return flat;
  }

  let toc = [];
  buildToc().then((t) => { toc = t; report(); });

  function report() {
    hooks.onProgress?.({
      position: page,
      percent: Math.round((page / total) * 100),
      label: `${page} / ${total}`,
      toc,
    });
  }

  async function render() {
    if (destroyed) return;
    if (renderTask) { try { renderTask.cancel(); } catch { /* ignore */ } }

    const pdfPage = await doc.getPage(page);
    const unscaled = pdfPage.getViewport({ scale: 1 });

    // Fit to the width we have, then apply the user's zoom on top.
    const avail = Math.max(240, stage.clientWidth || container.clientWidth);
    const zoom = loadSettings().zoom / 100;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let scale = (avail / unscaled.width) * zoom * dpr;

    const pixels = unscaled.width * scale * unscaled.height * scale;
    if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

    const viewport = pdfPage.getViewport({ scale });          // device pixels
    const cssViewport = pdfPage.getViewport({ scale: scale / dpr }); // CSS pixels

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(cssViewport.width) + 'px';
    canvas.style.height = Math.floor(cssViewport.height) + 'px';

    pageBox.style.width = Math.floor(cssViewport.width) + 'px';
    pageBox.style.height = Math.floor(cssViewport.height) + 'px';
    // The vendored text layer CSS sizes its spans from this.
    pageBox.style.setProperty('--total-scale-factor', String(scale / dpr));

    renderTask = pdfPage.render({ canvasContext: ctx, viewport });
    try {
      await renderTask.promise;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') throw err;
      return;   // a newer page is already rendering
    } finally {
      renderTask = null;
    }

    await renderTextLayer(pdfPage, cssViewport);
    pdfPage.cleanup();

    // Back to the top left of the new page. Leaving scrollLeft where it was
    // meant a zoomed-in reader turned the page and stayed panned sideways,
    // which reads as a gap down one edge.
    stage.scrollTop = 0;
    stage.scrollLeft = 0;
    report();
  }

  // Invisible, selectable text positioned over the canvas. Scanned PDFs carry
  // no text at all, in which case this simply produces nothing.
  async function renderTextLayer(pdfPage, cssViewport) {
    if (textLayer) { try { textLayer.cancel(); } catch { /* ignore */ } }
    textLayerDiv.textContent = '';
    try {
      textLayer = new pdfjs.TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container: textLayerDiv,
        viewport: cssViewport,
      });
      await textLayer.render();
    } catch (err) {
      // Losing selectable text is not worth failing the page render over.
      console.warn('text layer unavailable for this page', err);
    }
  }

  async function show(n) {
    const next = clamp(n, 1, total);
    if (next === page) return;
    page = next;
    await render();
  }

  const onKey = (e) => {
    // Arrow keys belong to whatever field has focus -- the search box, for one.
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') show(page + 1);
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') show(page - 1);
  };
  document.addEventListener('keydown', onKey);

  // Swipe. Unlike the EPUB engine there is no iframe in the way, so this can
  // live on the container directly.
  let x0 = null, y0 = null;
  const onTouchStart = (e) => {
    x0 = e.changedTouches[0].clientX;
    y0 = e.changedTouches[0].clientY;
  };
  const onTouchEnd = (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
      show(dx < 0 ? page + 1 : page - 1);
    }
    x0 = y0 = null;
  };
  stage.addEventListener('touchstart', onTouchStart, { passive: true });
  stage.addEventListener('touchend', onTouchEnd, { passive: true });

  const onResize = debounce(() => { render().catch(() => {}); }, 200);
  window.addEventListener('resize', onResize);

  // As in the epub engine: the toolbar collapsing resizes our box without
  // resizing the window. Only the width changes what a page renders at, so a
  // height-only change is not worth redrawing a page for.
  let lastWidth = container.clientWidth;
  const boxObserver = new ResizeObserver(() => {
    if (container.clientWidth === lastWidth) return;
    lastWidth = container.clientWidth;
    onResize();
  });
  boxObserver.observe(container);

  await render();

  return {
    // Highlighting a PDF means drawing boxes over coordinates rather than
    // marking up text, which is a different job. The UI hides the control.
    capabilities: { highlights: false, search: true },

    // One page at a time, using the same text pdf.js extracts for the
    // selectable layer. A scanned PDF has no text, so this correctly finds
    // nothing however long you wait.
    async search(query, { signal, onBatch, onProgress, cap = 300 } = {}) {
      const needle = query.toLowerCase();
      let found = 0;

      for (let n = 1; n <= total; n++) {
        if (signal?.aborted || found >= cap) break;

        let pdfPage;
        try {
          pdfPage = await doc.getPage(n);
          if (signal?.aborted) break;
          const content = await pdfPage.getTextContent();
          const text = content.items
            .map(item => item.str + (item.hasEOL ? '\n' : ''))
            .join('')
            .replace(/\s+/g, ' ');

          const hits = [];
          const haystack = text.toLowerCase();
          let at = haystack.indexOf(needle);
          while (at !== -1 && found + hits.length < cap) {
            hits.push({
              href: `page:${n}`,
              page: n,
              excerpt: excerptAround(text, at, needle.length),
            });
            at = haystack.indexOf(needle, at + needle.length);
          }

          if (hits.length) { found += hits.length; onBatch?.(hits); }
        } catch {
          // Skip a page that will not parse rather than failing the search.
        } finally {
          pdfPage?.cleanup();
        }
        onProgress?.(n, total, found);
      }
      return { total: found, capped: found >= cap };
    },

    next: () => show(page + 1),
    prev: () => show(page - 1),

    async goto(href) {
      // Search results address a page directly; outline entries need resolving.
      const direct = /^page:(\d+)$/.exec(href || '');
      if (direct) { await show(Number(direct[1])); return; }

      const match = /^outline:(\d+)$/.exec(href || '');
      if (!match) return;
      let dest = outlineDests[Number(match[1])];
      try {
        if (typeof dest === 'string') dest = await doc.getDestination(dest);
        if (!Array.isArray(dest)) return;
        const ref = dest[0];
        const index = (ref && typeof ref === 'object')
          ? await doc.getPageIndex(ref)
          : Number(ref);
        if (Number.isFinite(index)) await show(index + 1);
      } catch { /* broken outline entry; leave the page alone */ }
    },

    // Theming a PDF means filtering the rendered image -- see .pdf-canvas in
    // app.css. Nothing to do here beyond recording the choice.
    setTheme(name) { saveSettings({ theme: name }); },

    scaleLabel: () => loadSettings().zoom + '%',
    setScale(delta) {
      const next = clamp(loadSettings().zoom + delta, 50, 400);
      saveSettings({ zoom: next });
      render().catch(() => {});
      return next + '%';
    },

    destroy() {
      destroyed = true;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      boxObserver.disconnect();
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchend', onTouchEnd);
      if (renderTask) { try { renderTask.cancel(); } catch { /* ignore */ } }
      if (textLayer) { try { textLayer.cancel(); } catch { /* ignore */ } }
      task.destroy().catch(() => {});
      stage.remove();
    },
  };
}

export async function metadata(bytes) {
  const task = pdfjs.getDocument({ data: copy(bytes), ...RESOURCES });
  const doc = await task.promise;

  let title = null, author = null;
  try {
    const { info } = await doc.getMetadata();
    title = (info?.Title || '').trim() || null;
    author = (info?.Author || '').trim() || null;
  } catch { /* fall back to the filename */ }

  // First page, rendered small, makes a serviceable cover.
  let cover = null;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 400 / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    cover = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.8));
    page.cleanup();
  } catch { /* no cover, the library shows a letter tile */ }

  task.destroy().catch(() => {});
  return { title, author, cover };
}

// A window of text around a match, so a result reads like a sentence rather
// than a bare hit.
function excerptAround(text, at, length, pad = 60) {
  const start = Math.max(0, at - pad);
  const end = Math.min(text.length, at + length + pad);
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '');
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
