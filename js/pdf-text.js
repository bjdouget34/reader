// Turning a PDF's pages back into running text: the part of PDF-to-EPUB that
// needs no browser, so it can be checked against real files outside one.
//
// A PDF does not know what a paragraph is. It knows where each run of text is
// drawn, in what font, at what size -- and nothing else. So everything here is
// reading the layout the way a person does:
//
//   lines        runs on one baseline, left to right. Text drawn twice on top
//                of itself (a cheap bold) is counted once.
//   furniture    page numbers and running headers, in the top or bottom 8% of
//                the page, are dropped: a number that repeats down the margin
//                of every page is not part of the book.
//   paragraphs   a line starts a new one after a bigger gap, after a line that
//                stopped short (the next line's first word would have fitted),
//                at a bullet, or where the left edge steps in or out. Checking
//                the next word, rather than a fixed margin, is what copes with
//                ragged-right text, where full lines end anywhere.
//   headings     short, unpunctuated blocks set bigger, bold, in capitals,
//                centred -- or, in a book set in one size and one font, alone
//                on a line in title case after a slightly bigger gap.
//   pictures     images are cut out where they sit, in reading order. A page
//                that is mostly a table -- lines with wide gaps in them, which
//                cannot be reflowed without scrambling -- is kept whole, as a
//                picture of the page. So is a scanned page with no text.
//
// None of this is certain, and the output says what it is: the page breaks of
// the original are kept as markers, so a reader can see where page 57 was.

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];

const BOLD = /bold|black|heavy|semibold|demibold|extrabold|ultrabold/i;
const ITALIC = /italic|oblique|[-,]it$/i;

// A bullet at the start of a line. A lone "o" counts only before a capital,
// which is how word processors write a second-level bullet.
const BULLET = /^(?:[•●▪◦‣∙○■□➢➤►◆◇✓✔]|o(?=\s+\p{Lu}))\s*/u;

// A page-number line: digits or roman numerals and little else. The same test
// the speed reader uses on PDFs.
const PAGE_NUMBER = /^[\divxlcIVXLC\s.\-–—]+$/;

// How much of the page's top and bottom counts as margin, for page numbers and
// running headers. 8% is under an inch on a letter page.
const MARGIN_BAND = 0.08;

// ------------------------------------------------------------ reading a page

// Everything this needs from one pdf.js page: its lines and where its images
// are. Coordinates are the page's own, top-left origin, in points.
export async function readPage(page, OPS) {
  const viewport = page.getViewport({ scale: 1 });
  const toView = (x, y) => viewport.convertToViewportPoint(x, y);
  const ops = await page.getOperatorList();   // also loads the fonts, for their names
  const content = await page.getTextContent();

  const fonts = new Map();
  const fontOf = (id) => {
    if (!fonts.has(id)) {
      let name = '';
      let bold = false;
      let italic = false;
      try {
        const f = page.commonObjs.get(id);
        name = String(f?.name || '').replace(/^[A-Z]{6}\+/, '');
        bold = !!(f?.bold || f?.black);
        italic = !!f?.italic;
      } catch { /* not loaded; go by nothing */ }
      fonts.set(id, { name, bold: bold || BOLD.test(name), italic: italic || ITALIC.test(name) });
    }
    return fonts.get(id);
  };

  const items = [];
  for (const it of content.items) {
    if (typeof it.str !== 'string' || !it.str) continue;
    const t = it.transform;
    const size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]);
    if (!size) continue;
    const scale = Math.hypot(t[0], t[1]) || 1;
    const [ax, ay] = toView(t[4], t[5]);
    const [bx, by] = toView(t[4] + (t[0] / scale) * it.width, t[5] + (t[1] / scale) * it.width);
    // Text running up or down the page -- a label on a chart's axis, a
    // sideways watermark -- is not part of the reading.
    if (Math.abs(by - ay) > Math.abs(bx - ax) && it.width > size) continue;
    const f = fontOf(it.fontName);
    items.push({
      str: it.str, x0: Math.min(ax, bx), x1: Math.max(ax, bx), y: (ay + by) / 2,
      size, bold: f.bold, italic: f.italic,
    });
  }

  return {
    width: viewport.width,
    height: viewport.height,
    lines: linesOf(items),
    images: imagesOf(ops, OPS, toView, viewport),
  };
}

// Where each image is drawn: the unit square an image fills, through the
// transform in force when it is painted.
function imagesOf({ fnArray, argsArray }, OPS, toView, viewport) {
  const PAINT = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]
    .filter(v => v !== undefined));
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(a?.[0]) && a[0].length === 6) ctm = mul(ctm, a[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.beginGroup) {
      stack.push(ctm);
      const m = a?.[0]?.matrix;
      if (Array.isArray(m) && m.length === 6) ctm = mul(ctm, m);
    } else if (fn === OPS.endGroup) ctm = stack.pop() || ctm;
    else if (PAINT.has(fn)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]]
        .map(([u, v]) => toView(ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]));
      const x0 = Math.max(0, Math.min(...pts.map(p => p[0])));
      const x1 = Math.min(viewport.width, Math.max(...pts.map(p => p[0])));
      const y0 = Math.max(0, Math.min(...pts.map(p => p[1])));
      const y1 = Math.min(viewport.height, Math.max(...pts.map(p => p[1])));
      if (x1 > x0 && y1 > y0) out.push({ x0, y0, x1, y1 });
    }
  }
  return out;
}

