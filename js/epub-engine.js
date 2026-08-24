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

    // gap: 0 is load-bearing. Left to itself epub.js sets the CSS column width
    // to the full page width and then adds a gap of roughly width/12 on top,
    // so the columns repeat every (page + 64)px while it scrolls by exactly one
    // page. Every turn drifts by that gap: you get a blank strip down one side
    // and the far edge of the text cut off, until something forces a relayout.
    // With no gap the column step is exactly one page. Nothing is lost --
    // only one column is ever on screen, so an inter-column gutter is invisible.
    gap: 0,
  });

  for (const [name, c] of Object.entries(THEMES)) {
    rendition.themes.register(name, {
      body: { background: c.bg, color: c.fg },
      'p, div, span, li, h1, h2, h3, h4': { color: c.fg + ' !important' },
      a: { color: c.fg + ' !important' },
      img: { 'max-width': '100%' },
    });
  }

  const settings = loadSettings();
  rendition.themes.select(settings.theme);
  rendition.themes.fontSize(settings.fontSize + '%');

  // ------------------------------------------------ touch, keys and links
  //
  // All of this is set up before the first display() call, deliberately.
  // epub.js runs content hooks as each section loads, so a hook registered
  // afterwards never runs for the section already on screen -- which once left
  // the opening chapter of every book with no touch handling at all.

  // How long a touch must be held before it counts as "I am selecting text".
  // Anything shorter is a page tap, and whatever the browser selected along
  // the way gets thrown away.
  const LONG_PRESS_MS = 350;

  // Selection events are only honoured once a deliberate press has armed them.
  // This is what stops a plain tap from popping the highlight bar, and it stays
  // armed while the selection handles are dragged around.
  let selectionArmed = false;

  function clearSelection() {
    try { rendition.getContents()[0]?.window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
  }

  // Always drop the selection before paginating. In paginated mode epub.js
  // moves between pages by setting the container's scrollLeft, and a live
  // selection makes the browser scroll to keep it on screen -- which lands
  // between two columns and shows as a gap down one side of the page.
  function turn(direction) {
    clearSelection();
    selectionArmed = false;
    return direction === 'next' ? rendition.next() : rendition.prev();
  }

  // Touch and selection handling, registered inside each chapter document as it
  // loads, because the text lives in an iframe we do not otherwise touch.
  rendition.hooks.content.register((contents) => {
    const doc = contents.document;
    let x0 = null, y0 = null, pressedAt = 0, pressedWith = 'mouse', pointerIsDown = false;

    doc.addEventListener('pointerdown', (e) => {
      pointerIsDown = true;
      pressedAt = Date.now();
      pressedWith = e.pointerType || 'mouse';
      // Anything already on screen refers to the previous selection.
      hooks.onDismiss?.();
    }, { passive: true });

    doc.addEventListener('pointerup', () => {
      pointerIsDown = false;
      const heldMs = Date.now() - pressedAt;
      // A mouse drag is explicit enough on its own; touch has to be held.
      // This stays set until the next pointerdown, so the brief empty selection
      // the platform emits while it builds a long-press selection cannot
      // disarm it on the way through.
      selectionArmed = pressedWith !== 'touch' || heldMs >= LONG_PRESS_MS;
    }, { passive: true });

    // Selection changes never reach the parent document, so both the dismissal
    // and the tap cleanup have to be handled in here.
    doc.addEventListener('selectionchange', () => {
      const text = contents.window.getSelection()?.toString().trim();

      // Collapsed to nothing -- whatever the toolbar referred to is gone.
      if (!text) { hooks.onDismiss?.(); return; }

      // A finger tap that the platform turned into a word selection anyway.
      // Undo it: an unwanted selection is what drags the page out of alignment
      // on the next turn. Only ever applies to touch, and only once the finger
      // is up, so a mouse drag-select is never interfered with.
      if (!selectionArmed && !pointerIsDown && pressedWith === 'touch') {
        clearSelection();
      }
    });

    // Footnote and endnote links. Caught in the capture phase because epub.js
    // installs its own onclick on every internal link, and it would navigate
    // away before we got the chance to show the note in place.
    doc.addEventListener('click', (e) => {
      const el = e.target?.nodeType === 1 ? e.target : e.target?.parentElement;
      const anchor = el?.closest?.('a[href]');
      if (!anchor) return;

      const raw = anchor.getAttribute('href') || '';
      // Leave anything off-book to the browser.
      if (/^(https?:|mailto:|tel:)/i.test(raw)) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      followLink(raw);
    }, true);

    doc.addEventListener('touchstart', (e) => {
      x0 = e.changedTouches[0].clientX;
      y0 = e.changedTouches[0].clientY;
    }, { passive: true });

    doc.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      const dy = e.changedTouches[0].clientY - y0;
      // A swipe is a drag, not a press, so it must not count as page-tap either.
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) {
        selectionArmed = false;
        turn(dx < 0 ? 'next' : 'prev');
      }
      x0 = y0 = null;
    }, { passive: true });
  });


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
    if (e.key === 'ArrowRight' || e.key === 'PageDown') turn('next');
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') turn('prev');
  };
  document.addEventListener('keydown', onKey);
  rendition.on('keydown', onKey);

  const onResize = debounce(() => { try { rendition.resize(); } catch { /* mid-teardown */ } }, 150);
  window.addEventListener('resize', onResize);

  // Collapsing the toolbar changes the height of the box we render into
  // without the window itself resizing, and epub.js only re-measures when it
  // is told to. Left unwatched, the iframe kept the height it was built with
  // while the stage around it grew or shrank, leaving a band of bare container
  // down one edge. Watching the element catches the toolbar, rotation, and the
  // on-screen keyboard alike. It is our own element, sized purely by CSS, so
  // resizing the book inside it cannot feed back into this.
  const boxObserver = new ResizeObserver(onResize);
  boxObserver.observe(container);

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
    // A quick tap is a page tap, never a highlight gesture.
    if (!selectionArmed) return;
    const text = contents.window.getSelection()?.toString().trim() || '';
    if (!text) return;
    hooks.onSelection?.({ cfi: cfiRange, text, rect: rectFor(cfiRange) });
  });

  // ------------------------------------------------------- notes and links
  //
  // Both sample books mark notes up the same way: an <a> pointing at a
  // separate notes file plus a fragment, with that fragment id sitting on an
  // empty <a> inside the note's own paragraph. Resolving a note therefore
  // means finding the id and walking up to the block that actually holds text.
  //
  // Short notes are shown in place at the foot of the page. Anything longer
  // opens as a page, and the back stack is what makes that reversible.

  const NOTE_MAX_CHARS = 700;
  const backStack = [];

  function reportNav() {
    hooks.onNavState?.({
      canGoBack: backStack.length > 0,
      label: backStack.length ? backStack[backStack.length - 1].label : null,
    });
  }

  // An href inside a chapter is relative to that chapter; the spine is keyed
  // relative to the package file. Resolve one against the other.
  function bookRelative(rawPath, fromHref) {
    if (!rawPath) return fromHref;
    try {
      const url = new URL(rawPath, new URL(fromHref || '', 'http://book.local/'));
      return decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch {
      return rawPath;
    }
  }

  async function lookupNote(rawPath, hash) {
    const fromHref = rendition.location?.start?.href || '';
    const path = bookRelative(rawPath, fromHref);
    const target = hash ? `${path}#${hash}` : path;

    const section = book.spine.get(path);
    if (!section) return { target };

    // Never unload the section on screen -- that would blank the page.
    const wasLoaded = !!section.document;
    try {
      if (!wasLoaded) await section.load(book.load.bind(book));
      const doc = section.document;
      if (!doc) return { target };

      let el = null;
      try { el = doc.getElementById(hash) || doc.querySelector(`a[name="${CSS.escape(hash)}"]`); } catch { /* odd id */ }
      if (!el) return { target };

      // The id is usually on an empty anchor; climb to the block with the text.
      let block = el;
      while (block.parentElement && block.parentElement !== doc.body
             && (block.textContent || '').trim().length < 2) {
        block = block.parentElement;
      }

      const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return { target };

      return {
        target,
        text,
        html: sanitizeNote(block, NOTE_MAX_CHARS),
        truncated: text.length > NOTE_MAX_CHARS,
      };
    } finally {
      if (!wasLoaded) { try { section.unload(); } catch { /* ignore */ } }
    }
  }

  async function followLink(raw) {
    const [rawPath, hash] = String(raw).split('#');
    let resolved = null;
    try {
      resolved = await lookupNote(rawPath, hash);
    } catch (err) {
      console.warn('could not resolve link', raw, err);
    }

    // A short note reads better where you are than on a page of its own.
    if (resolved?.text) {
      hooks.onNote?.({
        html: resolved.html,
        truncated: resolved.truncated,
        target: resolved.target,
      });
      return;
    }
    goTarget(resolved?.target || raw);
  }

  // Navigate, remembering where we came from so there is a way back.
  // Only label the back button with a position we can actually vouch for. The
  // percentage comes from the locations index, which is still being built for
  // the first few seconds of a long book -- quoting a stale 0% there is worse
  // than saying nothing.
  function positionLabel() {
    if (!position || !book.locations.length()) return null;
    const pct = book.locations.percentageFromCfi(position);
    return Number.isFinite(pct) ? `${Math.round(pct * 100)}%` : null;
  }

  async function goTarget(target) {
    backStack.push({ cfi: position, label: positionLabel() });
    reportNav();
    try { await rendition.display(target); } catch (err) { console.warn('could not open', target, err); }
  }

  async function goBack() {
    const previous = backStack.pop();
    reportNav();
    if (previous?.cfi) {
      try { await rendition.display(previous.cfi); } catch { /* ignore */ }
    }
  }

  reportNav();
  report();

  return {
    capabilities: { highlights: true, search: true, notes: true },

    back: goBack,
    openTarget: goTarget,

    // Belt and braces beside the ResizeObserver: something that changes the
    // size of the reading area can say so outright.
    relayout() { try { rendition.resize(); } catch { /* mid-teardown */ } },

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
      clearSelection();
    },

    removeHighlight(cfi) {
      try { rendition.annotations.remove(cfi, 'highlight'); } catch { /* already gone */ }
    },

    clearSelection,

    next: () => turn('next'),
    prev: () => turn('prev'),
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
      boxObserver.disconnect();
      try { rendition.destroy(); } catch { /* already gone */ }
      try { book.destroy(); } catch { /* already gone */ }
    },
  };
}

