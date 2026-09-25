// Converts one WMA file to MP3, off the page's thread. Started by
// wma-convert.js; see there for why.
//
// ffmpeg is the WebAssembly build from ffmpeg.wasm (lib/ffmpeg/). It is given
// the file and hands back the MP3 as it goes, and neither is ever held whole
// in memory -- which matters on a phone, where a ten-hour book in one file
// would otherwise need several hundred megabytes at once:
//
//   input    mounted with WORKERFS, which reads the File from disk only as
//            ffmpeg asks for it, rather than copying it in first.
//   output   written to a device rather than a file. Every write ffmpeg makes
//            lands in a buffer here, and each few megabytes is posted to the
//            page, which gathers the pieces into a Blob.
//
// The page ends a conversion by terminating this worker, which is the only
// way to stop ffmpeg part-way: it runs synchronously and reads no messages
// until it is finished.

import createFFmpegCore from '../lib/ffmpeg/ffmpeg-core.js';

const CHUNK = 4 * 1048576;
const OUT = '/out.mp3';
const IN_DIR = '/in';

let core = null;
let buffer = new Uint8Array(CHUNK);
let filled = 0;
let written = 0;

function flush() {
  if (!filled) return;
  const piece = buffer.slice(0, filled);
  self.postMessage({ type: 'chunk', data: piece }, [piece.buffer]);
  filled = 0;
}

// The output device. ffmpeg's MP3 muxer only ever appends here, because the
// one thing it would go back to rewrite -- the Xing header at the front -- is
// turned off in the command below.
function registerOutput(FS) {
  const dev = FS.makedev(64, 0);
  FS.registerDevice(dev, {
    open() {},
    close() { flush(); },
    read() { return 0; },
    llseek(stream, offset, whence) {
      // SEEK_CUR 0 and SEEK_END 0 are how the muxer asks where it is; any
      // real move would mean rewriting bytes already sent, which cannot be.
      const at = whence === 1 ? written + offset : whence === 2 ? written + offset : offset;
      if (at !== written) throw new FS.ErrnoError(29);   // ESPIPE
      return at;
    },
    write(stream, data, offset, length) {
      let from = offset;
      let left = length;
      while (left > 0) {
        const n = Math.min(left, CHUNK - filled);
        buffer.set(data.subarray(from, from + n), filled);
        filled += n;
        from += n;
        left -= n;
        if (filled === CHUNK) flush();
      }
      written += length;
      return length;
    },
  });
  return dev;
}

let device = null;

self.onmessage = async ({ data }) => {
  if (data.type !== 'convert') return;
  const { file, bitrate, channels } = data;
  const log = [];
  try {
    if (!core) {
      try {
        core = await createFFmpegCore({});
      } catch (err) {
        // Almost always the 32 MB wasm not arriving -- offline, the first time.
        self.postMessage({ type: 'error', stage: 'load', message: String(err?.message || err) });
        return;
      }
      device = registerOutput(core.FS);
      core.FS.mkdir(IN_DIR);
    }
    const { FS } = core;
    buffer = new Uint8Array(CHUNK);
    filled = 0;
    written = 0;
    core.setLogger(({ message }) => { log.push(message); if (log.length > 40) log.shift(); });
    // time is how far into the audio ffmpeg has written, in microseconds.
    core.setProgress(({ time }) => self.postMessage({ type: 'progress', seconds: time / 1e6 }));

    FS.mount(FS.filesystems.WORKERFS, { files: [file] }, IN_DIR);
    try { FS.unlink(OUT); } catch { /* not there */ }
    FS.mkdev(OUT, 0o666, device);

    self.postMessage({ type: 'started' });
    core.setTimeout(-1);
    core.exec(
      '-i', `${IN_DIR}/${file.name}`,
      '-vn',
      '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-ac', String(channels), '-ar', '44100',
      // Folding stereo to mono adds the two sides at 0.707 each, which is
      // louder than either -- and past full scale on a loud recording. This
      // caps the sum at 1, so mono is the average and never clips.
      '-rematrix_maxval', '1.0',
      '-write_xing', '0',
      '-f', 'mp3', OUT,
    );
    const ret = core.ret;
    core.reset();
    flush();
    FS.unmount(IN_DIR);
    FS.unlink(OUT);
    if (ret !== 0) throw new Error(log.slice(-6).join('\n') || `ffmpeg stopped with code ${ret}`);
    self.postMessage({ type: 'done', bytes: written });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err), log: log.slice(-12) });
  }
};
