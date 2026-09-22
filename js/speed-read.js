// Speed reading: one word at a time, in one place.
//
// Rapid serial visual presentation. The eye stays still and the words come to
// it, which is where the speed comes from. Each word is centred on a pivot
// letter a little left of its middle -- roughly where the eye lands on a word
// anyway -- so the reader's gaze has one fixed point to rest on.
//
// This module owns the screen, the timing and the controls. It knows nothing
// about either format: an engine hands it a *source* --
//
//   first, last          the range of chunk numbers (epub sections, pdf pages)
//   start()              { c, i, chunk } -- where the reader is now, or null
//   load(c)              { words: [{ t, para, ...ref }] } for chunk c
//   label(c, word)       { text, timeLeft, percent } for the readout
//   goTo(word)           move the book to that word
//
// -- and everything here works in words and chunks. A word carries whatever the
// engine needs to find it again (a text node for an epub, a page and a height
// for a pdf); this module never looks inside that.
//
// The honest limit, stated where it applies: comprehension falls as speed
// rises, mostly because a reader can no longer glance back. The paused view
// shows the whole sentence and the back button re-reads it, which is the
// nearest thing to a glance this mode can offer.

import { loadSettings, saveSettings } from './settings.js';

const $ = (sel) => document.querySelector(sel);

const MIN_WPM = 100;
const MAX_WPM = 1000;

// A sentence end is a natural checkpoint, so the book underneath is moved to
// the current word at the first one after this long -- enough that a tablet
// switched off mid-chapter comes back close to where it stopped, without a
// re-render every few seconds of reading.
const SYNC_EVERY_MS = 45000;

// Starting from a standstill at full speed is a jolt, so the first few words
// after Play are held a little longer.
const RAMP = [1.8, 1.5, 1.25, 1.1];

// However many empty chunks in a row to step over before giving up -- image
// pages in a pdf, a cover section in an epub. A scanned pdf is all empty
// chunks, and this is what stops a search through 446 of them.
const MAX_EMPTY_RUN = 25;

// Common abbreviations whose full stop does not end a sentence.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'mt', 'no', 'vol',
  'fig', 'p', 'pp', 'cf', 'co', 'inc', 'ltd', 'gen', 'col', 'capt', 'lt',
  'sgt', 'rev', 'prof', 'hon', 'messrs', 'esq', 'ft', 'approx', 'dept',
]);

