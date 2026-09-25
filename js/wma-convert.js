// Converting Windows Media audiobooks to MP3, on the device.
//
// No browser plays WMA -- not Chrome, not Safari -- so a WMA audiobook has to
// become something else before the player can take it. This does that here,
// with ffmpeg compiled to WebAssembly (lib/ffmpeg/, from ffmpeg.wasm), the
// same program VLC uses underneath. The work happens in wma-worker.js so the
// page stays responsive; this side reads each file's header, asks before
// starting, shows progress, and hands the MP3s back to the player as if they
// had been picked.
//
// The converter is 32 MB (10 MB as downloaded) and is fetched the first time
// it is needed, not when the app installs: most people never convert
// anything. Once fetched the service worker keeps it, like every other file
// in lib/, so a second conversion works offline.
//
// The MP3s are mono at 64 kbps. That is what a spoken book needs -- it is
// what Audible's own standard quality is -- and it keeps a long book small
// enough for a phone: 29 MB an hour.

export const WMA = /\.(wma|asf)$/i;
export const MP3_KBPS = 64;
export const MP3_CHANNELS = 1;

const $ = (sel) => document.querySelector(sel);

// --------------------------------------------------------- the file header
//
// A WMA file is an ASF container, which opens with a header object holding
// other objects, each a 16-byte GUID and an 8-byte size. Two matter here: File
// Properties, which states the length, and Content Encryption, whose presence
// means the file is copy-protected and nothing can convert it.

// GUIDs as they sit on disk: the first three fields little-endian.
const guidBytes = (g) => {
  const h = g.replace(/-/g, '');
  const b = [];
  for (let i = 0; i < 16; i++) b.push(parseInt(h.slice(i * 2, i * 2 + 2), 16));
  return [b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], ...b.slice(8)];
};
const HEADER = guidBytes('75B22630-668E-11CF-A6D9-00AA0062CE6C');
const FILE_PROPERTIES = guidBytes('8CABDCA1-A947-11CF-8EE4-00C00C205365');
const ENCRYPTION = [
  guidBytes('2211B3FB-BD23-11D2-B4B7-00A0C955FC6E'),   // Content Encryption
  guidBytes('298AE614-2622-4C17-B935-DAE07EE9289C'),   // Extended Content Encryption
];
const isGuid = (bytes, at, guid) => guid.every((v, i) => bytes[at + i] === v);

// { asf, drm, seconds } from the first bytes of a file. seconds is null when
// the header does not say.
export function readAsfInfo(bytes) {
  const none = { asf: false, drm: false, seconds: null };
  if (bytes.length < 30 || !isGuid(bytes, 0, HEADER)) return none;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(24, true);
  let p = 30;
  let drm = false;
  let seconds = null;
  for (let i = 0; i < count && p + 24 <= bytes.length; i++) {
    const size = Number(view.getBigUint64(p + 16, true));
    if (size < 24) break;
    if (ENCRYPTION.some(g => isGuid(bytes, p, g))) drm = true;
    if (isGuid(bytes, p, FILE_PROPERTIES) && p + 88 <= bytes.length) {
      const play = Number(view.getBigUint64(p + 64, true));     // 100-nanosecond units
      const preroll = Number(view.getBigUint64(p + 80, true));  // milliseconds
      const s = play / 1e7 - preroll / 1000;
      seconds = s > 0 ? s : null;
    }
    p += size;
  }
  return { asf: true, drm, seconds };
}

export async function wmaInfo(file) {
  const bytes = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  return readAsfInfo(bytes);
}

export const mp3Name = (name) => name.replace(/\.[^.]+$/, '') + '.mp3';
export const mp3Bytes = (seconds) => Math.round((seconds * MP3_KBPS * 1000) / 8);