// Runs on one baseline become a line. A superscript sits a little off it, so
// the test is loose -- under half the smaller size.
export function linesOf(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const groups = [];
  for (const it of sorted) {
    let g = null;
    for (let k = groups.length - 1; k >= 0 && k >= groups.length - 3; k--) {
      const c = groups[k];
      if (Math.abs(c.y - it.y) <= Math.max(2, Math.min(c.size, it.size) * 0.45)) { g = c; break; }
    }
    if (!g) { g = { y: it.y, size: it.size, items: [] }; groups.push(g); }
    g.items.push(it);
    if (it.size > g.size) g.size = it.size;
  }
  return groups.map(makeLine).filter(Boolean);
}

function makeLine(g) {
  const items = [...g.items].sort((a, b) => a.x0 - b.x0);
  // Text drawn twice in the same place -- a fake bold, or a shadow -- once.
  const kept = [];
  for (const it of items) {
    const s = it.str.trim();
    if (s && kept.some(k => k.str.trim() === s && Math.abs(k.x0 - it.x0) < 0.5 * it.size)) continue;
    kept.push(it);
  }
  const runs = [];
  let text = '';
  let gaps = 0;
  let chars = 0;
  const bySize = new Map();
  let prev = null;
  let ink = null;        // the last run with something visible in it
  const cells = [''];    // the text between wide gaps
  for (const it of kept) {
    // Letter-spaced display type ("T A B L E") read as the word it spells.
    let s = /^\s*(?:\S ){2,}\S\s*$/.test(it.str) ? it.str.replace(/(\S) (?=\S)/g, '$1') : it.str;
    // Wide gaps are measured between visible text: pdf.js often hands over the
    // space between two table cells as a run of its own, as wide as the gap.
    if (ink && s.trim() && it.x0 - ink.x1 > 2.5 * Math.min(ink.size, it.size)) { gaps++; cells.push(''); }
    if (s.trim()) cells[cells.length - 1] += s;
    if (prev) {
      const gap = it.x0 - prev.x1;
      if (gap > 0.15 * it.size && !/\s$/.test(text) && !/^\s/.test(s)) s = ' ' + s;
    }
    if (s.trim()) ink = it;
    const b = it.bold;
    const i = it.italic;
    const last = runs[runs.length - 1];
    if (last && last.b === b && last.i === i) last.t += s;
    else runs.push({ t: s, b, i });
    text += s;
    const n = it.str.replace(/\s/g, '').length;
    chars += n;
    bySize.set(Math.round(it.size * 2) / 2, (bySize.get(Math.round(it.size * 2) / 2) || 0) + n);
    prev = it;
  }
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  const size = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || g.size;
  const inked = runs.filter(r => r.t.trim());
  return {
    y: g.y, size, text: trimmed, runs, gaps, chars, items: kept,
    // One wide gap with running text either side is two columns sharing a
    // baseline, not a row of a table: a table's cells are short.
    tabular: gaps > 1 || (gaps === 1 && cells.some(c => c.trim().length < 20)),
    x0: kept[0].x0, x1: Math.max(...kept.map(k => k.x1)),
    bold: inked.length > 0 && inked.every(r => r.b),
    italic: inked.length > 0 && inked.every(r => r.i),
  };
}

// --------------------------------------------------------- the whole book

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

// The body text's size, its line spacing, and where its lines start and end.
function measure(pages) {
  const bySize = new Map();
  for (const p of pages) for (const l of p.lines) bySize.set(l.size, (bySize.get(l.size) || 0) + l.chars);
  const body = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 12;
  const isBody = (l) => Math.abs(l.size - body) < Math.max(0.6, body * 0.06);
  const gaps = [];
  const lefts = [];
  const rights = [];
  let boldChars = 0;
  let chars = 0;
  for (const p of pages) {
    const ls = p.lines.filter(isBody);
    for (let k = 1; k < ls.length; k++) {
      const d = ls[k].y - ls[k - 1].y;
      if (d > body * 0.8 && d < body * 2.5) gaps.push(d);
    }
    for (const l of ls) { lefts.push(l.x0); rights.push(l.x1); chars += l.chars; if (l.bold) boldChars += l.chars; }
  }
  return {
    body,
    isBody,
    lineGap: median(gaps) || body * 1.2,
    left: quantile(lefts, 0.1) ?? 0,
    right: quantile(rights, 0.95) ?? 0,
    // A book set entirely in bold cannot use bold to mark its headings.
    boldIsRare: chars ? boldChars / chars < 0.4 : true,
  };
}

// Page numbers and running headers, found by repetition: the same words in
// the same margin on page after page. Digits are ignored in the comparison,
// so "Page 4 of 7" and "Page 5 of 7" count as one line.
function furniture(pages) {
  const key = (p, l) => {
    const band = l.y - l.size < p.height * MARGIN_BAND ? 't' : l.y > p.height * (1 - MARGIN_BAND) ? 'b' : null;
    return band && band + ':' + l.text.toLowerCase().replace(/\d+|\b[ivxlc]+\b/g, '#').replace(/\s+/g, ' ');
  };
  const counts = new Map();
  for (const p of pages) {
    const seen = new Set();
    for (const l of p.lines) {
      const k = key(p, l);
      if (k && !seen.has(k)) { seen.add(k); counts.set(k, (counts.get(k) || 0) + 1); }
    }
  }
  const repeated = Math.max(3, Math.ceil(pages.length * 0.15));
  return (p, l) => {
    const k = key(p, l);
    if (!k) return false;
    return PAGE_NUMBER.test(l.text) || counts.get(k) >= repeated;
  };
}

