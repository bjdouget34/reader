// Storage. One IndexedDB database, two object stores.
//
// A book record looks like:
//   {
//     id,        // fingerprint of the file bytes
//     format,    // 'epub' | 'pdf'
//     title, author,
//     file,      // the raw file bytes, so a book never needs the network again
//     cover,     // Blob, or null
//     added, lastRead,
//     position,  // epub: a CFI string. pdf: a page number.
//     percent,   // 0-100, for the library progress bar
//     locations, // epub only: cached epub.js locations index
//     highlights,// [{ id, anchor, text, color, created }] where anchor is
//                //   { cfi } for an epub or { page, rects } for a pdf, rects
//                //   being fractions of the page so they hold at any zoom
//   }
//
// An audiobook lives in a store of its own, keyed by the book it belongs to:
//   { bookId, tracks: [{ name, type, size, duration, blob }], added }
//
// Separate on purpose. Listing the library reads every book record whole, and
// an audiobook is hundreds of megabytes; kept on the book record it would be
// hauled in just to draw the covers.

const DB_NAME = 'my-reader';
// 2 added the audio store. Opening a version-1 database upgrades it in place:
// the books are untouched, and the new store starts empty.
const DB_VERSION = 2;
const STORE = 'books';
const AUDIO = 'audio';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(AUDIO)) {
        db.createObjectStore(AUDIO, { keyPath: 'bookId' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer copy of the app open in another tab needs this connection out
      // of the way to upgrade; holding on to it would leave that tab waiting.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn, store = STORE) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    req.onsuccess = () => resolve(req.result);
  }));
}

export const db = {
  all: () => tx('readonly', s => s.getAll()),
  get: (id) => tx('readonly', s => s.get(id)),
  put: (record) => tx('readwrite', s => s.put(record)),
  remove: (id) => tx('readwrite', s => s.delete(id)),

  // Merge a few fields into an existing record without rewriting the file bytes.
  async patch(id, fields) {
    const record = await this.get(id);
    if (!record) return null;
    Object.assign(record, fields);
    await this.put(record);
    return record;
  },
};

export const audioDb = {
  get: (bookId) => tx('readonly', s => s.get(bookId), AUDIO),
  put: (record) => tx('readwrite', s => s.put(record), AUDIO),
  remove: (bookId) => tx('readwrite', s => s.delete(bookId), AUDIO),
  // Which books have one, without reading a byte of audio -- for the badges.
  ids: () => tx('readonly', s => s.getAllKeys(), AUDIO),
};

// Ask the browser to keep what is stored here rather than clearing it when the
// device runs short of space. Books are a few megabytes and were never at much
// risk; an audiobook is the sort of thing that gets evicted first. The browser
// may say no, and nothing here depends on the answer.
export async function keepStorage() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}

// A stable id derived from the file contents, so re-adding the same book
// updates the existing entry (and keeps your place) instead of duplicating it.
export async function fingerprint(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash).slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Roughly how much room the books are taking, for the library footer.
export async function usage() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}