export async function metadata(bytes) {
  const book = ePub(bytes);
  await book.ready;   // the gate: throws when this is not a readable epub

  let meta = {};
  try { meta = await book.loaded.metadata; } catch { /* an odd OPF, not a dealbreaker */ }

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

// Notes come out of the book's own markup, so keep the inline formatting that
// makes them readable and drop everything else -- no scripts, no styles, no
// attributes, and links flattened to plain text since they lead back into the
// chapter we are already standing in.
const NOTE_KEEP = new Set(['EM', 'I', 'STRONG', 'B', 'SUP', 'SUB', 'SMALL', 'SPAN', 'BR', 'CITE', 'Q']);

function sanitizeNote(block, maxChars) {
  const clean = block.ownerDocument.createElement('div');

  const copy = (from, to) => {
    for (const node of from.childNodes) {
      if (node.nodeType === 3) {
        to.appendChild(clean.ownerDocument.createTextNode(node.nodeValue));
      } else if (node.nodeType === 1) {
        // Sections are parsed as XHTML, so tagName comes back lowercase here
        // and uppercase in an HTML document. Normalise before comparing.
        if (NOTE_KEEP.has(node.tagName.toUpperCase())) {
          const el = clean.ownerDocument.createElement(node.tagName.toLowerCase());
          copy(node, el);
          to.appendChild(el);
        } else {
          // Unwrap: keep the words, discard the element. Anchors land here on
          // purpose -- a note's own back-link is dead weight in a strip that
          // already sits on the page it came from.
          copy(node, to);
        }
      }
    }
  };
  copy(block, clean);

  let html = clean.innerHTML;
  if ((clean.textContent || '').length > maxChars) {
    // Trim on the text, then let the browser close any tags we cut through.
    const holder = clean.ownerDocument.createElement('div');
    holder.textContent = (clean.textContent || '').slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
    html = holder.innerHTML;
  }
  return html;
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
