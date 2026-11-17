// db.js — Minimal IndexedDB wrapper. Books persist across reloads and app restarts.
// Object stores:
//   meta     book metadata + reading progress (small; all the library view needs)
//   contents chapter bodies (large; loaded only when a book is opened)
//   notes    bookmarks, highlights and notes (indexed by bookId)
//   daily    reading time per day per book: { key: 'YYYY-MM-DD|bookId', date, bookId, ms }
const DB = {
  _db: null,

  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('folio', 3);
      req.onupgradeneeded = () => {           // runs on first launch and when the version number goes up
        const db = req.result, has = n => db.objectStoreNames.contains(n);
        if (!has('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!has('contents')) db.createObjectStore('contents', { keyPath: 'id' });
        if (!has('notes')) db.createObjectStore('notes', { keyPath: 'id' }).createIndex('bookId', 'bookId');
        if (!has('daily')) db.createObjectStore('daily', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(this._db = req.result);
      req.onerror = () => reject(req.error);
    });
  },

  // Run one request against a store and resolve when the transaction completes
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  },

  allMeta()     { return this.run('meta', 'readonly', s => s.getAll()); },
  getMeta(id)   { return this.run('meta', 'readonly', s => s.get(id)); },
  putMeta(m)    { return this.run('meta', 'readwrite', s => s.put(m)); },
  getContent(id){ return this.run('contents', 'readonly', s => s.get(id)); },
  allContents() { return this.run('contents', 'readonly', s => s.getAll()); },
  putContent(c) { return this.run('contents', 'readwrite', s => s.put(c)); },
  notesFor(bookId) { return this.run('notes', 'readonly', s => s.index('bookId').getAll(bookId)); },
  allNotes()    { return this.run('notes', 'readonly', s => s.getAll()); },
  putNote(n)    { return this.run('notes', 'readwrite', s => s.put(n)); },
  delNote(id)   { return this.run('notes', 'readwrite', s => s.delete(id)); },
  allDaily()    { return this.run('daily', 'readonly', s => s.getAll()); },
  putDaily(r)   { return this.run('daily', 'readwrite', s => s.put(r)); },
  async addDaily(date, bookId, ms) {
    const key = date + '|' + bookId;
    const rec = (await this.run('daily', 'readonly', s => s.get(key))) || { key, date, bookId, ms: 0 };
    rec.ms += ms;
    return this.putDaily(rec);
  },
  async remove(id) {
    await this.run('meta', 'readwrite', s => s.delete(id));
    await this.run('contents', 'readwrite', s => s.delete(id));
    for (const n of await this.notesFor(id)) await this.delNote(n.id);
  },
};
