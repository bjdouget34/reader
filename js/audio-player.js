// The audiobook player.
//
// An audiobook belongs to a book: added from inside the reader, stored on the
// device beside it (so it plays on a plane), and resumed where you stopped
// listening. It can be one long file (an .m4b, say) or a folder of chapter
// files, which play in order as one book.
//
// The controls sit in a bar across the top of the page, under the toolbar,
// and hide with one tap. Hidden is not stopped: the audio keeps playing, and
// the lock screen and headphone buttons still drive it. With the toolbar
// collapsed as well, a small 🎧 beside the toolbar's own ⌄ brings the player
// back in one tap.
//
// A real <audio> element does the playing -- the browser's own decoder, the
// same job VLC does -- so it carries on with the screen off, which speech
// synthesis would not.

import { audioDb, keepStorage } from './db.js';
import { loadSettings, saveSettings } from './settings.js';

const $ = (sel) => document.querySelector(sel);

// What the file picker offers. Broad on purpose: whether a file actually plays
// is decided by trying it (see probe), not by its name.
export const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.m4b,.aac,.ogg,.oga,.opus,.wav,.flac,.webm';

const SKIP_S = 30;
const SAVE_EVERY_MS = 5000;
export const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

// Files a browser will never play, named so the refusal can say why and what
// to do about it, rather than a bare "could not be played".
const REFUSE = [
  [/\.(wma|asf)$/i, 'Windows Media -- convert to MP3 or M4A first',
    'is a Windows Media file, which browsers cannot play. Convert it to MP3 or M4A first -- VLC can do that.',
    'are Windows Media files, which browsers cannot play. Convert them to MP3 or M4A first -- VLC can do that.'],
  [/\.(aax|aa)$/i, 'Audible -- plays only in Audible\'s app',
    'is an Audible file, which only plays in Audible\'s own app.',
    'are Audible files, which only play in Audible\'s own app.'],
  [/\.m4p$/i, 'Apple copy-protected',
    'is copy-protected by Apple and only plays in Apple\'s apps.',
    'are copy-protected by Apple and only play in Apple\'s apps.'],
];
const UNREADABLE = ['could not be played', 'could not be played in this browser.', 'could not be played in this browser.'];

// What else lives in an audiobook folder -- the cover, a playlist, a readme.
// Selecting the whole folder brings these along; they are passed over quietly
// and counted, rather than reported as audio that failed to play.
const NOT_AUDIO = /\.(jpe?g|png|gif|webp|bmp|txt|nfo|pdf|wax|m3u8?|pls|cue|log|sfv|url|ini|db|xml|json|md)$/i;
const isNotAudio = (file) => NOT_AUDIO.test(file.name) || /^(image|text)\//.test(file.type || '');

// The type to store a file under. Browsers often report no type at all for an
// .m4b, and a type-less blob is left to guesswork when it is played back.
const TYPES = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  flac: 'audio/flac', webm: 'audio/webm',
};

function typeFor(file) {
  const ext = (/\.([^.]+)$/.exec(file.name)?.[1] || '').toLowerCase();
  return TYPES[ext] || file.type || 'application/octet-stream';
}

// Natural order, so "Chapter 2" plays before "Chapter 10".
export function byName(a, b) {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

const trackName = (fileName) => fileName.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim();

// Lets the browser read just the file's header. That is the honest test of
// "will this play here" -- canPlayType answers "maybe" to nearly everything --
// and it hands back the length, which the whole-book position bar needs.
function probe(blob, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    const url = URL.createObjectURL(blob);
    let timer = 0;
    const done = (result) => {
      clearTimeout(timer);
      a.removeAttribute('src');
      a.load();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    timer = setTimeout(() => done({ ok: false }), timeoutMs);
    a.addEventListener('loadedmetadata', () => done({
      ok: true,
      duration: Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null,
    }), { once: true });
    a.addEventListener('error', () => done({ ok: false }), { once: true });
    a.src = url;
  });
}

