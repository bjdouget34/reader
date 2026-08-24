// Library screen, importing, and the reader's chrome.

import { db, fingerprint, usage } from './db.js';
import { openBook, readMetadata, detectFormat, describeFileError } from './reader.js';
import { loadSettings, saveSettings, HIGHLIGHT_COLORS, THEMES } from './settings.js';

const $ = (sel) => document.querySelector(sel);

let session = null;    // the open book's controller, or null
let coverUrls = [];    // blob: URLs to revoke when the library re-renders
let pending = null;    // text selected but not yet highlighted
let editing = null;    // cfi of the highlight the toolbar is acting on
let searching = null;  // AbortController for the search in flight

// ------------------------------------------------------------------ library

async function renderLibrary() {
  const books = await db.all();
  books.sort((a, b) => (b.lastRead || b.added) - (a.lastRead || a.added));

  coverUrls.forEach(URL.revokeObjectURL);
  coverUrls = [];

  const grid = $('#grid');
  grid.textContent = '';
  $('#empty').hidden = books.length > 0;

  for (const book of books) grid.append(bookCard(book));

  const est = await usage();
  $('#usage').textContent = est
    ? `${books.length} book${books.length === 1 ? '' : 's'} · ${mb(est.usage)} stored on this device`
    : '';
}

