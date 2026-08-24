# Third-party code in this directory

These files are copied in unmodified so the app runs with no install step and
no network. They are not my work, and they keep their own licenses.

| File | Project | Version | License |
|---|---|---|---|
| `epub.min.js` | [epub.js](https://github.com/futurepress/epub.js) | 0.3.93 | BSD-2-Clause |
| `jszip.min.js` | [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT or GPL-3.0 |
| `pdf.min.mjs`, `pdf.worker.min.mjs` | [pdf.js](https://github.com/mozilla/pdf.js) | 6.2.108 | Apache-2.0 |
| `pdf-textlayer.css` | pdf.js (extract of `web/pdf_viewer.css`) | 6.2.108 | Apache-2.0 |
| `cmaps/` | pdf.js character maps | 6.2.108 | see `cmaps/LICENSE` |
| `standard_fonts/` | pdf.js fallback fonts | 6.2.108 | see `standard_fonts/LICENSE_FOXIT`, `LICENSE_LIBERATION` |

To refresh the pdf.js files after changing the version in `package.json`:

```bash
npm run vendor
```

`pdf-textlayer.css` is not covered by that script -- it is a hand-picked
extract. The comment at the top of the file explains how to redo it.
