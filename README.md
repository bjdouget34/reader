# Reader

A small ebook reader for EPUB and PDF that runs in a browser, stores books on
the device, and remembers where you left off. Built to work with no connection.

There is no build step and no framework. Edit a file, refresh the page, see the
change. That is the whole point of the design.

## Running it

```bash
npm start
```

Then open <http://localhost:8080>. A plain `file://` page cannot register a
service worker or load ES modules, which is why there is a small server.

`npm start` needs nothing installed — `serve.js` uses only Node's standard
library. The `node_modules` directory here exists solely to re-vendor pdf.js
(`npm run vendor`) and is not needed to run or use the app.

## What it does

- Add `.epub` and `.pdf` files. They are copied into the browser's IndexedDB,
  so a book never needs the network again.
- Remembers your place. For EPUB that is a CFI, an exact pointer into the text
  that survives font-size changes. For PDF it is the page number.
- Library with covers and progress, most recently read first.
- Light, sepia, and dark themes. PDFs are theme-shifted with a CSS filter.
- Text size for EPUB, zoom for PDF. Both remembered.
- Table of contents where the book has one.
- **Selectable PDF text.** pdf.js draws an invisible text layer over the page
  image, aligned to the pixel, so you can select and copy. Scanned PDFs have no
  text in them, so there is nothing to select on those.
- **EPUB highlights** in four colours. Select text, pick a colour. Highlights
  are stored with the book, redrawn when you reopen it, and listed in the
  Highlights panel -- click one to jump straight to it. Click a highlight in the
  text to recolour or remove it.
- **Search inside a book**, EPUB or PDF. `Ctrl+F` (or the Search button) opens
  the panel; results stream in as the scan runs, with the match highlighted in
  each excerpt and a page number for PDFs. Click a result to jump there.
  Closing the panel cancels a scan in progress.
- Page turns: click the arrows, press the arrow keys, or swipe / tap the left
  and right edges on a touch screen.
- `Esc` closes the toolbar, then the drawers, then returns to the library.

## Putting it on a tablet

The app is static files, so any HTTPS host works — GitHub Pages is the usual
choice. Push the folder, enable Pages, open the URL on the tablet, and use
"Add to Home screen". It then launches without browser chrome and works offline.

HTTPS is not optional: service workers, and therefore offline use, are refused
on plain `http://` for anything except `localhost`. Serving this from your PC's
LAN address will load but will not cache for offline.

Books do not sync. They live in whichever browser you added them to, so a book
you want on the plane has to be added on the tablet.

## One thing to check yourself

Offline caching could not be verified in the browser used to build this, which
blocks service worker registration entirely — even a one-line worker fails
there. Everything else in the list above was tested and works. To confirm
offline works for you, load the app in Chrome or Edge, then in DevTools:

- Application → Service Workers should show `sw.js` as activated
- Application → Cache Storage should list `my-reader-v2` with ~31 entries
- Tick Network → Offline and reload; the app and your books should still open

If registration fails, the console message says why.

## Layout

| File | What lives there |
|---|---|
| `index.html` | Both screens: library and reader |
| `css/app.css` | Everything visual. Theme colors are the tokens at the top |
| `js/app.js` | Library grid, importing, the reader's buttons |
| `js/db.js` | IndexedDB. One store, one record per book |
| `js/reader.js` | Chooses an engine, and owns saving your position |
| `js/epub-engine.js` | EPUB, via epub.js |
| `js/pdf-engine.js` | PDF, via pdf.js |
| `js/settings.js` | Theme and size preferences, palettes, highlight colours |
| `sw.js` | Offline cache |
| `serve.js` | The local server |
| `tools/make-icons.js` | Regenerates the app icons |
| `lib/` | Vendored epub.js, JSZip, pdf.js. Committed on purpose |
| `lib/pdf-textlayer.css` | Text layer rules copied from pdf.js. Do not hand-edit |

Both engines expose the same shape — `next`, `prev`, `goto`, `setTheme`,
`setScale`, `scaleLabel`, `destroy`, plus a `capabilities` object — so `app.js`
never checks which format is open, it asks what the engine can do. If you add a
third format, match that interface and the UI comes free.

## Changing things

A few starting points, roughly easiest first:

- **A new theme.** Add a block to `css/app.css` next to the others, an entry in
  `THEMES` in `js/settings.js`, and a button in `index.html`.
- **Remember the last book and reopen it on launch.** The record already has
  `lastRead`; open the newest one at the end of `js/app.js`.
- **A note attached to a highlight.** The record already carries a `text` field
  per highlight; add a `note` beside it and a textarea in the toolbar.
- **Export your highlights.** They are plain objects in IndexedDB, so this is a
  loop and a `Blob` download.
- **Cache the extracted text per book** so repeat searches are instant. Search
  currently re-parses every section or page each time, which is fast enough on
  these books but is pure repeated work.
- **Search across the whole library** rather than one book at a time. That
  really wants the text cache above first.
- **Sync between devices.** The honest answer is that this needs a server, and
  it is a much bigger job than everything above.

## Known edges

- DRM-protected files will not open. Nothing here can change that. Books from
  Kindle, Apple Books and Google Play are encrypted and locked to those apps.
- Highlighting is EPUB-only. A PDF has no text to mark up -- only coordinates --
  so highlights there mean drawing boxes, which is a separate job. The
  Highlights button is disabled while a PDF is open.
- Scanned PDFs hold page images rather than text, so on those there is nothing
  to select and nothing to find. Both sample PDFs here turned out to be real
  text throughout, cover page aside.
- Search stops at 300 matches per book. A common word hits that instantly, and
  the panel says so; a longer phrase is the answer. Each search re-reads the
  book, so a broad term on a 450-page PDF takes a second or two.
- Very large PDFs render a page at a time, so page turns on a slow tablet are
  not instant. `MAX_CANVAS_PIXELS` in `js/pdf-engine.js` caps memory use.
- A PDF with no outline shows no contents button. That is the file, not a bug.
- Twice during development a book failed to open on the first try and hung on a
  blank page, in a browser that was also failing at unrelated things. It did not
  recur across many later attempts, including cold starts. `js/reader.js` now
  caps the wait at 30 seconds and reports it rather than hanging, so if you ever
  see "took too long to open", that is this.
- The generated icons are deliberately plain. `npm run icons` after editing
  `tools/make-icons.js`.
