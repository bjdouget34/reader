// Storage. One IndexedDB database, one object store.
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

const DB_NAME = 'my-reader';
const DB_VERSION = 1;
const STORE = 'books';

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
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