export async function prepareTracks(fileList) {
  const files = [...fileList].sort(byName);
  const tracks = [];
  const refused = [];
  let ignored = 0;
  for (const file of files) {
    if (isNotAudio(file)) { ignored++; continue; }
    const rule = REFUSE.find(([re]) => re.test(file.name));
    if (rule) { refused.push({ name: file.name, short: rule[1], long: rule[2], many: rule[3], named: true }); continue; }
    const type = typeFor(file);
    const blob = new Blob([file], { type });
    const { ok, duration } = await probe(blob);
    if (!ok) { refused.push({ name: file.name, short: UNREADABLE[0], long: UNREADABLE[1], many: UNREADABLE[2], named: false }); continue; }
    tracks.push({ name: trackName(file.name), file: file.name, type, size: file.size, duration, blob });
  }
  // A reason that says what to do goes first: "convert it" is more use than
  // "could not be played".
  refused.sort((a, b) => Number(b.named) - Number(a.named));
  return { tracks, refused, ignored };
}

// One sentence about what was left out, saying each reason once: four parts
// of one WMA audiobook are one problem, not four.
export function describeRefused(refused) {
  if (!refused.length) return '';
  const groups = new Map();
  for (const r of refused) {
    if (!groups.has(r.short)) groups.set(r.short, []);
    groups.get(r.short).push(r);
  }
  if (groups.size === 1) {
    const [only] = groups.values();
    return only.length === 1 ? `${only[0].name} ${only[0].long}` : `These ${only.length} files ${only[0].many}`;
  }
  return [...groups.values()]
    .map(g => (g.length === 1 ? `${g[0].name} (${g[0].short})` : `${g.length} files (${g[0].short})`))
    .join('; ') + '.';
}

// Where each track starts in the book, and how long the whole book is. Null
// when any track's length is unknown: then the position bar works within the
// current track instead, rather than drawing a book-wide bar that is wrong.
export function timeline(tracks) {
  if (!tracks.length || tracks.some(t => !Number.isFinite(t.duration))) return { offsets: null, total: null };
  const offsets = [];
  let at = 0;
  for (const t of tracks) { offsets.push(at); at += t.duration; }
  return { offsets, total: at };
}

