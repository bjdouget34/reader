// Chapter markers in an MP3 audiobook.
//
// An MP3 keeps its metadata in an ID3v2 tag at the front of the file: a header
// and then frames, each a four-letter id, a size and a body. Chapters turn up
// in one of two frames, and both are read:
//
//   CHAP       the ID3 chapter addendum's own frame: a start time in
//              milliseconds and, nested inside, a TIT2 frame with the title.
//   TXXX       a user text frame. OverDrive -- the service behind Libby and
//              most library audiobooks -- writes one described as "OverDrive
//              MediaMarkers", whose value is a small XML list of markers with
//              a name and a time each. The sample Middlemarch is exactly this.
//
// CHAP is preferred where a file has both, being the standard.
//
// Only the tag is read -- a few kilobytes at the front of a file that may be a
// hundred megabytes of audio -- and a tag that looks wrong is given up on
// rather than guessed at, since the file still plays without chapters.

import { tidyChapters } from './mp4-chapters.js';

// Tags carry cover art and can run to a few megabytes; past this it is not a
// tag worth reading on a tablet.
const MAX_TAG_BYTES = 16 * 1048576;

const syncsafe = (b, at) => ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);
const u32 = (b, at) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];

// Unsynchronisation: the encoder inserted a 0x00 after every 0xFF so the tag
// could not be mistaken for audio. Taking them back out.
function unsync(bytes) {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[n++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

function frames(b, start, end, major) {
  const out = [];
  let p = start;
  while (p + 10 <= end) {
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;          // padding, or the end of the tag
    const size = major === 4 ? syncsafe(b, p + 4) : u32(b, p + 4);
    const format = b[p + 9];
    let data = b.subarray(p + 10, Math.min(end, p + 10 + size));
    p += 10 + size;
    if (major === 4) {
      if (format & 0x40) data = data.subarray(1);   // grouping identity byte
      if (format & 0x0c) continue;                  // compressed or encrypted
      if (format & 0x01) data = data.subarray(4);   // data length indicator
      if (format & 0x02) data = unsync(data);
    } else {
      if (format & 0xc0) continue;                  // compressed or encrypted
      if (format & 0x20) data = data.subarray(1);   // grouping identity byte
    }
    out.push({ id, data });
  }
  return out;
}

async function readTag(blob) {
  const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null;   // "ID3"
  const major = head[3];
  if (major !== 3 && major !== 4) return null;      // 2.2 predates chapters
  const flags = head[5];
  const size = syncsafe(head, 6);
  if (!size || size > MAX_TAG_BYTES) return null;
  let body = new Uint8Array(await blob.slice(10, 10 + size).arrayBuffer());
  if (major === 3 && (flags & 0x80)) body = unsync(body);
  let start = 0;
  if (flags & 0x40) start = major === 4 ? syncsafe(body, 0) : u32(body, 0) + 4;   // extended header
  return { major, frames: frames(body, start, body.length, major) };
}

// ID3 text: an encoding byte, then the text. 0 is Latin-1, 1 is UTF-16 with a
// byte-order mark, 2 is UTF-16 big-endian, 3 is UTF-8.
function decode(encoding, bytes) {
  if (encoding === 1 || encoding === 2) {
    let le = encoding === 1;
    let body = bytes;
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { le = true; body = bytes.subarray(2); }
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) { le = false; body = bytes.subarray(2); }
    return new TextDecoder(le ? 'utf-16le' : 'utf-16be').decode(body);
  }
  return new TextDecoder(encoding === 3 ? 'utf-8' : 'windows-1252').decode(bytes);
}

// Where a null-terminated string ends, which in UTF-16 is two zero bytes on an
// even boundary rather than one.
function terminator(encoding, bytes, from = 0) {
  if (encoding === 1 || encoding === 2) {
    for (let i = from; i + 1 < bytes.length; i += 2) if (bytes[i] === 0 && bytes[i + 1] === 0) return { at: i, width: 2 };
  } else {
    for (let i = from; i < bytes.length; i++) if (bytes[i] === 0) return { at: i, width: 1 };
  }
  return { at: bytes.length, width: 0 };
}

const textOf = (data) => {
  const body = data.subarray(1);
  const end = terminator(data[0], body);
  return decode(data[0], body.subarray(0, end.at)).trim();
};

function chapFrames(tag) {
  const out = [];
  for (const f of tag.frames) {
    if (f.id !== 'CHAP') continue;
    const d = f.data;
    let q = 0;
    while (q < d.length && d[q] !== 0) q++;          // element id, Latin-1, null-terminated
    q++;
    if (q + 16 > d.length) continue;
    const startMs = u32(d, q);                       // then end time and two byte offsets
    const title = frames(d, q + 16, d.length, tag.major).find(s => s.id === 'TIT2');
    out.push({ start: startMs / 1000, title: title ? textOf(title.data) : '' });
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// OverDrive writes times as minutes and seconds -- "03:52.000", and "63:52.000"
// past the hour rather than rolling over -- so every field is summed rather
// than read as a fixed hours:minutes:seconds.
export function parseClock(s) {
  if (!s) return NaN;
  const parts = s.trim().split(':').map(Number);
  if (!parts.length || parts.some(n => !Number.isFinite(n) || n < 0)) return NaN;
  return parts.reduce((a, b) => a * 60 + b, 0);
}

export function parseMediaMarkers(xml) {
  const out = [];
  for (const m of xml.matchAll(/<Marker>([\s\S]*?)<\/Marker>/gi)) {
    const name = /<Name>([\s\S]*?)<\/Name>/i.exec(m[1])?.[1] ?? '';
    const start = parseClock(/<Time>([\s\S]*?)<\/Time>/i.exec(m[1])?.[1]);
    if (Number.isFinite(start)) out.push({ title: unescapeXml(name).trim(), start });
  }
  return out;
}

function overdriveMarkers(tag) {
  for (const f of tag.frames) {
    if (f.id !== 'TXXX' || !f.data.length) continue;
    const enc = f.data[0];
    const body = f.data.subarray(1);
    const end = terminator(enc, body);
    if (!/overdrive\s*mediamarkers/i.test(decode(enc, body.subarray(0, end.at)))) continue;
    return parseMediaMarkers(decode(enc, body.subarray(end.at + end.width)));
  }
  return null;
}

// Both readings, for checking.
export async function readMp3ChapterLists(blob) {
  const tag = await readTag(blob);
  if (!tag) return { id3: null, overdrive: null };
  // A single marker still names the stretch of a book one file of a folder
  // holds, so one is enough here -- unlike a whole book in one M4B, where one
  // marker at 0:00 tells nobody anything.
  let id3 = null;
  let overdrive = null;
  try { id3 = tidyChapters(chapFrames(tag), { min: 1 }); } catch { /* damaged frame */ }
  try { overdrive = tidyChapters(overdriveMarkers(tag), { min: 1 }); } catch { /* damaged markers */ }
  return { id3, overdrive };
}

// The chapters, or null. Never throws.
export async function readMp3Chapters(blob) {
  try {
    const { id3, overdrive } = await readMp3ChapterLists(blob);
    return id3 || overdrive || null;
  } catch {
    return null;
  }
}
