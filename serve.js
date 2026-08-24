// Tiny static server for local use:  node serve.js
//
// A plain file:// page cannot register a service worker or load ES modules,
// so the app needs to be served over http. localhost counts as a secure
// context, which is why offline caching works here without any certificate.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',   // pdf.js will not load without this
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.epub': 'application/epub+zip',
  '.pdf': 'application/pdf',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.bcmap': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, url === '/' ? 'index.html' : url);

  // Never serve anything outside the project directory.
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(file, (err, stat) => {
    // A directory request (including the manifest's start_url of ".") serves
    // the index page inside it.
    if (!err && stat.isDirectory()) {
      file = path.join(file, 'index.html');
      stat = fs.existsSync(file) ? fs.statSync(file) : null;
      err = stat ? null : new Error('no index');
    }
    if (err || !stat) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      // The service worker handles offline; the browser should not also hold
      // stale copies while you are editing.
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, () => {
  console.log(`Reader running at http://localhost:${PORT}`);
  console.log('Stop with Ctrl+C.');
});