// Which track a time in the whole book falls in, and how far into it.
export function locate(offsets, tracks, t) {
  let i = 0;
  while (i + 1 < offsets.length && offsets[i + 1] <= t) i++;
  return { index: i, time: Math.max(0, Math.min(t - offsets[i], tracks[i].duration)) };
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function formatLength(seconds) {
  if (!Number.isFinite(seconds)) return 'length unknown';
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

const mb = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;

// ------------------------------------------------------ listening position
//
// Kept in localStorage rather than on the book's record. Saving there means
// rewriting the record, which carries the book's own file bytes; doing that
// every few seconds of listening would be pure waste. It is tiny, and it goes
// when the audiobook does.

const posKey = (bookId) => `my-reader:audio:${bookId}`;

function loadPosition(bookId) {
  try {
    const v = JSON.parse(localStorage.getItem(posKey(bookId)) || 'null');
    return v && Number.isInteger(v.track) && Number.isFinite(v.time) ? v : null;
  } catch { return null; }
}

function savePosition(bookId, pos) {
  try { localStorage.setItem(posKey(bookId), JSON.stringify(pos)); } catch { /* storage refused */ }
}

export async function removeAudioFor(bookId) {
  try { localStorage.removeItem(posKey(bookId)); } catch { /* ignore */ }
  await audioDb.remove(bookId);
}

// ------------------------------------------------------------------ player

const audio = new Audio();
audio.preload = 'auto';

const state = {
  book: null,        // { id, title, author, cover } of the open book
  tracks: [],
  offsets: null,
  total: null,
  index: 0,
  url: null,
  coverUrl: null,
  pendingSeek: null,
  lastSave: 0,
  scrubbing: false,
  hooks: {},
};

const hasAudio = () => state.tracks.length > 0;

function rate() {
  const r = Number(loadSettings().audioRate);
  return RATES.includes(r) ? r : 1;
}

function barShown() {
  return loadSettings().audioBarShown !== false;
}

function globalTime() {
  const t = audio.currentTime || 0;
  return state.offsets ? state.offsets[state.index] + t : t;
}

function totalTime() {
  return state.offsets ? state.total : (Number.isFinite(audio.duration) ? audio.duration : null);
}

function remember(force = false) {
  if (!state.book || !hasAudio()) return;
  const now = Date.now();
  if (!force && now - state.lastSave < SAVE_EVERY_MS) return;
  state.lastSave = now;
  savePosition(state.book.id, { track: state.index, time: audio.currentTime || 0 });
}

function loadTrack(index, time = 0, { autoplay = false } = {}) {
  const track = state.tracks[index];
  if (!track) return;
  if (state.url) URL.revokeObjectURL(state.url);
  state.index = index;
  state.url = URL.createObjectURL(track.blob);
  state.pendingSeek = time > 0 ? time : null;
  // Changing the source resets the speed to the default speed, so both are set.
  audio.defaultPlaybackRate = rate();
  audio.src = state.url;
  audio.playbackRate = rate();
  if (autoplay) play();
  updateMediaSession();
  renderTracks();
  render();
}

async function play() {
  if (!hasAudio()) return;
  try {
    await audio.play();
  } catch (err) {
    // Refused without a tap on some platforms, or a file that stopped decoding.
    if (err?.name !== 'AbortError') state.hooks.onStatus?.('The audiobook could not start playing.');
  }
}

function pause() {
  audio.pause();
  remember(true);
}

function seekTo(t) {
  if (!hasAudio()) return;
  const total = totalTime();
  const target = Math.max(0, total != null ? Math.min(t, total - 0.5) : t);
  if (state.offsets) {
    const { index, time } = locate(state.offsets, state.tracks, target);
    if (index !== state.index) {
      loadTrack(index, time, { autoplay: !audio.paused });
      remember(true);
      return;
    }
    audio.currentTime = time;
  } else {
    audio.currentTime = target;
  }
  remember(true);
  render();
}

function skip(seconds) {
  if (state.offsets) { seekTo(globalTime() + seconds); return; }
  // Lengths unknown: skip within the track, and step to a neighbour at its ends.
  const t = (audio.currentTime || 0) + seconds;
  if (t < 0 && state.index > 0) { loadTrack(state.index - 1, 0, { autoplay: !audio.paused }); return; }
  if (Number.isFinite(audio.duration) && t > audio.duration && state.index + 1 < state.tracks.length) {
    loadTrack(state.index + 1, 0, { autoplay: !audio.paused });
    return;
  }
  audio.currentTime = Math.max(0, t);
  remember(true);
}

function stepTrack(delta) {
  const next = state.index + delta;
  if (next < 0 || next >= state.tracks.length) return;
  loadTrack(next, 0, { autoplay: !audio.paused });
  remember(true);
}

audio.addEventListener('loadedmetadata', () => {
  if (state.pendingSeek != null) {
    const d = Number.isFinite(audio.duration) ? audio.duration : Infinity;
    audio.currentTime = Math.min(state.pendingSeek, Math.max(0, d - 0.5));
    state.pendingSeek = null;
  }
  render();
});

audio.addEventListener('timeupdate', () => { render(); remember(); updatePositionState(); });
// The lock screen shows play or pause from this, on the platforms that ask.
function setPlaybackState(value) {
  try { if (media) media.playbackState = value; } catch { /* not supported */ }
}

audio.addEventListener('play', () => { render(); updatePositionState(); setPlaybackState('playing'); });
audio.addEventListener('pause', () => { render(); remember(true); setPlaybackState('paused'); });
audio.addEventListener('ratechange', updatePositionState);

audio.addEventListener('ended', () => {
  if (state.index + 1 < state.tracks.length) {
    loadTrack(state.index + 1, 0, { autoplay: true });
  } else {
    // The end of the book: rest at the start of the last file rather than
    // past its end, so the next Play replays something instead of nothing.
    savePosition(state.book.id, { track: state.index, time: 0 });
    render();
  }
});

audio.addEventListener('error', () => {
  if (hasAudio()) state.hooks.onStatus?.(`"${state.tracks[state.index]?.name}" could not be played.`);
});

// Leaving the app mid-chapter is the usual way a listening session ends.
document.addEventListener('visibilitychange', () => { if (document.hidden) remember(true); });
window.addEventListener('pagehide', () => remember(true));

// ---------------------------------------------------------- lock screen

const media = 'mediaSession' in navigator ? navigator.mediaSession : null;

function setAction(name, fn) {
  try { media?.setActionHandler(name, fn); } catch { /* not supported here */ }
}

function updateMediaSession() {
  if (!media) return;
  if (!state.book || !hasAudio()) {
    media.metadata = null;
    setPlaybackState('none');
    for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack']) setAction(a, null);
    return;
  }
  const many = state.tracks.length > 1;
  try {
    media.metadata = new MediaMetadata({
      title: many ? state.tracks[state.index].name : state.book.title,
      artist: state.book.author || '',
      album: state.book.title,
      artwork: state.coverUrl ? [{ src: state.coverUrl, sizes: '400x600', type: state.book.cover?.type || 'image/jpeg' }] : [],
    });
  } catch { /* MediaMetadata missing */ }
  setAction('play', () => play());
  setAction('pause', () => pause());
  setAction('seekbackward', (d) => skip(-(d?.seekOffset || SKIP_S)));
  setAction('seekforward', (d) => skip(d?.seekOffset || SKIP_S));
  setAction('seekto', (d) => {
    if (!Number.isFinite(d?.seekTime)) return;
    // The lock screen's bar is for the file playing, not the whole book.
    audio.currentTime = d.seekTime;
    remember(true);
  });
  setAction('previoustrack', many ? () => stepTrack(-1) : null);
  setAction('nexttrack', many ? () => stepTrack(1) : null);
}

function updatePositionState() {
  if (!media?.setPositionState || !Number.isFinite(audio.duration)) return;
  try {
    media.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime || 0, audio.duration),
    });
  } catch { /* an out-of-range moment mid-seek */ }
}

