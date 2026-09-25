// Chapter markers in an MP4 audiobook (.m4b, .m4a).
//
// An MP4 file is a tree of boxes, each a size and a four-letter type. Chapters
// are written into that tree in one of two ways, and many tools write both:
//
//   QuickTime   a separate TEXT track, pointed at from the audio track's
//               tref/chap box. Each sample in it is one chapter title, and the
//               sample's time in that track is where the chapter starts.
//               This is what Apple writes and what Apple Books reads.
//   Nero        a flat list in moov/udta/chpl: a start time in 100-nanosecond
//               units and a title, per chapter.
//
// The QuickTime track is preferred where both exist. They are two independent
// statements of the same chapters, which is also how this was checked: on the
// sample audiobook both give 69 chapters, same titles, same starts.
//
// Nothing here reads the audio. The whole file is never loaded -- only the moov
// box (the index, a few megabytes even for a 13-hour book, most of it the
// audio's own sample table) and the few bytes of each chapter title.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'tref', 'edts', 'dinf']);

// A moov bigger than this is not something to read whole on a tablet. Real
// audiobooks sit far below it: 8 MB for thirteen hours.
const MAX_MOOV_BYTES = 64 * 1048576;

// A chapter track is a handful of samples; a track with thousands is audio or
// something else, and not worth walking for titles.
const MAX_CHAPTERS = 5000;