function bookCard(book) {
  const card = document.createElement('article');
  card.className = 'card';
  card.tabIndex = 0;

  const art = document.createElement('div');
  art.className = 'cover';

  if (book.cover) {
    const url = URL.createObjectURL(book.cover);
    coverUrls.push(url);
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    art.append(img);
  } else {
    art.classList.add('cover-blank');
    art.dataset.letter = (book.title || '?').trim().slice(0, 1).toUpperCase();
  }

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = book.format.toUpperCase();
  art.append(badge);

  const marks = (book.highlights || []).length;
  if (marks) {
    const count = document.createElement('span');
    count.className = 'mark-count';
    count.textContent = `${marks} ✎`;
    count.title = `${marks} highlight${marks === 1 ? '' : 's'}`;
    art.append(count);
  }

  if (book.percent) {
    const bar = document.createElement('div');
    bar.className = 'progress';
    const fill = document.createElement('span');
    fill.style.width = `${book.percent}%`;
    bar.append(fill);
    art.append(bar);
  }

  const title = document.createElement('h3');
  title.textContent = book.title;
  title.title = book.title;   // clamped to 3 lines in CSS, so keep it hoverable
  const author = document.createElement('p');
  author.className = 'author';
  author.textContent = book.author;
  const state = document.createElement('p');
  state.className = 'state';
  state.textContent = book.percent ? `${book.percent}% read` : 'Not started';

  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.title = 'Remove from library';
  remove.setAttribute('aria-label', `Remove ${book.title}`);
  remove.textContent = '×';
  remove.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Remove "${book.title}"?\n\nThe file, your place in it, and any highlights are deleted from this device.`)) return;
    await db.remove(book.id);
    renderLibrary();
  });

  card.append(art, title, author, state, remove);
  card.addEventListener('click', () => openById(book.id));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openById(book.id); }
  });
  return card;
}

// ---------------------------------------------------------------- importing

async function importFiles(fileList) {
  const files = [...fileList];
  const supported = files.filter(f => detectFormat(f.name));

  if (!supported.length) {
    if (files.length) status('Only .epub and .pdf files can be added.');
    return;
  }
  if (supported.length < files.length) {
    status(`Skipped ${files.length - supported.length} file(s) that were not epub or pdf.`);
  }

  for (const file of supported) {
    const format = detectFormat(file.name);
    status(`Reading ${file.name}…`);
    try {
      const bytes = await file.arrayBuffer();
      const id = await fingerprint(bytes);

      if (await db.get(id)) {
        status(`${file.name} is already in your library.`);
        continue;
      }

      const meta = await readMetadata(format, bytes, file.name);
      await db.put({
        id, format, file: bytes,
        title: meta.title, author: meta.author, cover: meta.cover,
        added: Date.now(), lastRead: null,
        position: null, percent: 0, locations: null,
        highlights: [],
      });
      status(`Added ${meta.title}.`);
    } catch (err) {
      // Nothing is stored: a book that cannot be opened has no business on the
      // shelf, where it would sit as an entry that fails every time it is tapped.
      console.error(err);
      status(describeFileError(err, file.name));
    }
  }
  renderLibrary();
}

let statusTimer = null;
function status(message) {
  const el = $('#status');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

// ----------------------------------------------------------------- reading

async function openById(id) {
  const record = await db.get(id);
  if (!record) return;

  show('reader');
  $('#book-title').textContent = record.title;
  $('#progress-label').textContent = '…';
  $('#viewer').textContent = '';
  $('#toc-list').textContent = '';
  $('#marks-list').textContent = '';
  resetSearch();
  hideNote();
  applyNavState({ canGoBack: false });
  // These stay disabled until we know the book actually has something to show.
  $('#toc-open').disabled = true;
  $('#marks-open').disabled = true;
  $('#search-open').disabled = true;
  document.body.dataset.format = record.format;
  hideToolbar();

  let tocBuilt = false;
  try {
    session = await openBook(record, $('#viewer'), {
      onProgress: ({ percent, label, toc }) => {
        $('#progress-label').textContent = label;
        $('#reader-progress').style.width = `${percent}%`;
        if (toc?.length && !tocBuilt) { buildToc(toc); tocBuilt = true; }
      },
      onSelection: ({ cfi, text, rect }) => {
        pending = { cfi, text };
        editing = null;
        showToolbar(rect, { canRemove: false });
      },
      onHighlightClick: ({ cfi, rect }) => {
        pending = null;
        editing = cfi;
        showToolbar(rect, { canRemove: true });
      },
      // Taps inside the book's iframe never reach this document, so the engine
      // has to tell us when the selection went away.
      onDismiss: hideToolbar,
      onHighlights: renderMarks,
      onNote: showNote,
      onNavState: applyNavState,
    });
    $('#scale-label').textContent = session.scaleLabel();
    $('#marks-open').disabled = !session.capabilities.highlights;
    $('#marks-open').title = session.capabilities.highlights
      ? 'Highlights'
      : 'Highlighting is epub-only for now';
    $('#search-open').disabled = !session.capabilities.search;
    renderMarks(session.highlights());
  } catch (err) {
    console.error(err);
    status(err?.message?.includes('too long')
      ? err.message
      : describeFileError(err, record.title));
    closeBook();
  }
}

function buildToc(items) {
  const list = $('#toc-list');
  list.textContent = '';
  for (const item of items) {
    if (!item.label) continue;
    const btn = document.createElement('button');
    btn.textContent = item.label;
    btn.style.paddingLeft = `${14 + item.depth * 16}px`;
    btn.addEventListener('click', () => {
      session?.goto(item.href);
      closeDrawers();
    });
    list.append(btn);
  }
  $('#toc-open').disabled = list.childElementCount === 0;
}

function closeBook() {
  session?.close();
  session = null;
  closeDrawers();
  hideToolbar();
  hideNote();
  applyNavState({ canGoBack: false });
  $('#viewer').textContent = '';
  show('library');
  renderLibrary();
}

function show(name) {
  $('#library-view').hidden = name !== 'library';
  $('#reader-view').hidden = name !== 'reader';
  document.body.dataset.view = name;
}

// -------------------------------------------------------------- highlights

function renderMarks(highlights = []) {
  const list = $('#marks-list');
  list.textContent = '';

  if (!highlights.length) {
    const none = document.createElement('p');
    none.className = 'drawer-empty';
    none.textContent = 'Select some text to highlight it. Your highlights appear here.';
    list.append(none);
    return;
  }

  // Newest first: the thing you just marked is the thing you want.
  for (const h of [...highlights].sort((a, b) => b.created - a.created)) {
    const row = document.createElement('div');
    row.className = 'mark';

    const jump = document.createElement('button');
    jump.className = 'mark-jump';
    jump.title = 'Go to this highlight';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = h.color;
    const quote = document.createElement('span');
    quote.className = 'mark-text';
    quote.textContent = h.text.length > 180 ? h.text.slice(0, 180) + '…' : h.text;
    jump.append(swatch, quote);
    jump.addEventListener('click', () => {
      session?.goto(h.cfi);
      closeDrawers();
    });

    const del = document.createElement('button');
    del.className = 'mark-remove';
    del.title = 'Delete highlight';
    del.setAttribute('aria-label', 'Delete highlight');
    del.textContent = '×';
    del.addEventListener('click', () => session?.removeHighlight(h.cfi));

    row.append(jump, del);
    list.append(row);
  }
}

function buildSwatches() {
  const holder = $('#hl-colors');
  holder.textContent = '';
  for (const color of HIGHLIGHT_COLORS) {
    const btn = document.createElement('button');
    btn.className = 'hl-swatch';
    btn.style.background = color.value;
    btn.title = color.name;
    btn.setAttribute('aria-label', `Highlight ${color.name}`);
    btn.addEventListener('click', async () => {
      if (editing) await session?.recolorHighlight(editing, color.value);
      else if (pending) await session?.addHighlight(pending.cfi, pending.text, color.value);
      hideToolbar();
    });
    holder.append(btn);
  }
}

function showToolbar(rect, { canRemove }) {
  const bar = $('#hl-toolbar');
  $('#hl-remove').hidden = !canRemove;
  bar.hidden = false;

  // On a touch screen the platform puts its own Copy / Share / Select all menu
  // right beside the selection and wins any fight for that space. Dock ours to
  // the bottom of the screen instead, where nothing else is competing.
  if (window.matchMedia('(pointer: coarse)').matches) {
    bar.classList.add('docked');
    bar.style.top = '';
    bar.style.left = '';
    return;
  }
  bar.classList.remove('docked');

  // Sit above the selection, or below it when there is no room up there.
  const box = bar.getBoundingClientRect();
  const margin = 8;
  let top = (rect?.top ?? 80) - box.height - margin;
  if (top < margin) top = (rect?.top ?? 0) + (rect?.height ?? 0) + margin;

  const centre = (rect?.left ?? 0) + (rect?.width ?? 0) / 2;
  let left = centre - box.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));

  bar.style.top = `${top}px`;
  bar.style.left = `${left}px`;
}

function hideToolbar() {
  $('#hl-toolbar').hidden = true;
  pending = null;
  editing = null;
}

// ------------------------------------------------------------------- search

function resetSearch() {
  searching?.abort();
  searching = null;
  $('#search-results').textContent = '';
  $('#search-status').textContent = '';
  $('#search-input').value = '';
}

async function runSearch(query) {
  const term = query.trim();
  const results = $('#search-results');
  const statusLine = $('#search-status');

  // Abort whatever was still scanning; one search at a time.
  searching?.abort();
  results.textContent = '';

  if (term.length < 2) {
    statusLine.textContent = 'Type at least two characters.';
    return;
  }
  if (!session) return;

  const controller = new AbortController();
  searching = controller;
  statusLine.textContent = 'Searching…';

  let count = 0;
  const outcome = await session.search(term, {
    signal: controller.signal,
    onBatch: (hits) => {
      if (controller.signal.aborted) return;
      count += hits.length;
      for (const hit of hits) results.append(resultRow(hit, term));
    },
    onProgress: (done, total) => {
      if (controller.signal.aborted) return;
      const pct = Math.round((done / total) * 100);
      statusLine.textContent = pct < 100
        ? `Searching… ${pct}% · ${count} found`
        : `${count} result${count === 1 ? '' : 's'}`;
    },
  }).catch((err) => {
    console.error(err);
    statusLine.textContent = 'Search failed.';
    return null;
  });

  if (controller.signal.aborted || !outcome) return;
  searching = null;

  statusLine.textContent = count === 0
    ? `No matches for “${term}”.`
    : outcome.capped
      ? `First ${count} matches — there are more. Try a longer phrase.`
      : `${count} result${count === 1 ? '' : 's'}`;

  // A PDF of page scans has no text at all, which is worth saying plainly
  // rather than leaving the reader wondering.
  if (count === 0 && document.body.dataset.format === 'pdf') {
    const note = document.createElement('p');
    note.className = 'drawer-empty';
    note.textContent = 'If this PDF is a scan, it holds page images rather than text, so there is nothing to search.';
    results.append(note);
  }
}

function resultRow(hit, term) {
  const btn = document.createElement('button');
  btn.className = 'result';

  if (hit.page) {
    const where = document.createElement('span');
    where.className = 'result-where';
    where.textContent = `p. ${hit.page}`;
    btn.append(where);
  }

  // Bold the matched run inside the excerpt so the eye lands on it.
  const quote = document.createElement('span');
  quote.className = 'result-text';
  const at = hit.excerpt.toLowerCase().indexOf(term.toLowerCase());
  if (at === -1) {
    quote.textContent = hit.excerpt;
  } else {
    quote.append(
      document.createTextNode(hit.excerpt.slice(0, at)),
      Object.assign(document.createElement('mark'), { textContent: hit.excerpt.slice(at, at + term.length) }),
      document.createTextNode(hit.excerpt.slice(at + term.length)),
    );
  }
  btn.append(quote);

  btn.addEventListener('click', () => {
    session?.goto(hit.href);
    closeDrawers();
  });
  return btn;
}

// ------------------------------------------------------------- footnotes

function showNote({ html, truncated, target }) {
  hideToolbar();                     // both of these live at the foot of the screen
  $('#note-body').innerHTML = html;  // already stripped to inline tags by the engine
  $('#note-open').hidden = !truncated;
  $('#note-open').dataset.target = target || '';
  $('#note').hidden = false;
}

function hideNote() {
  $('#note').hidden = true;
  $('#note-body').textContent = '';
}

function applyNavState({ canGoBack, label }) {
  const btn = $('#nav-back');
  btn.hidden = !canGoBack;
  btn.textContent = label ? '\u2039 Back to ' + label : '\u2039 Back';
}

// ------------------------------------------------------------------ drawers

function closeDrawers() {
  $('#toc').hidden = true;
  $('#marks').hidden = true;
  $('#search').hidden = true;
  // No point scanning 400 pages for a panel nobody is looking at.
  searching?.abort();
  searching = null;
}

function toggleDrawer(id) {
  const target = $(`#${id}`);
  const wasOpen = !target.hidden;
  closeDrawers();
  target.hidden = wasOpen;
  hideToolbar();
  if (id === 'search' && !target.hidden) $('#search-input').focus();
}