// "2 h 5 min", "12 min", "under a minute".
export function formatSpan(seconds) {
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'under a minute';
  const min = Math.round(seconds / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

// --------------------------------------------------------- the converter

class Cancelled extends Error {
  constructor() { super('cancelled'); this.name = 'AbortError'; }
}

// One worker for a batch, so ffmpeg is loaded once however many files there
// are, and ended afterwards so its memory goes with it.
export function createConverter({ onStarted, onProgress } = {}) {
  let worker = null;
  let pending = null;

  function start() {
    worker = new Worker(new URL('./wma-worker.js', import.meta.url), { type: 'module' });
    worker.onerror = (e) => {
      e.preventDefault?.();
      pending?.reject(Object.assign(new Error('The converter could not start.'), { stage: 'load' }));
      pending = null;
    };
    worker.onmessage = ({ data }) => {
      if (!pending) return;
      if (data.type === 'started') onStarted?.();
      else if (data.type === 'progress') onProgress?.(data.seconds);
      else if (data.type === 'chunk') pending.parts.push(data.data);
      else if (data.type === 'done') {
        const { parts, name, resolve } = pending;
        pending = null;
        resolve(new File(parts, mp3Name(name), { type: 'audio/mpeg' }));
      } else if (data.type === 'error') {
        const p = pending;
        pending = null;
        if (data.log?.length) console.warn('[wma]', data.log.join('\n'));
        p.reject(Object.assign(new Error(data.message), { stage: data.stage }));
      }
    };
  }

  return {
    convert(file) {
      if (!worker) start();
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, parts: [], name: file.name };
        worker.postMessage({ type: 'convert', file, bitrate: MP3_KBPS, channels: MP3_CHANNELS });
      });
    },
    // ffmpeg reads no messages while it works, so stopping it means ending the
    // worker outright.
    cancel() {
      pending?.reject(new Cancelled());
      pending = null;
      this.close();
    },
    close() {
      worker?.terminate();
      worker = null;
    },
  };
}

// ------------------------------------------------------------- the dialog
//
// Asks first, because this is minutes of work and, the first time, a 10 MB
// download. Then shows where it is and how long is left, measured from how
// fast it is actually going on this device rather than guessed.

function ask({ convertible, protectedCount, seconds }) {
  const root = $('#convert');
  const go = $('#convert-go');
  const cancel = $('#convert-cancel');
  const n = convertible.length;
  const what = n === 1 ? 'This file is' : `These ${n} files are`;
  const lines = [
    `${what} Windows Media (WMA), which browsers cannot play. `
      + `${n === 1 ? 'It' : 'They'} can be converted to MP3 here, on this device.`,
  ];
  if (Number.isFinite(seconds)) {
    lines.push(`${formatSpan(seconds)} of audio, about ${Math.max(1, Math.round(mp3Bytes(seconds) / 1048576))} MB once converted.`);
  }
  lines.push('The first time, this downloads the converter (about 10 MB). '
    + 'Keep the app open until it finishes; the screen stays on meanwhile.');
  if (protectedCount) {
    lines.push(`${protectedCount === 1 ? 'One file is' : `${protectedCount} files are`} copy-protected and cannot be converted, so ${protectedCount === 1 ? 'it is' : 'they are'} left out.`);
  }
  $('#convert-title').textContent = 'Convert Windows Media audio?';
  $('#convert-text').textContent = lines.join('\n\n');
  $('#convert-progress').hidden = true;
  $('#convert-status').textContent = '';
  go.hidden = false;
  cancel.textContent = 'Cancel';
  root.hidden = false;
  go.focus();
  return new Promise((resolve) => {
    const finish = (yes) => {
      go.removeEventListener('click', onGo);
      cancel.removeEventListener('click', onCancel);
      resolve(yes);
    };
    const onGo = () => finish(true);
    const onCancel = () => { root.hidden = true; finish(false); };
    go.addEventListener('click', onGo);
    cancel.addEventListener('click', onCancel);
  });
}

// Converts the WMA files among a selection. Returns the MP3s as Files, the
// files that could not be converted in the player's refusal shape, and
// whether the person cancelled.
export async function convertWmaFiles(files, { freeBytes = null } = {}) {
  const convertible = [];
  const refused = [];
  let protectedCount = 0;
  for (const file of files) {
    let info;
    try { info = await wmaInfo(file); } catch { info = { asf: false }; }
    if (!info.asf) {
      refused.push({ name: file.name, short: 'not a readable Windows Media file', long: 'is not a Windows Media file this can read.', many: 'are not Windows Media files this can read.', named: false });
    } else if (info.drm) {
      protectedCount++;
      refused.push({ name: file.name, short: 'copy-protected', long: 'is copy-protected (DRM). It only plays in the software it was bought for, and nothing can convert it.', many: 'are copy-protected (DRM). They only play in the software they were bought for, and nothing can convert them.', named: true });
    } else {
      convertible.push({ file, seconds: info.seconds });
    }
  }
  if (!convertible.length) return { files: [], refused, cancelled: false };

  const known = convertible.every(c => Number.isFinite(c.seconds));
  const seconds = known ? convertible.reduce((n, c) => n + c.seconds, 0) : null;

  if (known && freeBytes != null && freeBytes < mp3Bytes(seconds) * 1.05) {
    return { files: [], refused, cancelled: false, noRoom: mp3Bytes(seconds) };
  }
  if (typeof WebAssembly !== 'object') {
    for (const c of convertible) refused.push({ name: c.file.name, short: 'Windows Media -- this browser cannot convert it', long: 'is a Windows Media file, and this browser is too old to convert it. Updating it usually fixes this.', many: 'are Windows Media files, and this browser is too old to convert them. Updating it usually fixes this.', named: true });
    return { files: [], refused, cancelled: false };
  }

  if (!(await ask({ convertible, protectedCount, seconds }))) return { files: [], refused, cancelled: true };
  return run(convertible, seconds, refused);
}