// What is on a page, in reading order: lines of text and pictures to cut out,
// or -- when the page will not reflow -- the whole page as a picture.
function layoutPage(p, isFurniture, stats) {
  const lines = p.lines.filter(l => !isFurniture(p, l));
  const area = p.width * p.height;
  const chars = lines.reduce((n, l) => n + l.chars, 0);

  // Images big enough to matter, overlapping ones merged into one picture.
  let boxes = p.images
    .filter(b => b.x1 - b.x0 >= 36 && b.y1 - b.y0 >= 36)
    .map(b => ({ ...b }));
  const inked = boxes.reduce((n, b) => n + (b.x1 - b.x0) * (b.y1 - b.y0), 0);
  if (!lines.length && !boxes.length) return { kind: 'blank' };
  if (chars < 30 && inked >= area * 0.4) return { kind: 'picture', reason: 'scan' };
  // An image under most of a page full of text is a scan with its text
  // recognised on top, or a background: the text is the content.
  boxes = boxes.filter(b => (b.x1 - b.x0) * (b.y1 - b.y0) < area * 0.8 || chars < 200);
  boxes = mergeBoxes(boxes, 6);

  // Tables: three or more lines with wide gaps inside them, close together.
  // A row whose other cells sit on a different baseline -- a name wrapped
  // over two lines beside a row of numbers -- has no gap of its own, so up to
  // two such lines may come between.
  const tabular = [];
  let run = [];
  let since = 0;
  const flush = () => { if (run.filter(l => l.tabular).length >= 3) tabular.push(run.slice(0, run.length - since)); run = []; since = 0; };
  for (const l of lines) {
    if (l.tabular) { run.push(l); since = 0; }
    else if (run.length && since < 2) { run.push(l); since++; }
    else flush();
  }
  flush();
  const tabularLines = tabular.reduce((n, r) => n + r.length, 0);
  if (lines.length >= 4 && tabularLines >= lines.length * 0.5) return { kind: 'picture', reason: 'table' };
  for (const r of tabular) {
    const top = Math.min(...r.map(l => l.y - l.size * 1.1));
    const bottom = Math.max(...r.map(l => l.y + l.size * 0.35));
    boxes.push({ x0: Math.min(stats.left, ...r.map(l => l.x0)) - 2, x1: Math.max(stats.right, ...r.map(l => l.x1)) + 2, y0: top, y1: bottom, table: true });
  }
  boxes = mergeBoxes(boxes, 2).map(b => ({
    x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(p.width, b.x1), y1: Math.min(p.height, b.y1),
  }));

  // Text inside a picture is part of the picture -- a label on a chart, the
  // cells of a table -- and would otherwise be read out twice.
  const inside = (l, b) => l.y > b.y0 && l.y - l.size * 0.5 < b.y1 && (l.x0 + l.x1) / 2 > b.x0 && (l.x0 + l.x1) / 2 < b.x1;
  const text = lines.filter(l => !boxes.some(b => inside(l, b)));
  // Reading order: column by column where the page has columns, top to
  // bottom within each. Each picture goes before the first line below it.
  const ordered = readingOrder(text, stats);
  const elements = ordered.map(l => ({ kind: 'line', top: l.y - l.size, line: l }));
  for (const b of [...boxes].sort((x, y) => x.y0 - y.y0)) {
    const at = elements.findIndex(e => e.kind === 'line' && e.top >= b.y0);
    elements.splice(at < 0 ? elements.length : at, 0, { kind: 'figure', top: b.y0, box: b });
  }
  return { kind: 'text', elements };
}

// Columns, found by the XY cut: a vertical strip no line crosses, with text
// either side of it, is a gutter, and the two sides are read one after the
// other; failing that, the widest blank band across the page splits it into
// a part above and a part below, each looked at again. So a heading across
// the full width over two columns reads heading, left, right. Each line in a
// column is told that column's edges, which is what "this line stopped short"
// has to be measured against.
function readingOrder(lines, stats) {
  const byY = (a, b) => a.y - b.y || a.x0 - b.x0;
  const cut = (group, depth) => {
    if (group.length < 6 || depth > 12) return [...group].sort(byY);
    const v = gutter(group);
    if (v) {
      for (const side of [v.left, v.right]) {
        const body = side.filter(stats.isBody);
        const use = body.length >= 3 ? body : side;
        const colLeft = quantile(use.map(l => l.x0), 0.1);
        const colRight = quantile(use.map(l => l.x1), 0.95);
        for (const l of side) { l.colLeft = colLeft; l.colRight = colRight; }
      }
      return [...cut(v.left, depth + 1), ...cut(v.right, depth + 1)];
    }
    const h = band(group, stats.lineGap * 0.6);
    if (h) return [...cut(h.top, depth + 1), ...cut(h.bottom, depth + 1)];
    return [...group].sort(byY);
  };
  return cut(lines, 0);
}