// -------------------------------------------------------------------- UI

function render() {
  const btn = $('#audio-open');
  if (!state.book) { btn.disabled = true; return; }
  btn.disabled = false;
  btn.classList.toggle('is-playing', hasAudio() && !audio.paused);
  $('#audio-show').classList.toggle('is-playing', hasAudio() && !audio.paused);
  btn.title = !hasAudio()
    ? 'Add an audiobook for this book'
    : barShown() ? 'Hide the audiobook player' : 'Show the audiobook player';

  const bar = $('#audio-bar');
  const showBar = hasAudio() && barShown();
  if (bar.hidden === showBar) {
    bar.hidden = !showBar;
    state.hooks.onLayout?.();
  }
  syncAudioChrome();
  if (!hasAudio()) return;

  const playBtn = $('#audio-play');
  playBtn.textContent = audio.paused ? '▶' : '❚❚';
  playBtn.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause');
  playBtn.title = audio.paused ? 'Play' : 'Pause';

  const total = totalTime();
  const now = globalTime();
  if (!state.scrubbing) {
    $('#audio-time').textContent = formatTime(now);
    $('#audio-seek').value = total ? String(Math.round((now / total) * 1000)) : '0';
  }
  $('#audio-left').textContent = total != null ? `-${formatTime(total - now)}` : '';
  $('#audio-seek').disabled = !total;
  $('#audio-rate').value = String(rate());

  const many = state.tracks.length > 1;
  const trackEl = $('#audio-track');
  trackEl.hidden = !many;
  if (many) trackEl.textContent = `${state.index + 1}/${state.tracks.length}`;
}