// Which kind of pause a word earns, read off its own punctuation.
export function pauseOf(t) {
  const end = /([.!?…]+)["'”’)\]]*$/.exec(t);
  if (end) {
    const bare = t.replace(/["'“”‘’()[\]]/g, '').replace(/[.!?…]+$/, '').toLowerCase();
    if (end[1] === '.') {
      // "Mr." and "J." and "U.S." are not the end of anything.
      if (ABBREVIATIONS.has(bare) || /^\p{L}$/u.test(bare) || bare.includes('.')) return null;
    }
    return 'sentence';
  }
  if (/[,;:]["'”’)\]]*$/.test(t) || /[—–]$/.test(t)) return 'clause';
  return null;
}

// The pivot sits on a letter, not on punctuation around the word, and moves
// right as words get longer -- the fixation point a reader's eye favours.
export function splitAtPivot(t) {
  const chars = Array.from(t);
  let lead = 0;
  while (lead < chars.length && !/[\p{L}\p{N}]/u.test(chars[lead])) lead++;
  let tail = chars.length;
  while (tail > lead && !/[\p{L}\p{N}]/u.test(chars[tail - 1])) tail--;
  const n = tail - lead;
  const k = n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4;
  const at = n > 0 ? lead + k : Math.floor((chars.length - 1) / 2);
  return {
    pre: chars.slice(0, at).join(''),
    pivot: chars[at] || '',
    post: chars.slice(at + 1).join(''),
  };
}

// How long a word stays up. Longer words and numbers need longer to take in,
// and punctuation is where a reader would pause anyway.
export function delayFor(word, wpm) {
  const base = 60000 / wpm;
  const core = word.t.replace(/[^\p{L}\p{N}]/gu, '');
  let k = 1;
  if (core.length > 7) k += Math.min(0.9, (core.length - 7) * 0.1);
  if (/\p{N}/u.test(core)) k += 0.3;
  if (word.pause === 'clause') k += 0.7;
  else if (word.pause === 'sentence') k += 1.3;
  else if (word.pause === 'para') k += 2.0;
  return base * k;
}

const isBoundary = (w) => w?.pause === 'sentence' || w?.pause === 'para';
const same = (a, b) => a && b && a.c === b.c && a.i === b.i;

let active = null;

export function isSpeedReading() { return !!active; }

export async function openSpeedRead(session, { onClose } = {}) {
  if (active || !session?.speedSource) return;

  const root = $('#rsvp');
  const preEl = $('#rsvp-pre');
  const pivotEl = $('#rsvp-pivot');
  const postEl = $('#rsvp-post');
  const contextEl = $('#rsvp-context');
  const hintEl = $('#rsvp-hint');
  const whereEl = $('#rsvp-where');
  const playBtn = $('#rsvp-play');
  const wpmEl = $('#rsvp-wpm');

  const state = {
    source: null,
    chunks: new Map(),     // c -> Promise<{ words }>
    ready: new Map(),      // c -> { words }, once loaded
    pos: null,
    playing: false,
    ended: false,
    timer: 0,
    ramp: 0,
    lastSync: Date.now(),
    wakeLock: null,
    contextToken: 0,
    wpm: clamp(loadSettings().speedWpm || 300, MIN_WPM, MAX_WPM),
  };
  active = state;

  root.hidden = false;
  document.body.classList.add('speed-reading');
  root.focus({ preventScroll: true });
  setWord({ t: '' });
  contextEl.textContent = '';
  hintEl.textContent = 'Finding your place…';
  whereEl.textContent = '';
  wpmEl.textContent = `${state.wpm} wpm`;
  playBtn.textContent = 'Play';
  playBtn.disabled = true;

  // ------------------------------------------------------------- chunks

  function prepare(chunk) {
    const words = chunk?.words || [];
    for (const w of words) w.pause = w.para ? 'para' : pauseOf(w.t);
    return { ...chunk, words };
  }

  function chunk(c) {
    const src = state.source;
    if (c < src.first || c > src.last) return Promise.resolve(null);
    if (!state.chunks.has(c)) {
      const p = Promise.resolve(src.load(c))
        .catch(() => ({ words: [] }))
        .then((raw) => { const ch = prepare(raw); state.ready.set(c, ch); return ch; });
      state.chunks.set(c, p);
    }
    return state.chunks.get(c);
  }

  function seed(c, raw) {
    const ch = prepare(raw);
    state.ready.set(c, ch);
    state.chunks.set(c, Promise.resolve(ch));
  }

  // Chunks well behind or ahead of the reader are let go; a novel's worth of
  // parsed sections would otherwise pile up over an evening.
  function evict() {
    for (const c of [...state.chunks.keys()]) {
      if (Math.abs(c - state.pos.c) > 4) { state.chunks.delete(c); state.ready.delete(c); }
    }
  }

  const wordAt = (p) => state.ready.get(p.c)?.words[p.i];

  async function forward(p) {
    const ch = await chunk(p.c);
    if (ch && p.i + 1 < ch.words.length) return { c: p.c, i: p.i + 1 };
    for (let c = p.c + 1, run = 0; c <= state.source.last && run < MAX_EMPTY_RUN; c++, run++) {
      const next = await chunk(c);
      if (next?.words.length) return { c, i: 0 };
    }
    return null;
  }

  async function backward(p) {
    if (p.i > 0) return { c: p.c, i: p.i - 1 };
    for (let c = p.c - 1, run = 0; c >= state.source.first && run < MAX_EMPTY_RUN; c--, run++) {
      const prev = await chunk(c);
      if (prev?.words.length) return { c, i: prev.words.length - 1 };
    }
    return null;
  }

  // Walks back to the first word of the sentence p is in, and says how far that
  // was -- the back button needs to know whether it is already at the start.
  async function sentenceStart(p) {
    let at = p, steps = 0;
    for (; steps < 400; steps++) {
      const prev = await backward(at);
      if (!prev || isBoundary(wordAt(prev))) break;
      at = prev;
    }
    return { at, steps };
  }

  // ------------------------------------------------------------ display

  function setWord(w) {
    const { pre, pivot, post } = splitAtPivot(w.t || '');
    preEl.textContent = pre;
    pivotEl.textContent = pivot;
    postEl.textContent = post;
  }

  // The readout is asked for afresh only every few dozen words, or when the
  // reader jumps: working out a percentage means building a position for the
  // word, and it would be pointless work five times a second.
  let lastWhere = '';
  let labelAt = null;
  let label = {};
  function updateWhere(force = false) {
    const p = state.pos;
    if (force || !labelAt || labelAt.c !== p.c || Math.abs(labelAt.i - p.i) >= 40) {
      label = state.source.label(p.c, wordAt(p)) || {};
      labelAt = { ...p };
    }
    const ch = state.ready.get(p.c);
    const parts = [];
    if (label.text) parts.push(label.text);
    if (label.timeLeft && ch) {
      const minutes = (ch.words.length - p.i) / state.wpm;
      parts.push(minutes < 1 ? 'under a minute left in chapter' : `${Math.ceil(minutes)} min left in chapter`);
    }
    if (Number.isFinite(label.percent)) parts.push(`${label.percent}%`);
    const text = parts.join(' · ');
    if (text !== lastWhere) { whereEl.textContent = text; lastWhere = text; }
  }

  // The sentence around the current word, shown while paused, so a reader can
  // see what they just took in and where the word sits in it.
  async function renderContext() {
    const token = ++state.contextToken;
    const { at } = await sentenceStart(state.pos);
    const words = [];
    let p = at;
    for (let n = 0; p && n < 90; n++) {
      const w = wordAt(p);
      if (!w) break;
      words.push({ t: w.t, current: same(p, state.pos) });
      const pastCurrent = p.c > state.pos.c || (p.c === state.pos.c && p.i >= state.pos.i);
      if (isBoundary(w) && pastCurrent) break;
      p = await forward(p);
    }
    if (token !== state.contextToken || state.playing) return;
    contextEl.replaceChildren();
    words.forEach(({ t, current }, k) => {
      if (k) contextEl.append(' ');
      if (current) {
        const mark = document.createElement('mark');
        mark.textContent = t;
        contextEl.append(mark);
      } else {
        contextEl.append(t);
      }
    });
  }

  function showCurrent() {
    const w = wordAt(state.pos);
    if (w) setWord(w);
    updateWhere(true);
  }

  // ---------------------------------------------------------- playing

  async function holdScreen() {
    // Nobody touches the screen while reading like this, so without a wake
    // lock it dims and locks mid-sentence.
    try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not offered */ }
  }

  function releaseScreen() {
    try { state.wakeLock?.release(); } catch { /* ignore */ }
    state.wakeLock = null;
  }

  function schedule() {
    clearTimeout(state.timer);
    if (!state.playing) return;
    const w = wordAt(state.pos);
    if (!w) { pause(); return; }
    setWord(w);
    updateWhere();

    const ramp = RAMP[state.ramp] ?? 1;
    state.ramp++;

    // Load the next chunk before it is needed, so a section boundary does not
    // stall on a parse in the middle of a sentence.
    const ch = state.ready.get(state.pos.c);
    if (ch && ch.words.length - state.pos.i < 80) chunk(state.pos.c + 1);

    state.timer = setTimeout(async () => {
      if (!state.playing) return;
      const next = await forward(state.pos);
      if (!state.playing) return;
      if (!next) { finish(); return; }
      state.pos = next;
      evict();
      if (isBoundary(w) && Date.now() - state.lastSync > SYNC_EVERY_MS) sync();
      schedule();
    }, delayFor(w, state.wpm) * ramp);
  }

  function play() {
    if (state.playing || !state.pos) return;
    if (state.ended) return;
    state.playing = true;
    state.ramp = 0;
    contextEl.replaceChildren();
    hintEl.textContent = 'Tap to pause';
    playBtn.textContent = 'Pause';
    holdScreen();
    schedule();
  }

  function pause({ quiet = false } = {}) {
    if (!state.playing) return;
    state.playing = false;
    clearTimeout(state.timer);
    releaseScreen();
    playBtn.textContent = 'Play';
    hintEl.textContent = 'Paused. Tap to carry on';
    renderContext();
    if (!quiet) sync();
  }

  function finish() {
    state.playing = false;
    state.ended = true;
    clearTimeout(state.timer);
    releaseScreen();
    playBtn.textContent = 'Play';
    playBtn.disabled = true;
    hintEl.textContent = 'That is the end of the text.';
    renderContext();
    sync();
  }

  const toggle = () => (state.playing ? pause() : play());

  // Moves the book underneath to the current word, so leaving -- or the tablet
  // going to sleep -- keeps your place.
  function sync() {
    state.lastSync = Date.now();
    const w = state.pos && wordAt(state.pos);
    if (!w) return Promise.resolve();
    return Promise.resolve(state.source.goTo(w)).catch(() => { /* the book stays where it was */ });
  }

  async function jumpTo(p) {
    if (!p) return;
    state.pos = p;
    state.ended = false;
    playBtn.disabled = false;
    state.ramp = 0;
    showCurrent();
    if (state.playing) schedule();
    else renderContext();
  }

  async function backSentence() {
    if (!state.pos) return;
    let { at, steps } = await sentenceStart(state.pos);
    // Already at (or just past) the start of a sentence: go to the one before.
    if (steps <= 1) {
      const prev = await backward(at);
      if (prev) at = (await sentenceStart(prev)).at;
    }
    await jumpTo(at);
  }

  async function forwardSentence() {
    if (!state.pos) return;
    let p = state.pos;
    for (let n = 0; n < 400; n++) {
      const w = wordAt(p);
      const next = await forward(p);
      if (!next) return;
      p = next;
      if (isBoundary(w)) break;
    }
    await jumpTo(p);
  }

  function changeWpm(direction) {
    const step = state.wpm < 500 || (state.wpm === 500 && direction < 0) ? 25 : 50;
    state.wpm = clamp(state.wpm + direction * step, MIN_WPM, MAX_WPM);
    saveSettings({ speedWpm: state.wpm });
    wpmEl.textContent = `${state.wpm} wpm`;
    if (state.pos) updateWhere(true);
  }

  // ---------------------------------------------------------- wiring

  const onStageClick = () => { if (state.pos) toggle(); };

  // Captured at the window, ahead of everything else, and stopped there: the
  // reader underneath has its own arrow keys (page turns, scrolling) and the app
  // has its own Escape, and none of them should act on a book nobody can see.
  const onKey = (e) => {
    const onButton = e.target?.tagName === 'BUTTON';
    e.stopPropagation();
    // Space and Enter on a focused button belong to that button.
    if (onButton && (e.key === ' ' || e.key === 'Enter')) return;
    const act = {
      ' ': toggle,
      ArrowLeft: backSentence,
      ArrowRight: forwardSentence,
      ArrowUp: () => changeWpm(+1),
      ArrowDown: () => changeWpm(-1),
      Escape: close,
    }[e.key];
    if (act) { e.preventDefault(); act(); }
  };

  const onVisibility = () => { if (document.hidden) pause(); };

  const handlers = [
    [$('#rsvp-stage'), 'click', onStageClick],
    [playBtn, 'click', toggle],
    [$('#rsvp-back'), 'click', backSentence],
    [$('#rsvp-fwd'), 'click', forwardSentence],
    [$('#rsvp-slower'), 'click', () => changeWpm(-1)],
    [$('#rsvp-faster'), 'click', () => changeWpm(+1)],
    [$('#rsvp-done'), 'click', () => close()],
  ];
  for (const [el, type, fn] of handlers) el.addEventListener(type, fn);
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onVisibility);

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    const wasPlaying = state.playing;
    pause({ quiet: true });
    clearTimeout(state.timer);
    releaseScreen();
    // Wait for the book to arrive at the word before uncovering it, so it is
    // already there rather than visibly jumping.
    if (wasPlaying || state.pos) await sync();

    for (const [el, type, fn] of handlers) el.removeEventListener(type, fn);
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisibility);
    state.contextToken++;
    root.hidden = true;
    document.body.classList.remove('speed-reading');
    active = null;
    onClose?.();
  }

  // ------------------------------------------------------------- start

  try {
    state.source = await session.speedSource();
    const start = state.source && await state.source.start();
    if (!start) {
      hintEl.textContent = 'There is no text here to speed read. A scanned PDF holds pictures of pages, not text.';
      return;
    }
    seed(start.c, start.chunk);
    state.pos = { c: start.c, i: start.i };
    playBtn.disabled = false;
    hintEl.textContent = 'Tap to start';
    showCurrent();
    renderContext();
  } catch (err) {
    console.warn('speed read could not start', err);
    hintEl.textContent = 'Could not read the text of this book.';
  }
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