// A gutter is judged from the runs of text, not the lines: where the two
// columns happen to share a baseline, their text is gathered into one line
// that spans the gutter, and would hide it. Such a line is split at the
// gutter. The gap has to be wider than a word space (over an em of the text
// it separates), and both sides have to hold lines of real text -- a column
// of paragraph numbers, "1.1" "1.2" beside the paragraphs, is not a column.
function gutter(lines) {
  const size = median(lines.map(l => l.size));
  const spans = lines.flatMap(l => l.items.filter(it => it.str.trim()).map(it => [it.x0, it.x1]))
    .sort((a, b) => a[0] - b[0]);
  if (!spans.length) return null;
  let reach = spans[0][1];
  let best = null;
  for (let i = 1; i < spans.length; i++) {
    const gap = spans[i][0] - reach;
    if (gap >= size * 1.2 && (!best || gap > best.to - best.from)) best = { from: reach, to: spans[i][0] };
    reach = Math.max(reach, spans[i][1]);
  }
  if (!best) return null;
  const mid = (best.from + best.to) / 2;
  const left = [];
  const right = [];
  for (const l of lines) {
    if (l.x1 <= mid) left.push(l);
    else if (l.x0 >= mid) right.push(l);
    else {
      const a = makeLine({ y: l.y, size: l.size, items: l.items.filter(it => (it.x0 + it.x1) / 2 < mid) });
      const b = makeLine({ y: l.y, size: l.size, items: l.items.filter(it => (it.x0 + it.x1) / 2 >= mid) });
      if (a) left.push(a);
      if (b) right.push(b);
    }
  }
  const real = (side) => side.filter(l => l.text.length >= 12).length >= 3;
  return real(left) && real(right) ? { left, right } : null;
}

function band(lines, minGap) {
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  let best = -1;
  let size = minGap;
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i].y - sorted[i].size) - sorted[i - 1].y;
    if (gap > size) { size = gap; best = i; }
  }
  return best > 0 ? { top: sorted.slice(0, best), bottom: sorted.slice(best) } : null;
}