const fourcc = (view, at) => String.fromCharCode(
  view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

function* boxes(view, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = view.getUint32(p);
    const type = fourcc(view, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(view.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) return;   // damaged: stop, do not guess
    yield { type, start: p + header, end: p + size };
    p += size;
  }
}

function child(view, box, type) {
  for (const b of boxes(view, box.start, box.end)) if (b.type === type) return b;
  return null;
}

function descend(view, box, ...types) {
  let b = box;
  for (const t of types) b = b && child(view, b, t);
  return b;
}

// Finds the top-level moov without reading anything else: one small read per
// box header, skipping the audio data by its stated size.
async function readMoov(blob) {
  let offset = 0;
  for (let n = 0; n < 64 && offset + 8 <= blob.size; n++) {
    const head = new DataView(await blob.slice(offset, offset + 16).arrayBuffer());
    if (head.byteLength < 8) return null;
    let size = head.getUint32(0);
    const type = fourcc(head, 4);
    let header = 8;
    if (size === 1) {
      if (head.byteLength < 16) return null;
      size = Number(head.getBigUint64(8));
      header = 16;
    } else if (size === 0) {
      size = blob.size - offset;
    }
    if (size < header) return null;
    if (type === 'moov') {
      if (size - header > MAX_MOOV_BYTES) return null;
      return new DataView(await blob.slice(offset + header, offset + size).arrayBuffer());
    }
    offset += size;
  }
  return null;
}

// tkhd and mdhd put their fields later in version 1, which has 64-bit times.
const versioned = (view, box, v0, v1) => box.start + (view.getUint8(box.start) === 1 ? v1 : v0);

function tracksOf(view, root) {
  const out = [];
  for (const trak of boxes(view, root.start, root.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(view, trak, 'tkhd');
    const mdia = child(view, trak, 'mdia');
    const hdlr = mdia && child(view, mdia, 'hdlr');
    const mdhd = mdia && child(view, mdia, 'mdhd');
    const chap = descend(view, trak, 'tref', 'chap');
    const refs = [];
    if (chap) for (let p = chap.start; p + 4 <= chap.end; p += 4) refs.push(view.getUint32(p));
    out.push({
      id: tkhd ? view.getUint32(versioned(view, tkhd, 12, 20)) : null,
      handler: hdlr ? fourcc(view, hdlr.start + 8) : null,
      timescale: mdhd ? view.getUint32(versioned(view, mdhd, 12, 20)) : null,
      chapterRefs: refs,
      stbl: mdia ? descend(view, mdia, 'minf', 'stbl') : null,
    });
  }
  return out;
}

// When each sample starts, in seconds, from the time-to-sample table.
function sampleStarts(view, stbl, timescale) {
  const stts = child(view, stbl, 'stts');
  if (!stts || !timescale) return null;
  const entries = view.getUint32(stts.start + 4);
  const starts = [];
  let t = 0;
  for (let i = 0; i < entries; i++) {
    const at = stts.start + 8 + i * 8;
    if (at + 8 > stts.end) break;
    const count = view.getUint32(at);
    const delta = view.getUint32(at + 4);
    for (let k = 0; k < count; k++) {
      if (starts.length >= MAX_CHAPTERS) return null;
      starts.push(t / timescale);
      t += delta;
    }
  }
  return starts;
}

// Where each sample's bytes are in the file: the chunk offsets, how many
// samples each chunk holds, and each sample's size.
function sampleLocations(view, stbl) {
  const stsz = child(view, stbl, 'stsz');
  const stsc = child(view, stbl, 'stsc');
  const stco = child(view, stbl, 'stco');
  const co64 = child(view, stbl, 'co64');
  if (!stsz || !stsc || (!stco && !co64)) return null;

  const fixed = view.getUint32(stsz.start + 4);
  const count = view.getUint32(stsz.start + 8);
  if (count > MAX_CHAPTERS) return null;
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(fixed || view.getUint32(stsz.start + 12 + i * 4));

  const chunks = [];
  if (stco) {
    const n = view.getUint32(stco.start + 4);
    for (let i = 0; i < n; i++) chunks.push(view.getUint32(stco.start + 8 + i * 4));
  } else {
    const n = view.getUint32(co64.start + 4);
    for (let i = 0; i < n; i++) chunks.push(Number(view.getBigUint64(co64.start + 8 + i * 8)));
  }

  const runs = [];
  const nRuns = view.getUint32(stsc.start + 4);
  for (let i = 0; i < nRuns; i++) {
    runs.push({ first: view.getUint32(stsc.start + 8 + i * 12), per: view.getUint32(stsc.start + 12 + i * 12) });
  }

  const locations = [];
  let s = 0;
  for (let c = 0; c < chunks.length && s < count; c++) {
    let per = runs[0]?.per || 1;
    for (const r of runs) { if (r.first <= c + 1) per = r.per; else break; }
    let offset = chunks[c];
    for (let k = 0; k < per && s < count; k++) {
      locations.push({ offset, size: sizes[s] });
      offset += sizes[s];
      s++;
    }
  }
  return locations;
}

// A text sample is a 16-bit length and then the title, UTF-8 unless it opens
// with a UTF-16 byte-order mark.
async function sampleText(blob, loc) {
  if (!loc || loc.size < 2) return '';
  const buf = await blob.slice(loc.offset, loc.offset + Math.min(loc.size, 4096)).arrayBuffer();
  const view = new DataView(buf);
  if (view.byteLength < 2) return '';
  const len = Math.min(view.getUint16(0), view.byteLength - 2);
  const bytes = new Uint8Array(buf, 2, len);
  const utf16 = len >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  return new TextDecoder(utf16 ? 'utf-16be' : 'utf-8')
    .decode(utf16 ? bytes.subarray(2) : bytes)
    .replace(/\0+$/, '')
    .trim();
}

async function quicktimeChapters(blob, view, root) {
  const tracks = tracksOf(view, root);
  // The track the audio points at; failing that, any text track at all, which
  // some tools write without the pointer.
  const refs = new Set(tracks.flatMap(t => (t.handler === 'soun' ? t.chapterRefs : [])));
  const chapterTrack = tracks.find(t => refs.has(t.id))
    || tracks.find(t => t.handler === 'text' || t.handler === 'sbtl');
  if (!chapterTrack?.stbl) return null;

  const starts = sampleStarts(view, chapterTrack.stbl, chapterTrack.timescale);
  const locations = sampleLocations(view, chapterTrack.stbl);
  if (!starts?.length || !locations?.length) return null;

  const out = [];
  for (let i = 0; i < Math.min(starts.length, locations.length); i++) {
    out.push({ title: await sampleText(blob, locations[i]), start: starts[i] });
  }
  return out;
}

function neroChapters(view, root) {
  const chpl = descend(view, root, 'udta', 'chpl');
  if (!chpl) return null;
  const version = view.getUint8(chpl.start);
  let p = chpl.start + 4 + (version ? 4 : 0);
  if (p >= chpl.end) return null;
  const n = view.getUint8(p);
  p += 1;
  const decoder = new TextDecoder('utf-8');
  const out = [];
  for (let i = 0; i < n && p + 9 <= chpl.end; i++) {
    const start = Number(view.getBigUint64(p)) / 1e7;
    const len = Math.min(view.getUint8(p + 8), chpl.end - p - 9);
    const title = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + p + 9, len)).trim();
    out.push({ title, start });
    p += 9 + len;
  }
  return out;
}

// In time order, near-duplicates merged, a blank title given a number. Fewer
// than two chapters is no chapters: one marker at 0:00 tells nobody anything.
export function tidyChapters(list) {
  if (!list?.length) return null;
  const sorted = list
    .filter(c => Number.isFinite(c.start) && c.start >= 0)
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of sorted) {
    if (out.length && c.start - out[out.length - 1].start < 0.5) continue;
    out.push({ title: c.title || `Chapter ${out.length + 1}`, start: c.start });
  }
  return out.length >= 2 ? out : null;
}

// Both readings, for checking one against the other.
export async function readChapterLists(blob) {
  const view = await readMoov(blob);
  if (!view) return { quicktime: null, nero: null };
  const root = { start: 0, end: view.byteLength };
  let quicktime = null;
  let nero = null;
  try { quicktime = tidyChapters(await quicktimeChapters(blob, view, root)); } catch { /* damaged track */ }
  try { nero = tidyChapters(neroChapters(view, root)); } catch { /* damaged list */ }
  return { quicktime, nero };
}

// The chapters, or null. Never throws: a file whose chapters cannot be read
// still plays, as one long track.
export async function readChapters(blob) {
  try {
    const { quicktime, nero } = await readChapterLists(blob);
    return quicktime || nero || null;
  } catch {
    return null;
  }
}