function buildThemePicker() {
  const picker = $('#theme');
  picker.textContent = '';
  for (const [key, theme] of Object.entries(THEMES)) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = theme.label;
    picker.append(option);
  }
}

function applyTheme() {
  const { theme } = loadSettings();
  const known = THEMES[theme] ? theme : 'light';
  document.body.dataset.theme = known;
  $('#theme').value = known;
}

// The toolbar collapses so a page of text can have the whole screen. The
// choice sticks, because someone who wants it out of the way wants it to
// stay out of the way.
function applyChrome() {
  const hidden = !!loadSettings().chromeHidden;
  document.body.dataset.chrome = hidden ? 'hidden' : 'shown';
  $('#chrome-show').hidden = !hidden;
}

function setChromeHidden(hidden) {
  saveSettings({ chromeHidden: hidden });
  applyChrome();
}

function mb(bytes) {
  if (!bytes) return '0 MB';
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ------------------------------------------------------------------ wiring

$('#add').addEventListener('click', () => $('#file').click());
$('#add-empty').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => {
  importFiles(e.target.files);
  e.target.value = '';
});

// Drag and drop, for the desktop.
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (!session) document.body.classList.add('dropping');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dropping');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  if (!session) importFiles(e.dataTransfer.files);
});

$('#back').addEventListener('click', closeBook);