// The small 🎧 beside the toolbar's own ⌄, for when both the toolbar and the
// player are tucked away: one tap brings the player back without opening the
// toolbar first.
export function syncAudioChrome() {
  const chromeHidden = document.body.dataset.chrome === 'hidden';
  $('#audio-show').hidden = !(state.book && hasAudio() && chromeHidden && !barShown());
}

function setBarShown(shown) {
  saveSettings({ audioBarShown: shown });
  render();
}

function renderTracks() {
  const list = $('#audio-tracks');
  const summary = $('#audio-summary');
  list.textContent = '';
  if (!hasAudio()) { summary.textContent = ''; return; }

  const bytes = state.tracks.reduce((n, t) => n + (t.size || 0), 0);
  const files = state.tracks.length;
  summary.textContent = `${files} file${files === 1 ? '' : 's'} · ${formatLength(state.total)} · ${mb(bytes)} stored on this device`;

  state.tracks.forEach((t, i) => {
    const b = document.createElement('button');
    b.className = 'audio-track' + (i === state.index ? ' is-current' : '');
    const name = document.createElement('span');
    name.textContent = t.name;
    const len = document.createElement('span');
    len.className = 'audio-track-len';
    len.textContent = formatTime(t.duration);
    b.append(name, len);
    b.addEventListener('click', () => {
      loadTrack(i, 0, { autoplay: true });
      remember(true);
    });
    list.append(b);
  });
}

async function attach(fileList) {
  const book = state.book;
  if (!book || !fileList?.length) return;
  const say = state.hooks.onStatus || (() => {});

  say('Checking the audio files…');
  const { tracks, refused, ignored } = await prepareTracks(fileList);
  if (!tracks.length) {
    say(describeRefused(refused) || (ignored ? 'There are no audio files in that selection.' : 'Nothing in that selection can be played.'));
    return;
  }

  const bytes = tracks.reduce((n, t) => n + t.size, 0);
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota && est.quota - est.usage < bytes * 1.05) {
      say(`Not enough room: this audiobook is ${mb(bytes)} and this device has ${mb(est.quota - est.usage)} free for the app.`);
      return;
    }
  } catch { /* no estimate; try anyway */ }

  say(`Saving the audiobook (${mb(bytes)})…`);
  await keepStorage();
  try {
    await audioDb.put({ bookId: book.id, tracks, added: Date.now() });
  } catch (err) {
    console.error(err);
    say('The audiobook could not be saved on this device -- it may be out of space.');
    return;
  }
  if (state.book?.id !== book.id) return;   // the book was closed meanwhile

  // A new audiobook starts at its beginning, whatever the old one had reached.
  try { localStorage.removeItem(posKey(book.id)); } catch { /* ignore */ }
  audio.pause();
  useTracks(tracks, null);
  saveSettings({ audioBarShown: true });
  render();
  state.hooks.onAudioChanged?.();

  const length = formatLength(state.total);
  const extra = ignored ? ` (${ignored} other file${ignored === 1 ? '' : 's'}, like covers, left out.)` : '';
  say(refused.length
    ? `Added ${tracks.length} file${tracks.length === 1 ? '' : 's'} (${length}). Skipped ${refused.length}: ${describeRefused(refused)}`
    : `Audiobook added: ${tracks.length} file${tracks.length === 1 ? '' : 's'}, ${length}.${extra}`);
}

function useTracks(tracks, position) {
  state.tracks = tracks;
  const { offsets, total } = timeline(tracks);
  state.offsets = offsets;
  state.total = total;
  const start = position && position.track < tracks.length ? position : { track: 0, time: 0 };
  loadTrack(start.track, start.time);
}

