// EPUB engine, built on epub.js (loaded as a global by index.html).
//
// epub.js concepts worth knowing before you change anything here:
//   rendition  - the paginated view rendered into a container element
//   CFI        - a precise pointer into the text, like
//                "epubcfi(/6/14!/4/2/8,/1:0,/1:23)". Saving one and calling
//                display(cfi) later is the entire bookmark feature.
//   locations  - a generated index of evenly sized chunks. Needed for "43%
//                read", and slow enough on a long book that we cache it.

import { loadSettings, saveSettings, THEMES } from './settings.js';

export async function open(record, container, hooks) {
  const book = ePub(record.file);

  const rendition = book.renderTo(container, {
    width: '100%',
    height: '100%',
    flow: 'paginated',
    spread: 'none',
    allowScriptedContent: false,
  });

  for (const [name, c] of Object.entries(THEMES)) {
    rendition.themes.register(name, {
      body: { background: c.bg, color: c.fg },
      'p, div, span, li, h1, h2, h3, h4': { color: c.fg + ' !important' },
      a: { color: c.fg + ' !important' },
    });
  }

  const settings = loadSettings();
  rendition.themes.select(settings.theme);
  rendition.themes.fontSize(settings.fontSize + '%');

  // Start where we left off; no stored position means page one.
  await rendition.display(record.position || undefined);
  await book.ready;

  // Percentages need the locations index. Restore the cached one when we have
  // it, otherwise build it in the background so the first page isn't delayed.
  if (record.locations) {
    try { book.locations.load(record.locations); } catch { /* rebuilt below */ }
  }
  if (!book.locations.length()) {
    book.locations.generate(1600)
      .then(() => {
        hooks.onLocations?.(book.locations.save());
        report();
      })
      .catch(() => { /* percentages simply stay put */ });
  }

  let position = record.position || null;
  let percent = record.percent || 0;

  function report() {
    hooks.onProgress?.({
      position,
      percent,
      label: `${percent}%`,
      toc: flattenToc(book.navigation?.toc || []),
    });
  }

  rendition.on('relocated', (location) => {
    position = location.start.cfi;
    if (book.locations.length()) {
      const pct = book.locations.percentageFromCfi(position);
      percent = Math.round((pct || 0) * 100);
    }
    report();
  });

  // Keys work whether focus sits on the page or inside the book's iframe.
  const onKey = (e) => {
    // Arrow keys belong to whatever field has focus -- the search box, for one.
    if (e.target?.closest?.('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') rendition.next();
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') rendition.prev();
  };
  document.addEventListener('keydown', onKey);
  rendition.on('keydown', onKey);

  // Swipe, for the tablet. Registered inside each chapter document as it loads,
  // because the text lives in an iframe we do not otherwise touch.
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    let x0 = null, y0 = null;
    doc.addEventListener('touchstart', (e) => {
      x0 = e.changedTouches[0].clientX;
      y0 = e.changedTouches[0].clientY;
    }, { passive: true });
    doc.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
        if (dx < 0) rendition.next(); else rendition.prev();
      }
      x0 = y0 = null;
    }, { passive: true });
  });

  const onResize = debounce(() => { try { rendition.resize(); } catch { /* mid-teardown */ } }, 150);
  window.addEventListener('resize', onResize);

  // ---------------------------------------------------------- highlights
  //
  // epub.js draws these as an SVG overlay above the text, keyed by CFI range,
  // and redraws them itself on every page turn. So we add each one once and
  // otherwise leave it alone.

  // Where on screen is this CFI range right now? Used to place the toolbar.
  // The text lives in an iframe, so the iframe's own offset has to be added.
  function rectFor(cfiRange) {
    try {
      const contents = rendition.getContents()[0];
      if (!contents) return null;
      const range = contents.range(cfiRange);
      if (!range) return null;
      const r = range.getBoundingClientRect();
      const frame = contents.document.defaultView.frameElement?.getBoundingClientRect();
      return {
        top: (frame?.top || 0) + r.top,
        left: (frame?.left || 0) + r.left,
        width: r.width,
        height: r.height,
      };
    } catch {
      return null;
    }
  }

  function draw(highlight) {
    rendition.annotations.add(
      'highlight',
      highlight.cfi,
      {},
      () => hooks.onHighlightClick?.({ cfi: highlight.cfi, rect: rectFor(highlight.cfi) }),
      'hl',
      // These land as attributes on the <g> wrapping the rects, which the
      // rects inherit. fill-opacity is what lets the text show through --
      // mix-blend-mode is CSS-only and silently does nothing here.
      {
        fill: highlight.color,
        'fill-opacity': '0.35',
      },
    );
  }

  for (const highlight of record.highlights || []) {
    try { draw(highlight); } catch { /* a CFI from a different edition of the book */ }
  }

  rendition.on('selected', (cfiRange, contents) => {
    const text = contents.window.getSelection()?.toString().trim() || '';
    if (!text) return;
    hooks.onSelection?.({ cfi: cfiRange, text, rect: rectFor(cfiRange) });
  });

  report();

  return {
    capabilities: { highlights: true, search: true },

    // Walk the spine a section at a time. Each section has to be parsed to be
    // searched, so results are reported in batches as they arrive rather than
    // all at the end -- on a 109-section novel the difference is obvious.
    //
    // The section currently on screen is deliberately left alone: it is
    // already parsed, and unloading it would pull the page out from under the
    // reader.
    async search(query, { signal, onBatch, onProgress, cap = 300 } = {}) {
      const items = book.spine.spineItems;
      const onScreen = rendition.location?.start?.index;
      let found = 0;

      for (let i = 0; i < items.length; i++) {
        if (signal?.aborted || found >= cap) break;
        const item = items[i];
        const alreadyLoaded = i === onScreen || !!item.document;

        try {
          if (!alreadyLoaded) await item.load(book.load.bind(book));
          if (signal?.aborted) break;

          const hits = (item.find(query) || []).map(h => ({
            href: h.cfi,
            excerpt: (h.excerpt || '').replace(/\s+/g, ' ').trim(),
          }));

          if (hits.length) {
            const room = hits.slice(0, cap - found);
            found += room.length;
            onBatch?.(room);
          }
        } catch {
          // A section that will not parse is skipped rather than failing the
          // whole search.
        } finally {
          if (!alreadyLoaded) { try { item.unload(); } catch { /* ignore */ } }
        }
        onProgress?.(i + 1, items.length, found);
      }
      return { total: found, capped: found >= cap };
    },

    addHighlight(highlight) {
      draw(highlight);
      this.clearSelection();
    },

    removeHighlight(cfi) {
      try { rendition.annotations.remove(cfi, 'highlight'); } catch { /* already gone */ }
    },

    clearSelection() {
      try { rendition.getContents()[0]?.window.getSelection().removeAllRanges(); } catch { /* ignore */ }
    },

    next: () => rendition.next(),
    prev: () => rendition.prev(),
    goto: (href) => rendition.display(href),

    setTheme(name) {
      rendition.themes.select(name);
      saveSettings({ theme: name });
      // epub.js does not reliably repaint the current page on a theme change.
      if (position) rendition.display(position);
    },

    // The scale control means text size here, and page zoom in the PDF engine.
    scaleLabel: () => loadSettings().fontSize + '%',
    setScale(delta) {
      const next = clamp(loadSettings().fontSize + delta, 70, 240);
      saveSettings({ fontSize: next });
      rendition.themes.fontSize(next + '%');
      if (position) rendition.display(position);
      return next + '%';
    },

    destroy() {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      try { rendition.destroy(); } catch { /* already gone */ }
      try { book.destroy(); } catch { /* already gone */ }
    },
  };
}

export async function metadata(bytes) {
  const book = ePub(bytes);
  await book.ready;
  const meta = await book.loaded.metadata;

  let cover = null;
  try {
    const url = await book.coverUrl();
    if (url) {
      cover = await (await fetch(url)).blob();
      URL.revokeObjectURL(url);
    }
  } catch { /* plenty of epubs have no cover */ }

  try { book.destroy(); } catch { /* ignore */ }

  return {
    title: (meta.title || '').trim() || null,
    author: (meta.creator || '').trim() || null,
    cover,
  };
}

// epub.js nests the table of contents; the UI wants a flat list with depths.
function flattenToc(items, depth = 0, out = []) {
  for (const item of items) {
    out.push({ label: (item.label || '').trim(), href: item.href, depth });
    if (item.subitems?.length) flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
