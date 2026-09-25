// PDF engine, built on pdf.js.
//
// A PDF is fixed pages, not reflowable text, so it is read as one continuous
// scroll rather than paginated. Paging a fixed page worked until you zoomed in:
// then every page meant scrolling to its bottom and swiping for the next one.
// Scrolling makes the zoomed case the same as the unzoomed one.
//
// The saved position is still about pages -- page number plus how far down it
// you were -- so coming back puts you where you left off even if the screen or
// the zoom changed in between. Everything else exposes the same shape as the
// epub engine, so app.js does not care which one it is talking to.

import * as pdfjs from '../lib/pdf.min.mjs';
import { loadSettings, saveSettings } from './settings.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../lib/pdf.worker.min.mjs', import.meta.url).href;

// Everything pdf.js might fetch is vendored in lib/, so a plane works.
const RESOURCES = {
  cMapUrl: new URL('../lib/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../lib/standard_fonts/', import.meta.url).href,
};

// Some tablets refuse to allocate very large canvases, and several pages are
// alive at once in a scroll, so each one's backing store is capped. Zoomed far
// in, a page is drawn slightly softer rather than not at all.
const MAX_CANVAS_PIXELS = 8e6;

// How many pages either side of the visible ones to draw ahead of need, and how
// far away a drawn page has to scroll before its canvas is freed. Drawing ahead
// is what stops a blank page sliding into view; freeing is what stops a long
// book holding hundreds of canvases in memory.
const RENDER_AHEAD = 1;
const KEEP_WITHIN = 3;

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

  // The stage scrolls. The column inside it stacks the pages; it is as wide as
  // the widest page, so a zoomed page can be panned to either edge.
  const stage = document.createElement('div');
  stage.className = 'pdf-stage';
  const column = document.createElement('div');
  column.className = 'pdf-column';
  stage.append(column);
  container.append(stage);

  let destroyed = false;

  // Every page's size, read up front. The scroll height has to be right before
  // anything is drawn -- otherwise restoring your place lands on a guess, and
  // the scrollbar jumps as pages of the wrong height are corrected. Asked for in
  // parallel batches; it is what pdf.js's own viewer does too.
  const sizes = new Array(total);
  for (let start = 1; start <= total; start += 32) {
    const batch = [];
    for (let n = start; n < start + 32 && n <= total; n++) {
      batch.push(doc.getPage(n).then((p) => {
        const v = p.getViewport({ scale: 1 });
        sizes[n - 1] = { w: v.width, h: v.height };
      }));
    }
    await Promise.all(batch);
  }

  // One slot per page. A slot is always in the column at its full size, drawn
  // or not; only its contents come and go.
  const slots = sizes.map((size, i) => {
    const el = document.createElement('div');
    el.className = 'pdf-page';
    el.dataset.page = String(i + 1);
    column.append(el);
    return {
      n: i + 1, el, size,
      canvas: null, hlDiv: null, textDiv: null,
      drawnKey: null,     // the scale this slot's canvas was drawn at
      wantKey: null,      // the scale a draw in progress is aiming for
      renderTask: null, textLayer: null,
    };
  });

  // Fit to the typical page width rather than each page's own, so every page
  // shares one scale and the column reads as one document. The median, so a
  // single landscape plate does not shrink every portrait page around it.
  const baseWidth = [...sizes].map(s => s.w).sort((a, b) => a - b)[Math.floor(total / 2)];

  let cssScale = 1;
  let offsets = [];
  let heights = [];

  function layout() {
    const avail = Math.max(240, stage.clientWidth);
    cssScale = (avail / baseWidth) * (loadSettings().zoom / 100);
    for (const s of slots) {
      s.el.style.width = Math.floor(s.size.w * cssScale) + 'px';
      s.el.style.height = Math.floor(s.size.h * cssScale) + 'px';
      // The vendored text layer CSS sizes its spans from this, so updating it
      // realigns an already-drawn text layer at once.
      s.el.style.setProperty('--total-scale-factor', String(cssScale));
    }
    // Read back from the DOM rather than summed by hand, so these cannot drift
    // from whatever gaps and padding the stylesheet says.
    offsets = slots.map(s => s.el.offsetTop);
    heights = slots.map(s => s.el.offsetHeight);
  }

  // The last page whose top is at or above y.
  function indexAt(y) {
    let lo = 0, hi = total - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // Where you are, as a page and how far down it -- which survives the screen
  // or the zoom changing, where a raw scroll offset would not.
  function anchorNow() {
    const i = indexAt(stage.scrollTop);
    const frac = clamp((stage.scrollTop - offsets[i]) / (heights[i] || 1), 0, 0.999);
    return { page: i + 1, frac };
  }

  function scrollToAnchor({ page, frac = 0 }) {
    const i = clamp(page, 1, total) - 1;
    stage.scrollTop = offsets[i] + frac * heights[i];
  }

  // ---------------------------------------------------------------- drawing

  function drawKey() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    return cssScale.toFixed(5) + '@' + dpr;
  }

  function cancelSlot(s) {
    if (s.renderTask) { try { s.renderTask.cancel(); } catch { /* ignore */ } s.renderTask = null; }
    if (s.textLayer) { try { s.textLayer.cancel(); } catch { /* ignore */ } s.textLayer = null; }
  }

  function releaseSlot(s) {
    if (!s.drawnKey && !s.wantKey) return;
    cancelSlot(s);
    // Zeroing the canvas hands its memory back straight away rather than
    // whenever the collector gets to it -- which on a tablet matters.
    if (s.canvas) { s.canvas.width = 0; s.canvas.height = 0; }
    s.el.replaceChildren();
    s.canvas = s.hlDiv = s.textDiv = null;
    s.drawnKey = s.wantKey = null;
    if (remembered?.anchor.page === s.n) forgetSelection();
  }

  async function drawSlot(s) {
    const key = drawKey();
    if (s.drawnKey === key || s.wantKey === key) return;
    cancelSlot(s);
    s.wantKey = key;

    let pdfPage;
    try {
      pdfPage = await doc.getPage(s.n);
    } catch { s.wantKey = null; return; }
    if (destroyed || s.wantKey !== key) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let scale = cssScale * dpr;
    const pixels = s.size.w * scale * s.size.h * scale;
    if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);

    const viewport = pdfPage.getViewport({ scale });            // device pixels
    const cssViewport = pdfPage.getViewport({ scale: cssScale }); // CSS pixels

    // Drawn into a fresh canvas and swapped in when finished, so on a zoom the
    // old canvas -- stretched, a little soft -- stays up until the sharp one is
    // ready, rather than the page flashing blank.
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    const renderTask = pdfPage.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
    s.renderTask = renderTask;
    try {
      await renderTask.promise;
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.warn('page render failed', s.n, err);
      if (s.wantKey === key) s.wantKey = null;
      return;
    } finally {
      if (s.renderTask === renderTask) s.renderTask = null;
    }
    if (destroyed || s.wantKey !== key) { canvas.width = 0; return; }

    // Order matters: the canvas paints the page, the highlight boxes sit on top
    // of it, and the invisible text layer sits on top of those so selection
    // still works through them.
    const hlDiv = document.createElement('div');
    hlDiv.className = 'pdf-highlights';
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';

    if (s.canvas) { s.canvas.width = 0; s.canvas.height = 0; }
    s.el.replaceChildren(canvas, hlDiv, textDiv);
    s.canvas = canvas; s.hlDiv = hlDiv; s.textDiv = textDiv;
    s.drawnKey = key; s.wantKey = null;
    paintHighlights(s);

    // Invisible, selectable text over the canvas. A scanned PDF carries no text
    // at all, in which case this simply produces nothing.
    try {
      const textLayer = new pdfjs.TextLayer({
        textContentSource: pdfPage.streamTextContent(),
        container: textDiv,
        viewport: cssViewport,
      });
      s.textLayer = textLayer;
      await textLayer.render();
    } catch (err) {
      if (err?.name !== 'AbortException') console.warn('text layer unavailable for page', s.n, err);
    } finally {
      s.textLayer = null;
    }
    pdfPage.cleanup();
  }

  // What is on screen decides what gets drawn and what gets let go.
  function update() {
    if (destroyed || !offsets.length) return;
    const top = stage.scrollTop;
    const first = indexAt(top);
    const last = indexAt(top + stage.clientHeight);

    for (let i = first; i <= last; i++) drawSlot(slots[i]);
    for (let d = 1; d <= RENDER_AHEAD; d++) {
      if (slots[last + d]) drawSlot(slots[last + d]);
      if (slots[first - d]) drawSlot(slots[first - d]);
    }
    for (const s of slots) {
      const i = s.n - 1;
      if (i < first - KEEP_WITHIN || i > last + KEEP_WITHIN) releaseSlot(s);
    }
    report();
  }

  let frame = 0;
  const onScroll = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; update(); });
  };
  stage.addEventListener('scroll', onScroll, { passive: true });

  // Re-fit keeping your place: the anchor is taken before the sizes change and
  // put back after, and the horizontal centre is kept too, so zooming in holds
  // on what you were looking at rather than jumping to the left edge.
  function relayoutKeepingPlace() {
    if (destroyed) return;
    const anchor = anchorNow();
    const centreX = stage.scrollWidth
      ? (stage.scrollLeft + stage.clientWidth / 2) / stage.scrollWidth
      : 0.5;
    layout();
    scrollToAnchor(anchor);
    stage.scrollLeft = Math.max(0, centreX * stage.scrollWidth - stage.clientWidth / 2);
    update();
  }

  // --------------------------------------------------------- where you are

  // Outline entries are handed to the UI as opaque tokens; resolving a PDF
  // destination to a page number needs an async call, so it waits for goto().
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
    if (!offsets.length) return;
    const anchor = anchorNow();
    // The label names the page filling the middle of the screen -- the one you
    // are reading -- while the saved position is the exact anchor, so coming
    // back restores the scroll itself rather than the top of a page.
    const shown = indexAt(stage.scrollTop + stage.clientHeight / 2) + 1;
    const atEnd = stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2;
    hooks.onProgress?.({
      position: Math.round((anchor.page + anchor.frac) * 10000) / 10000,
      percent: atEnd ? 100 : Math.round(((anchor.page - 1 + anchor.frac) / total) * 100),
      label: `${shown} / ${total}`,
      toc,
    });
  }

  // Jumps from Contents, search results and the Highlights list. `y` is how far
  // down the page to land, so a jump to a highlight puts it on screen rather
  // than leaving it somewhere below the top of its page.
  function jumpTo(page, y = 0) {
    const i = clamp(page, 1, total) - 1;
    // A little headroom above the target, so it is not glued to the top edge.
    const headroom = y > 0 ? stage.clientHeight * 0.25 : 0;
    stage.scrollTop = Math.max(0, offsets[i] + y * heights[i] - headroom);
    update();
  }

  // ------------------------------------------------------------- highlights
  //
  // A PDF has no markup to mark up, only glyphs at coordinates, so a highlight
  // is stored as rectangles expressed as fractions of its page. Fractions
  // rather than pixels: the same numbers hold at any zoom, and the boxes are
  // positioned in percentages so they need no recalculating.

  let highlights = [];
  let remembered = null;      // { anchor: { page, rects }, text }

  function forgetSelection() {
    remembered = null;
    hooks.onSelectionAvailable?.(null);
  }

  function paintHighlights(s) {
    if (!s.hlDiv) return;
    s.hlDiv.textContent = '';
    for (const h of highlights) {
      if (h.anchor?.page !== s.n) continue;
      for (const r of h.anchor.rects || []) {
        const box = document.createElement('div');
        box.className = 'pdf-highlight';
        box.style.left = (r.x * 100) + '%';
        box.style.top = (r.y * 100) + '%';
        box.style.width = (r.w * 100) + '%';
        box.style.height = (r.h * 100) + '%';
        box.style.background = h.color;
        s.hlDiv.append(box);
      }
    }
  }

  function syncHighlights(list) {
    highlights = list || [];
    for (const s of slots) paintHighlights(s);
  }

  // The boxes take no pointer events, so that selecting text through them still
  // works. A tap on one is found by arithmetic instead, on whichever page the
  // tap landed.
  const onClick = (e) => {
    const pageEl = e.target?.closest?.('.pdf-page');
    if (!pageEl) return;
    const n = Number(pageEl.dataset.page);
    const box = pageEl.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const nx = (e.clientX - box.left) / box.width;
    const ny = (e.clientY - box.top) / box.height;
    const hit = highlights.find(h => h.anchor?.page === n
      && (h.anchor.rects || []).some(r => nx >= r.x && nx <= r.x + r.w
                                       && ny >= r.y && ny <= r.y + r.h));
    if (hit) hooks.onHighlightClick?.({ id: hit.id, rect: null });
  };
  stage.addEventListener('click', onClick);

  // Unlike the epub engine there is no iframe: the text layers live in this
  // document, so the selection is right here. A selection is anchored to the
  // page it starts on; the part of one that runs onto the next page is dropped,
  // since a highlight belongs to a single page.
  const onSelectionChange = () => {
    const selection = document.getSelection();
    const text = selection?.toString().trim();
    if (!text || !selection.rangeCount) return;

    const range = selection.getRangeAt(0);
    const startNode = range.startContainer;
    const startEl = startNode.nodeType === 1 ? startNode : startNode.parentElement;
    const pageEl = startEl?.closest?.('.pdf-page');
    if (!pageEl || !stage.contains(pageEl)) return;

    const n = Number(pageEl.dataset.page);
    const box = pageEl.getBoundingClientRect();
    if (!box.width || !box.height) return;

    const rects = [...range.getClientRects()]
      .filter(r => r.width > 1 && r.height > 1)
      .filter(r => r.bottom > box.top && r.top < box.bottom)
      .map(r => ({
        x: (r.left - box.left) / box.width,
        y: (r.top - box.top) / box.height,
        w: r.width / box.width,
        h: r.height / box.height,
      }));
    if (!rects.length) return;

    remembered = { anchor: { page: n, rects }, text };
    hooks.onSelectionAvailable?.({ text });
  };
  document.addEventListener('selectionchange', onSelectionChange);

  // The stage is not focused by default, so the keys are handled here rather
  // than left to the browser's own scrolling.
  const onKey = (e) => {
    // Keys belong to whatever field has focus -- the search box, for one.
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    const screen = stage.clientHeight * 0.9;
    const moves = {
      ArrowDown: 60, ArrowUp: -60,
      PageDown: screen, PageUp: -screen, ' ': e.shiftKey ? -screen : screen,
    };
    if (e.key in moves) { e.preventDefault(); stage.scrollBy({ top: moves[e.key] }); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); jumpTo(anchorNow().page + 1); }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const a = anchorNow();
      // Back to the top of this page first, the way a book's page-up does.
      jumpTo(a.frac > 0.02 ? a.page : a.page - 1);
    }
  };
  document.addEventListener('keydown', onKey);

  // Only the width changes what a page is drawn at. A height change -- the
  // toolbar collapsing, say -- only changes how much is on screen.
  let lastWidth = stage.clientWidth;
  const onResize = debounce(() => {
    if (stage.clientWidth !== lastWidth) {
      lastWidth = stage.clientWidth;
      relayoutKeepingPlace();
    } else {
      update();
    }
  }, 150);
  window.addEventListener('resize', onResize);
  const boxObserver = new ResizeObserver(onResize);
  boxObserver.observe(stage);

  // Start where we left off. A position saved before scrolling existed is a
  // bare page number, which reads as the top of that page.
  layout();
  const saved = Number(record.position) || 1;
  const savedPage = clamp(Math.floor(saved), 1, total);
  scrollToAnchor({ page: savedPage, frac: clamp(saved - savedPage, 0, 0.999) });
  update();

  return {
    capabilities: { highlights: true, search: true },

    captureSelection: () => remembered,
    clearSelection() {
      try { document.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
      forgetSelection();
    },
    syncHighlights,

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
          // Only pages that are not on screen: cleaning up a drawn page would
          // throw away resources it is about to need again.
          if (pdfPage && !slots[n - 1].drawnKey && !slots[n - 1].wantKey) pdfPage.cleanup();
        }
        onProgress?.(n, total, found);
      }
      return { total: found, capped: found >= cap };
    },

    relayout() { relayoutKeepingPlace(); },

    // Words for speed reading, a page at a time, starting from the first line
    // below the top of the screen. Each word remembers its page and how far
    // down it sits, which is all it takes to scroll back to it.
    async speedSource() {
      const here = anchorNow();

      async function load(n) {
        let pdfPage;
        try {
          pdfPage = await doc.getPage(n);
          const content = await pdfPage.getTextContent();
          return { words: pdfWords(content.items, n, sizes[n - 1].h) };
        } catch {
          return { words: [] };
        } finally {
          // As in search: never clean up a page that is on screen.
          if (pdfPage && !slots[n - 1].drawnKey && !slots[n - 1].wantKey) pdfPage.cleanup();
        }
      }

      return {
        first: 1,
        last: total,
        async start() {
          // Image-only pages and a scan are skipped over, but not forever:
          // a scanned PDF is nothing but image pages.
          for (let n = here.page; n <= total && n < here.page + 25; n++) {
            const chunk = await load(n);
            const i = n === here.page
              ? chunk.words.findIndex(w => w.y >= here.frac - 0.005)
              : (chunk.words.length ? 0 : -1);
            if (i >= 0) return { c: n, i, chunk };
          }
          return null;
        },
        load,
        label: (n) => ({ text: `Page ${n} of ${total}` }),
        goTo: async (word) => jumpTo(word.page, word.y),
      };
    },

    // There are no page turns in a scroll; these move a page at a time for
    // anything that still asks.
    next: () => jumpTo(anchorNow().page + 1),
    prev: () => jumpTo(anchorNow().page - 1),

    async goto(href) {
      // `page:N`, optionally `page:N:y` with y a fraction of the page -- the
      // Highlights list uses that to land on the highlight itself.
      const direct = /^page:(\d+)(?::([\d.]+))?$/.exec(href || '');
      if (direct) { jumpTo(Number(direct[1]), clamp(Number(direct[2]) || 0, 0, 1)); return; }

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
        if (!Number.isFinite(index)) return;
        jumpTo(index + 1, destinationY(dest, sizes[index]));
      } catch { /* broken outline entry; stay where we are */ }
    },

    // Theming a PDF means filtering the rendered image -- see .pdf-canvas in
    // app.css. Nothing to do here beyond recording the choice.
    setTheme(name) { saveSettings({ theme: name }); },

    scaleLabel: () => loadSettings().zoom + '%',
    setScale(delta) {
      const next = clamp(loadSettings().zoom + delta, 50, 400);
      saveSettings({ zoom: next });
      relayoutKeepingPlace();
      return next + '%';
    },

    destroy() {
      destroyed = true;
      if (frame) cancelAnimationFrame(frame);
      stage.removeEventListener('scroll', onScroll);
      stage.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('resize', onResize);
      boxObserver.disconnect();
      for (const s of slots) releaseSlot(s);
      task.destroy().catch(() => {});
      stage.remove();
    },
  };
}

