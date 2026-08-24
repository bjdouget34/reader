// Generates icons/icon-192.png and icons/icon-512.png.
//
// Written by hand with zlib rather than pulling in an image library, so the
// project keeps its "no dependencies" property. Run it again if you change the
// colors:  node tools/make-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [47, 111, 79];      // matches --accent in css/app.css
const INK = [255, 255, 255];

function icon(size) {
  const px = (x, y) => (y * size + x) * 4;
  const buf = Buffer.alloc(size * size * 4);

  const r = size * 0.22;                 // corner radius
  const inside = (x, y) => {
    // Rounded square covering the full canvas.
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  // An open book: two white pages either side of a narrow gutter.
  const top = size * 0.30, bottom = size * 0.70;
  const half = size / 2;
  const gutter = size * 0.024;      // gap down the middle
  const reach = size * 0.32;        // how far each page extends outward

  const onPage = (x, y) => {
    if (y < top || y > bottom) return false;
    const dx = Math.abs(x - half);
    return dx > gutter && dx < reach;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = px(x, y);
      if (!inside(x, y)) { buf[i + 3] = 0; continue; }
      const ink = onPage(x + 0.5, y + 0.5);
      const c = ink ? INK : BG;
      buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255;
    }
  }
  return png(buf, size, size);
}

// --- minimal PNG writer -----------------------------------------------------

function png(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

// --- write ------------------------------------------------------------------

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(dir, `icon-${size}.png`);
  fs.writeFileSync(file, icon(size));
  console.log('wrote', path.relative(process.cwd(), file), fs.statSync(file).size, 'bytes');
}