async function run(convertible, total, refused) {
  const root = $('#convert');
  const bar = $('#convert-progress');
  const statusEl = $('#convert-status');
  const cancelBtn = $('#convert-cancel');
  $('#convert-go').hidden = true;
  $('#convert-title').textContent = 'Converting…';
  $('#convert-text').textContent = 'Keep the app open until this finishes.';
  cancelBtn.textContent = 'Cancel';
  bar.hidden = false;
  bar.removeAttribute('value');           // indeterminate while the converter loads
  statusEl.textContent = 'Getting the converter ready…';

  let wakeLock = null;
  const holdScreen = async () => {
    if (document.visibilityState !== 'visible') return;
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not offered */ }
  };
  // The browser drops a wake lock whenever the page is hidden; take it again
  // on the way back.
  const onVisible = () => { if (!wakeLock || wakeLock.released) holdScreen(); };
  document.addEventListener('visibilitychange', onVisible);
  await holdScreen();

  let doneBefore = 0;       // seconds of audio in the files already finished
  let current = 0;          // seconds into the file being converted
  let clockStart = 0;       // when ffmpeg first began, after loading
  let index = 0;
  const show = () => {
    const n = convertible.length;
    const part = n > 1 ? `File ${index + 1} of ${n}` : 'Converting';
    const done = doneBefore + current;
    if (!Number.isFinite(total) || !total) { statusEl.textContent = `${part} · ${formatSpan(done)} done`; return; }
    const fraction = Math.min(1, done / total);
    bar.value = fraction;
    bar.max = 1;
    let left = '';
    const elapsed = (performance.now() - clockStart) / 1000;
    // Wait a few seconds before estimating: the first moments are not typical.
    if (clockStart && elapsed > 4 && done > 0) {
      const s = ((total - done) * elapsed) / done;
      left = s < 60 ? ' · less than a minute left' : ` · about ${formatSpan(s)} left`;
    }
    statusEl.textContent = `${part} · ${Math.floor(fraction * 100)}%${left}`;
  };

  const converter = createConverter({
    onStarted: () => { if (!clockStart) clockStart = performance.now(); show(); },
    onProgress: (s) => { current = Math.max(0, s); show(); },
  });
  let cancelled = false;
  const onCancel = () => { cancelled = true; converter.cancel(); };
  cancelBtn.addEventListener('click', onCancel);

  const out = [];
  try {
    for (index = 0; index < convertible.length; index++) {
      const { file, seconds } = convertible[index];
      current = 0;
      try {
        out.push(await converter.convert(file));
      } catch (err) {
        if (cancelled || err.name === 'AbortError') break;
        if (err.stage === 'load') {
          // Nothing will convert if ffmpeg itself did not arrive; say so once.
          for (const c of convertible.slice(index)) {
            refused.push({ name: c.file.name, short: 'the converter could not be downloaded', long: 'could not be converted: the converter did not download. Connect to the internet and try again.', many: 'could not be converted: the converter did not download. Connect to the internet and try again.', named: true });
          }
          break;
        }
        console.error('[wma]', err);
        refused.push({ name: file.name, short: 'could not be converted', long: 'could not be converted.', many: 'could not be converted.', named: false });
      }
      doneBefore += Number.isFinite(seconds) ? seconds : 0;
    }
  } finally {
    cancelBtn.removeEventListener('click', onCancel);
    document.removeEventListener('visibilitychange', onVisible);
    converter.close();
    try { wakeLock?.release(); } catch { /* ignore */ }
    root.hidden = true;
  }
  if (cancelled) return { files: [], refused, cancelled: true };
  return { files: out, refused, cancelled: false };
}