function mergeBoxes(boxes, pad) {
  const out = [...boxes];
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (a.x0 - pad < b.x1 && b.x0 - pad < a.x1 && a.y0 - pad < b.y1 && b.y0 - pad < a.y1) {
          out[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          out.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return out;
}

// Set in the middle of the text column, with room either side: a title, not
// a line that happens to be short (which starts at the left edge).
function isCentred(l, left, right) {
  const column = right - left;
  const leftRoom = l.x0 - left;
  const rightRoom = right - l.x1;
  return leftRoom > Math.max(l.size * 3, column * 0.12)
    && Math.abs(leftRoom - rightRoom) < Math.max(l.size * 1.5, column * 0.06);
}

// Would the first word of the next line have fitted at the end of this one?
// If so, this line ended because its paragraph did. About half an em a
// character, and a space.
function endsShort(prev, next, right) {
  const word = (next.text.match(/^\S+/) || [''])[0];
  const room = right - prev.x1;
  return room > (word.length + 1) * next.size * 0.55 + next.size * 0.5;
}

// The book as a list of blocks -- paragraphs, list items, headings, pictures
// and page markers -- from every page's lines.
export function planDocument(pages) {
  const stats = measure(pages);
  const isFurniture = furniture(pages);
  const blocks = [];
  const figures = [];
  let block = null;       // the paragraph being built, which may cross a page
  let prev = null;        // the line before, and the right edge of its page
  let prevRight = stats.right;

  // A picture that falls in the middle of a paragraph -- a table set between
  // "as a cer-" and "tified" -- waits for the paragraph to finish and goes
  // straight after it, the way an EPUB places a figure, rather than cutting
  // the sentence in two.
  let waiting = [];
  let afterFigure = false;
  const pushFigure = (page, box, whole) => {
    const id = `img${String(figures.length + 1).padStart(4, '0')}`;
    figures.push({ id, page, box, whole });
    blocks.push({ type: 'figure', id, page, whole });
  };
  const close = () => {
    if (block) blocks.push(block);
    block = null;
    for (const f of waiting) pushFigure(f.page, f.box, false);
    waiting = [];
  };
  const addFigure = (page, box, whole) => {
    close();
    pushFigure(page, box, whole);
    prev = null;
  };

  // Where each page's text stops, to tell a page that ran to its foot from one
  // left short -- which is what a chapter's last page looks like, the next
  // chapter starting over the page. A page kept as a picture ran to its foot,
  // as far as anyone can tell; a blank one did not.
  const layouts = pages.map(p => layoutPage(p, isFurniture, stats));
  const lastLine = new Map();
  layouts.forEach((layout, index) => {
    let at = -1;
    if (layout.kind === 'picture') at = 1;
    if (layout.kind === 'text') {
      const ys = layout.elements.map(e => (e.kind === 'line' ? e.line.y : e.box.y1));
      if (ys.length) at = Math.max(...ys) / pages[index].height;
    }
    lastLine.set(index + 1, at);
  });
  const foot = quantile([...lastLine.values()].filter(v => v > 0), 0.5) ?? 1;
  const endsShortPage = (n) => { const at = lastLine.get(n); return at === undefined || at < 0 || at < foot - 0.15; };

  let firstOnPage = null;
  pages.forEach((p, index) => {
    const n = index + 1;
    const layout = layouts[index];
    firstOnPage = null;
    if (layout.kind === 'blank') return;
    const pageMark = { type: 'page', n };
    if (layout.kind === 'picture') {
      close();
      blocks.push(pageMark);
      addFigure(n, null, true);
      return;
    }
    const bodyLines = layout.elements.filter(e => e.kind === 'line' && stats.isBody(e.line)).map(e => e.line);
    const right = bodyLines.length >= 5 ? quantile(bodyLines.map(l => l.x1), 0.95) : stats.right;
    const left = bodyLines.length >= 5 ? quantile(bodyLines.map(l => l.x0), 0.1) : stats.left;
    let marked = false;
    for (const e of layout.elements) {
      if (e.kind === 'figure') {
        if (block && prev?.page === n) { waiting.push({ page: n, box: e.box }); afterFigure = true; continue; }
        if (!marked) { close(); blocks.push(pageMark); marked = true; }
        addFigure(n, e.box, false);
        continue;
      }
      const line = e.line;
      const lineRight = line.colRight ?? right;
      line.centred = isCentred(line, line.colLeft ?? left, lineRight);
      const samePage = prev && prev.page === n;
      // Moving to the top of the next column is like turning a page: the gap
      // and the left edge change, and neither says a paragraph ended.
      const newColumn = samePage && line.y < prev.line.y && (line.x0 >= prev.line.x1 || line.x1 <= prev.line.x0);
      const flowing = samePage && !newColumn;
      const bullet = BULLET.test(line.text);
      let fresh = !block || bullet;
      // After a picture, the paragraph before it carries on only when the
      // sentence plainly does: it stopped without finishing, and this line
      // starts in lowercase. Otherwise the picture ended it -- "as follows:"
      // and then the diagram.
      if (!fresh && afterFigure && !(/^\p{Ll}/u.test(line.text) && !/[.!?:;"”)]$/.test(textOf(block.runs).trim()))) fresh = true;
      // Nothing runs on from a page that stopped short: that was the end of
      // something, and this is the start of the next.
      if (!fresh && !samePage && endsShortPage(prev.page)) fresh = true;
      if (!fresh && Math.abs(line.size - prev.line.size) > Math.max(0.6, prev.line.size * 0.08)) fresh = true;
      // Across a picture the gap says nothing: the picture made it.
      if (!fresh && flowing && !afterFigure) {
        const gap = line.y - prev.line.y;
        const expected = stats.lineGap * (line.size / stats.body);
        if (gap < 0 || gap > expected * 1.35) fresh = true;
      }
      // Centred lines in one style stay together -- a title set over two or
      // three lines -- and never run on from, or into, ordinary text.
      if (!fresh && line.centred !== prev.line.centred) fresh = true;
      if (!fresh && line.bold !== prev.line.bold && (line.centred || !flowing)) fresh = true;
      const together = !fresh && line.centred && prev.line.centred;
      if (!fresh && !together && endsShort(prev.line, line, prevRight)) fresh = true;
      const tol = 0.6 * line.size;
      if (!fresh && !together && flowing && block.lines.length >= 2 && Math.abs(line.x0 - prev.line.x0) > tol) fresh = true;

      if (!marked) {
        // A paragraph running on from the page before carries the marker
        // inside it, where the page turned; otherwise it stands before.
        if (fresh) { close(); blocks.push(pageMark); } else block.runs.push({ page: n });
        marked = true;
      }
      if (fresh) {
        close();
        const gapBefore = samePage ? (line.y - prev.line.y) / (stats.lineGap * (line.size / stats.body)) : null;
        block = { type: 'p', page: n, lines: [], runs: [], gapBefore, bullet, opensPage: !firstOnPage };
        firstOnPage = block;
      } else {
        joinLine(block);
      }
      const runs = line.runs.map(r => ({ ...r }));
      if (bullet && !block.lines.length) runs[0].t = runs[0].t.replace(/^\s+/, '').replace(BULLET, '');
      block.runs.push(...runs);
      block.lines.push({ ...line, right: lineRight, pageWidth: p.width });
      prev = { line, page: n };
      afterFigure = false;
      prevRight = lineRight;
    }
  });
  close();

  for (const b of blocks) if (b.opensPage) b.afterShortPage = endsShortPage(b.page - 1);

  classify(blocks, stats, vocabularyOf(pages));
  demoteContentsPages(blocks);
  return { blocks: mergeHeadings(blocks), figures, stats };
}

// Before the next line's runs go on: a space, or -- where the line ended in a
// hyphen -- nothing yet: whether that hyphen stays is settled later, by
// settleHyphens, once the whole book's words are known.
function joinLine(block) {
  const last = [...block.runs].reverse().find(r => r.t !== undefined);
  if (!last) return;
  last.t = last.t.replace(/\s+$/, '');
  // Whether the hyphen goes depends on the next line's first letter, so the
  // join is marked and settled once that line is in.
  if (/\p{L}-$/u.test(last.t)) block.runs.push({ join: true });
  else last.t += ' ';
}

const textOf = (runs) => runs.map(r => r.t ?? '').join('');

function classify(blocks, stats, vocabulary) {
  const paragraphs = blocks.filter(b => b.type === 'p');
  // Settle any word broken across lines now that what follows is known.
  settleHyphens(paragraphs, vocabulary);
  for (const b of paragraphs) b.text = textOf(b.runs).replace(/\s+/g, ' ').trim();
  const candidates = paragraphs.filter(b => !b.bullet);
  stats.namesChapters = candidates.filter(b => NUMBERED_CHAPTER.test(b.text) && headingLevel(b, stats)).length >= 3;
  for (const b of paragraphs) {
    if (b.bullet) { b.type = 'li'; continue; }
    const level = headingLevel(b, stats);
    if (level) { b.type = 'h'; b.level = level; }
  }
}

// A hyphen at the end of a line is one of two things. In a typeset book it is
// usually the typesetter's, splitting "exam-ple", and goes; in one written in
// a word processor, which does not hyphenate, it is nearly always the word's
// own, "twenty-four", and stays. The book itself says which: a word that
// appears whole somewhere else, in the middle of a line, is settled by how it
// is written there. The rest follow the majority of the ones that were
// settled -- and, with nothing to go on, the typesetter's reading, which is
// the speed reader's rule.
//
// Before anything but a lowercase letter ("Hold-" "'em", "1970-" "1975") a
// hyphen always stays.
function settleHyphens(blocks, vocabulary) {
  const joins = [];
  for (const b of blocks) {
    b.runs.forEach((r, k) => {
      if (!r.join) return;
      delete r.join;
      const before = b.runs.slice(0, k).reverse().find(x => x.t !== undefined);
      const after = b.runs.slice(k + 1).find(x => x.t !== undefined && x.t.length);
      if (!before || !after || !/-$/.test(before.t) || !/^\p{Ll}/u.test(after.t)) return;
      const head = (before.t.match(/[\p{L}\p{N}'’-]*-$/u) || [''])[0].slice(0, -1).toLowerCase();
      const tail = (after.t.match(/^[\p{L}\p{N}'’-]+/u) || [''])[0].toLowerCase();
      let drop = null;
      if (vocabulary.has(`${head}-${tail}`)) drop = false;
      else if (vocabulary.has(head + tail)) drop = true;
      joins.push({ before, drop });
    });
  }
  const settled = joins.filter(j => j.drop !== null);
  const dropMost = settled.length ? settled.filter(j => j.drop).length >= settled.length / 2 : true;
  for (const j of joins) if (j.drop ?? dropMost) j.before.t = j.before.t.slice(0, -1);
}

// Every word as the book writes it in the middle of a line, where no line
// break can have touched it.
function vocabularyOf(pages) {
  const words = new Set();
  for (const p of pages) {
    for (const l of p.lines) {
      const tokens = l.text.split(/\s+/);
      if (/-$/.test(tokens[tokens.length - 1])) tokens.pop();
      for (const t of tokens) {
        const w = t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
        if (w) words.add(w);
      }
    }
  }
  return words;
}

// Words of four letters or more that start with a capital, as a share.
function titleCase(text) {
  const words = text.split(/\s+/).filter(w => /^\p{L}{4,}/u.test(w));
  if (!words.length) return false;
  return words.filter(w => /^\p{Lu}/u.test(w)).length / words.length >= 0.7;
}

const CHAPTERISH = /^(chapter|part|book|volume|section|foreword|foreward|preface|prologue|introduction|epilogue|afterword|appendix|glossary|index|contents|acknowledg)/i;
const NUMBERED_CHAPTER = /^(chapter|part|book)\s+(\d+|[ivxlc]+\b|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)/i;

export function headingLevel(b, stats) {
  const text = b.text;
  if (!text || text.length > 160) return 0;
  const size = b.lines[0].size;
  const big = size >= stats.body * 1.12;
  const lines = b.lines.length;
  if (lines > (big || b.lines.every(l => l.centred) ? 4 : 2)) return 0;
  if (!/^[\p{Lu}\p{N}"“'‘(]/u.test(text)) return 0;           // starts lowercase: a fragment
  if (/^(\(\d+\)|\d+[.)])\s/.test(text)) return 0;             // "(1) ..." or "1. ...": a numbered item
  if (/:$/.test(text) && text.length > 60) return 0;           // a sentence leading into a list
  const bold = stats.boldIsRare && b.lines.every(l => l.bold);
  if (/[.,;!]["”’')\]]*$/.test(text)) return 0;                // a sentence, even a bold one
  if (/\?$/.test(text) && !big && !bold) return 0;
  const letters = text.replace(/[^\p{L}]/gu, '');
  const caps = letters.length >= 3 && letters.length <= 80
    && letters.replace(/[^\p{Lu}]/gu, '').length / letters.length >= 0.85;
  const centred = b.lines.every(l => l.centred);
  const spaced = lines === 1 && b.gapBefore != null && b.gapBefore >= 1.2 && text.length <= 70 && titleCase(text);
  if (!(big || bold || caps || centred || spaced)) return 0;
  // Which headings open a chapter. A book that numbers its chapters --
  // "Chapter One", "Part 2" -- says so itself, and then only those (and
  // anything set much bigger) do; the centred and capitalised headings
  // between them are sections.
  if (stats.namesChapters) return size >= stats.body * 1.3 || CHAPTERISH.test(text) ? 2 : 3;
  // Otherwise the layout decides. A heading at the top of a page, after a
  // page that stopped short, opens a chapter -- the page break before a
  // chapter is the one piece of structure nearly every book keeps. So does a
  // heading in capitals, with no numbers in it, at the very top of a page
  // (the numbers keep "TIP 23" a section), and one set much bigger.
  const major = size >= stats.body * 1.3 || (b.opensPage && b.afterShortPage)
    || (b.opensPage && caps && text.length >= 8 && !/\d/.test(text)) || CHAPTERISH.test(text);
  return major ? 2 : 3;
}

// The book's own contents page -- a list of what is in it, and no running
// text -- names every chapter once more. Its headings are not chapters, and
// left as they are they would be listed in Contents twice, opening page 1.
function demoteContentsPages(blocks) {
  const byPage = new Map();
  for (const b of blocks) {
    if (!b.page || b.type === 'page' || b.type === 'figure') continue;
    if (!byPage.has(b.page)) byPage.set(b.page, []);
    byPage.get(b.page).push(b);
  }
  for (const list of byPage.values()) {
    const items = list.filter(b => b.type === 'li').length;
    const prose = list.some(b => b.type === 'p' && b.text.length > 100);
    if (items >= 5 && !prose) for (const b of list) if (b.type === 'h') { b.type = 'p'; b.runs = b.runs.map(r => ({ ...r, b: true })); }
  }
}

// "Chapter One:" centred above "General Poker Strategy", or a title set over
// several lines, is one heading.
function mergeHeadings(blocks) {
  const out = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    // A chapter does not start twice on one page: a second chapter heading
    // there -- "LIMIT HOLD'EM POKER", a paragraph about its author, then
    // "INTRODUCTION" -- is the first section of the chapter above it.
    if (b.type === 'h' && b.level === 2 && out.some(x => x.type === 'h' && x.level === 2 && x.page === b.page)
        && !(last?.type === 'h' && last.page === b.page && (b.gapBefore == null || b.gapBefore < 1.8))) b.level = 3;
    if (b.type === 'h' && last?.type === 'h' && last.level === b.level && last.page === b.page
        && (b.gapBefore == null || b.gapBefore < 1.8)) {
      last.text = `${last.text} ${b.text}`.replace(/\s+/g, ' ');
      last.runs.push({ t: ' ' }, ...b.runs);
      continue;
    }
    out.push(b);
  }
  return out;
}

// -------------------------------------------------------------- the EPUB

const XML_SUSPECT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF￾￿]/;
export const esc = (s) => xmlSafe(String(s))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// What XML cannot hold: control characters, the two non-characters, and half
// of a surrogate pair, which a damaged PDF font can hand over. One in a
// chapter makes the whole file unreadable. Done by walking the string, not by
// a regular expression, because telling a lone half from a pair needs a
// lookbehind -- which Safari before iOS 16.4 cannot even parse, and a module
// it cannot parse does not load at all.
function xmlSafe(s) {
  if (!XML_SUSPECT.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { out += s[i] + s[i + 1]; i++; }
      continue;
    }
    if (c >= 0xDC00 && c <= 0xDFFF) continue;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0A && c !== 0x0D) || c === 0xFFFE || c === 0xFFFF) continue;
    out += s[i];
  }
  return out;
}

function runsHtml(runs) {
  let html = '';
  for (const r of runs) {
    if (r.page) { html += `<span id="page${r.page}" epub:type="pagebreak" role="doc-pagebreak" aria-label="${r.page}"></span>`; continue; }
    if (!r.t) continue;
    let t = esc(r.t);
    if (r.i) t = `<i>${t}</i>`;
    if (r.b) t = `<b>${t}</b>`;
    html += t;
  }
  return html.replace(/\s+/g, ' ').replace(/^ | $/g, '');
}

const pageDiv = (n) => `<div id="page${n}" epub:type="pagebreak" role="doc-pagebreak" aria-label="${n}"></div>`;

// Splits the blocks into chapter files at each major heading -- which is how
// the reader's Contents and its percentages work -- and keeps any one file to
// a size a phone lays out quickly.
export function chapters(blocks, { maxChars = 120000 } = {}) {
  const out = [];
  let cur = null;
  let size = 0;
  const start = (title) => {
    // The page marker just before a chapter's heading belongs to the chapter.
    const carried = [];
    while (cur && cur.blocks[cur.blocks.length - 1]?.type === 'page') carried.unshift(cur.blocks.pop());
    cur = { title, blocks: carried };
    out.push(cur);
    size = 0;
  };
  for (const b of blocks) {
    if (!cur || (b.type === 'h' && b.level === 2 && cur.blocks.some(x => x.type !== 'page'))
        || (size > maxChars && (b.type === 'page'))) {
      start(b.type === 'h' ? b.text : null);
    }
    if (b.type === 'h' && b.level === 2 && !cur.title) cur.title = b.text;
    cur.blocks.push(b);
    size += (b.text || '').length;
  }
  return out;
}

function chapterHtml(ch, title, lang, imageName) {
  const body = [];
  let list = false;
  for (const b of ch.blocks) {
    if (b.type !== 'li' && list) { body.push('</ul>'); list = false; }
    if (b.type === 'page') body.push(pageDiv(b.n));
    else if (b.type === 'h') body.push(`<h${b.level} id="${b.anchor}">${esc(b.text)}</h${b.level}>`);
    else if (b.type === 'li') {
      if (!list) { body.push('<ul>'); list = true; }
      body.push(`<li>${runsHtml(b.runs)}</li>`);
    } else if (b.type === 'figure') {
      const alt = b.whole ? `Page ${b.page}` : `Picture from page ${b.page}`;
      body.push(`<figure class="${b.whole ? 'page' : 'pic'}"><img src="../images/${imageName(b.id)}" alt="${alt}"/></figure>`);
    } else body.push(`<p>${runsHtml(b.runs)}</p>`);
  }
  if (list) body.push('</ul>');
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="../style.css"/></head>
<body>
${body.join('\n')}
</body>
</html>
`;
}

const STYLE = `body { margin: 0; }
p { margin: 0 0 0.75em; }
h2 { margin: 1.2em 0 0.8em; font-size: 1.4em; line-height: 1.25; }
h3 { margin: 1.1em 0 0.5em; font-size: 1.1em; line-height: 1.3; }
ul { margin: 0 0 0.75em; padding-left: 1.4em; }
li { margin: 0 0 0.3em; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; height: auto; }
figure.page img { width: 100%; }
`;

// A random version-4 UUID for the book's identifier. crypto.randomUUID would
// do, and is missing from Safari before iOS 15.4; getRandomValues is not.
function uuid() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// The whole EPUB, as bytes. JSZip is passed in: the browser has it as a
// global, a test has it from disk. images maps a figure's id to its JPEG.
export async function buildEpub(JSZip, { plan, title, author, lang = 'en', images, cover = null, sourceName = '',
  id = `urn:uuid:${uuid()}` }) {
  plan = { ...plan, id };
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`);
  zip.file('OEBPS/style.css', STYLE);

  const imageName = (id) => `${id}.jpg`;
  const chs = chapters(plan.blocks);
  let anchors = 0;
  const toc = [];
  const pagesAt = [];
  chs.forEach((ch, k) => {
    const file = `text/c${String(k + 1).padStart(3, '0')}.xhtml`;
    ch.file = file;
    for (const b of ch.blocks) {
      if (b.type === 'h') {
        b.anchor = `h${++anchors}`;
        toc.push({ level: b.level, text: b.text, href: `${file}#${b.anchor}` });
      }
      if (b.type === 'page') pagesAt.push({ n: b.n, href: `${file}#page${b.n}` });
      if (b.runs) for (const r of b.runs) if (r.page) pagesAt.push({ n: r.page, href: `${file}#page${r.page}` });
    }
  });
  chs.forEach((ch, k) => {
    const name = ch.title || (k === 0 ? title : `${title} (${k + 1})`);
    zip.file(`OEBPS/${ch.file}`, chapterHtml(ch, name, lang, imageName));
  });

  const manifestImages = [];
  for (const [id, bytes] of images) {
    zip.file(`OEBPS/images/${imageName(id)}`, bytes);
    manifestImages.push(`<item id="${id}" href="images/${imageName(id)}" media-type="image/jpeg"/>`);
  }
  if (cover) {
    zip.file('OEBPS/images/cover.jpg', cover);
    manifestImages.push('<item id="cover-image" href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"/>');
  }

  // Contents: the major headings, with the minor ones under each. A book with
  // no headings found gets its chapter files, named by the pages they hold.
  let entries = toc;
  if (!entries.some(e => e.level === 2)) {
    entries = chs.map((ch) => {
      const pages = ch.blocks.filter(b => b.type === 'page').map(b => b.n);
      const label = pages.length ? (pages.length > 1 ? `Pages ${pages[0]}–${pages[pages.length - 1]}` : `Page ${pages[0]}`) : title;
      return { level: 2, text: label, href: ch.file };
    }).concat(toc.map(e => ({ ...e, level: 3 })));
    entries.sort((a, b) => chs.findIndex(c => a.href.startsWith(c.file)) - chs.findIndex(c => b.href.startsWith(c.file)));
  }
  const navList = [];
  let open = false;
  for (const e of entries) {
    const link = `<a href="${e.href}">${esc(e.text)}</a>`;
    if (e.level === 2) {
      if (open) navList.push('</ol></li>');
      navList.push(`<li>${link}<ol>`);
      open = true;
    } else if (open) navList.push(`<li>${link}</li>`);
    else navList.push(`<li>${link}</li>`);
  }
  if (open) navList.push('</ol></li>');
  const navHtml = navList.join('\n').replace(/<ol>\n<\/ol><\/li>/g, '</li>');
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${navHtml || `<li><a href="${chs[0]?.file || ''}">${esc(title)}</a></li>`}
</ol></nav>
<nav epub:type="page-list" hidden=""><ol>
${pagesAt.map(p => `<li><a href="${p.href}">${p.n}</a></li>`).join('\n')}
</ol></nav>
</body>
</html>
`);

  // An NCX as well, for older readers; the same entries, flattened.
  const flat = entries.length ? entries : [{ text: title, href: chs[0]?.file || '' }];
  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${esc(plan.id)}"/></head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${flat.map((e, k) => `<navPoint id="n${k + 1}" playOrder="${k + 1}"><navLabel><text>${esc(e.text)}</text></navLabel><content src="${e.href}"/></navPoint>`).join('\n')}
</navMap>
</ncx>
`);

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${esc(plan.id)}</dc:identifier>
<dc:title>${esc(title)}</dc:title>
${author ? `<dc:creator>${esc(author)}</dc:creator>` : ''}
<dc:language>${lang}</dc:language>
<dc:source>${esc(sourceName)}</dc:source>
<meta property="dcterms:modified">${modified}</meta>
${cover ? '<meta name="cover" content="cover-image"/>' : ''}
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="style" href="style.css" media-type="text/css"/>
${chs.map((ch, k) => `<item id="c${k + 1}" href="${ch.file}" media-type="application/xhtml+xml"/>`).join('\n')}
${manifestImages.join('\n')}
</manifest>
<spine toc="ncx">
${chs.map((_, k) => `<itemref idref="c${k + 1}"/>`).join('\n')}
</spine>
</package>
`);

  return zip.generateAsync({ type: 'uint8array', mimeType: 'application/epub+zip', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