// A page's text as words in reading order, for speed reading.
//
// pdf.js hands text over as runs, which may be a whole line or a single letter,
// so they are gathered into lines first -- a line ends where pdf.js says so or
// where the baseline moves. Then:
//   - a word hyphenated across a line break is joined back up ("exam-" "ple");
//   - a line in the top or bottom margin that is only a number is dropped,
//     since a page number flashed up between two sentences is noise;
//   - a noticeably bigger gap between lines counts as a paragraph break.
function pdfWords(items, page, pageHeight) {
  const lines = [];
  let line = null;
  for (const item of items) {
    if (typeof item.str !== 'string') continue;   // marked-content markers
    const y = item.transform[5];
    const h = Math.abs(item.transform[3]) || item.height || 0;
    if (!line || Math.abs(line.y - y) > Math.max(2, h * 0.5)) {
      line = { y, h, text: '' };
      lines.push(line);
    }
    line.text += item.str;
    line.h = Math.max(line.h, h);
    if (item.hasEOL) line = null;
  }

  const words = [];
  let previous = null;
  let hyphenated = false;
  for (const ln of lines) {
    const text = ln.text.trim();
    if (!text) continue;
    // PDF coordinates run upwards, so the top of the line is its baseline plus
    // its height, flipped.
    const top = Math.min(1, Math.max(0, 1 - (ln.y + ln.h) / pageHeight));
    if ((top < 0.08 || top > 0.92) && /^[\divxlcIVXLC\s.\-–—]+$/.test(text)) continue;

    if (previous && words.length) {
      const gap = previous.y - ln.y;
      if (gap > Math.max(previous.h, ln.h) * 1.8) words[words.length - 1].para = true;
    }

    const joinFirst = hyphenated;
    hyphenated = false;
    const tokens = text.match(/\S+/g) || [];
    tokens.forEach((t, k) => {
      if (k === 0 && joinFirst && /^\p{Ll}/u.test(t)) {
        const last = words[words.length - 1];
        last.t = last.t.slice(0, -1) + t;
        return;
      }
      words.push({ t, para: false, page, y: top });
    });
    const last = words[words.length - 1];
    hyphenated = !!last && /\p{L}-$/u.test(last.t);
    previous = ln;
  }
  return words;
}

// Where on its page an outline destination points, as a fraction from the top.
// PDF coordinates run upwards from the bottom of the page, hence the flip.
// Destinations that name no height -- Fit, FitV -- mean the top of the page.
function destinationY(dest, size) {
  const kind = dest?.[1]?.name;
  let top = null;
  if (kind === 'XYZ') top = dest[3];
  else if (kind === 'FitH' || kind === 'FitBH') top = dest[2];
  else if (kind === 'FitR') top = dest[5];
  if (typeof top !== 'number' || !size?.h) return 0;
  return clamp(1 - top / size.h, 0, 1);
}

// For the EPUB converter (pdf-to-epub.js): a document opened exactly as the
// reader opens one, fonts and character maps included, and pdf.js's names for
// its drawing operations, which say where the pictures are.
export function loadDocument(bytes) {
  return pdfjs.getDocument({ data: copy(bytes), ...RESOURCES });
}
export const OPS = pdfjs.OPS;

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