for (const [id, move] of [['#prev', 'prev'], ['#next', 'next'], ['#tap-prev', 'prev'], ['#tap-next', 'next']]) {
  $(id).addEventListener('click', () => {
    hideToolbar();          // the selection it referred to is off screen now
    hideNote();             // as is the sentence the note belonged to
    session?.[move]();
  });
}

$('#toc-open').addEventListener('click', () => toggleDrawer('toc'));
$('#marks-open').addEventListener('click', () => toggleDrawer('marks'));
$('#search-open').addEventListener('click', () => toggleDrawer('search'));

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch($('#search-input').value);
});
for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', closeDrawers);
}

$('#note-close').addEventListener('click', hideNote);
$('#note-open').addEventListener('click', () => {
  const target = $('#note-open').dataset.target;
  hideNote();
  if (target) session?.openTarget?.(target);
});
$('#nav-back').addEventListener('click', () => {
  hideNote();
  session?.back?.();   // pdf sessions have no link history
});

$('#hl-remove').addEventListener('click', async () => {
  if (editing) await session?.removeHighlight(editing);
  hideToolbar();
});

$('#smaller').addEventListener('click', () => {
  if (session) { $('#scale-label').textContent = session.setScale(-10); hideToolbar(); }
});
$('#bigger').addEventListener('click', () => {
  if (session) { $('#scale-label').textContent = session.setScale(+10); hideToolbar(); }
});

$('#theme').addEventListener('change', (e) => {
  const name = e.target.value;
  if (session) session.setTheme(name); else saveSettings({ theme: name });
  applyTheme();
});

$('#chrome-hide').addEventListener('click', () => setChromeHidden(true));
$('#chrome-show').addEventListener('click', () => setChromeHidden(false));

document.addEventListener('keydown', (e) => {
  // The browser's own find cannot see inside the book's iframe or past the
  // current PDF page, so take the shortcut over while a book is open.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && session
      && !$('#search-open').disabled) {
    e.preventDefault();
    if ($('#search').hidden) toggleDrawer('search');
    $('#search-input').select();
    return;
  }

  if (e.key !== 'Escape') return;
  if (!$('#note').hidden) hideNote();
  else if (!$('#hl-toolbar').hidden) hideToolbar();
  else if (!$('#toc').hidden || !$('#marks').hidden || !$('#search').hidden) closeDrawers();
  else if (session) closeBook();
});

// A click anywhere outside the toolbar dismisses it. The book's text lives in
// an iframe, so a click in there does not bubble here -- the engine's own
// selection handler covers that case.
document.addEventListener('pointerdown', (e) => {
  if (!$('#hl-toolbar').hidden && !e.target.closest('#hl-toolbar')) hideToolbar();
});

// -------------------------------------------------------------------- start

buildSwatches();
buildThemePicker();
applyTheme();
applyChrome();
show('library');
renderLibrary();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .catch(err => console.warn('offline caching unavailable', err));
}