function teardown() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = null;
  state.tracks = [];
  state.offsets = null;
  state.total = null;
  state.index = 0;
  state.pendingSeek = null;
}

// Called when a book opens. Loads its audiobook if it has one, ready at the
// place it was left, and never starts playing on its own.
export async function openAudioFor(record, hooks = {}) {
  closeAudio();
  state.book = { id: record.id, title: record.title, author: record.author, cover: record.cover || null };
  state.hooks = hooks;
  state.coverUrl = record.cover ? URL.createObjectURL(record.cover) : null;
  render();

  let stored = null;
  try { stored = await audioDb.get(record.id); } catch { /* none */ }
  if (state.book?.id !== record.id) return;   // closed or switched meanwhile
  if (stored?.tracks?.length) useTracks(stored.tracks, loadPosition(record.id));
  render();
}

// Called when the book closes: stop, keep the place, let go of everything.
export function closeAudio() {
  if (state.book && hasAudio()) remember(true);
  teardown();
  if (state.coverUrl) URL.revokeObjectURL(state.coverUrl);
  state.coverUrl = null;
  state.book = null;
  updateMediaSession();
  renderTracks();
  const bar = $('#audio-bar');
  if (bar) bar.hidden = true;
  $('#audio-show').hidden = true;
  render();
}

// --------------------------------------------------------------- wiring

export function wireAudioControls() {
  const picker = $('#audio-file');
  picker.accept = AUDIO_ACCEPT;
  picker.addEventListener('change', async () => {
    const files = [...picker.files];
    picker.value = '';
    await attach(files);
  });

  // The toolbar's 🎧: add an audiobook, or show and hide the player once
  // there is one.
  $('#audio-open').addEventListener('click', () => {
    if (!state.book) return;
    if (!hasAudio()) { picker.click(); return; }
    setBarShown(!barShown());
  });
  $('#audio-show').addEventListener('click', () => setBarShown(true));
  $('#audio-hide').addEventListener('click', () => setBarShown(false));

  $('#audio-play').addEventListener('click', () => (audio.paused ? play() : pause()));
  $('#audio-back').addEventListener('click', () => skip(-SKIP_S));
  $('#audio-fwd').addEventListener('click', () => skip(SKIP_S));

  const seek = $('#audio-seek');
  // While dragging, show where the drag would land and leave the audio alone;
  // seek once, on release.
  seek.addEventListener('input', () => {
    const total = totalTime();
    if (!total) return;
    state.scrubbing = true;
    $('#audio-time').textContent = formatTime((Number(seek.value) / 1000) * total);
  });
  seek.addEventListener('change', () => {
    const total = totalTime();
    state.scrubbing = false;
    if (total) seekTo((Number(seek.value) / 1000) * total);
  });

  const rateSel = $('#audio-rate');
  rateSel.textContent = '';
  for (const r of RATES) {
    const o = document.createElement('option');
    o.value = String(r);
    o.textContent = `${r}×`;
    rateSel.append(o);
  }
  rateSel.value = String(rate());
  rateSel.addEventListener('change', () => {
    const r = Number(rateSel.value);
    saveSettings({ audioRate: r });
    audio.defaultPlaybackRate = r;
    audio.playbackRate = r;
  });

  $('#audio-replace').addEventListener('click', () => picker.click());
  $('#audio-remove').addEventListener('click', async () => {
    if (!state.book || !hasAudio()) return;
    if (!confirm('Remove the audiobook from this book?\n\nThe audio files are deleted from this device. The book and your place in it stay.')) return;
    const id = state.book.id;
    teardown();
    updateMediaSession();
    await removeAudioFor(id);
    $('#audio').hidden = true;
    renderTracks();
    render();
    state.hooks.onAudioChanged?.();
    state.hooks.onStatus?.('Audiobook removed.');
  });

  render();
}
