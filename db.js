// db.js — Minimal IndexedDB wrapper. Books persist across reloads and app restarts.
// Two object stores:
//   meta     book metadata + reading progress (small; all the library view needs)
//   contents chapter bodies (large; loaded only when a book is opened)
const DB = {
  _db: null,

  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('folio', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('meta', { keyPath: 'id' });
        req.result.createObjectStore('contents', { keyPath: 'id' });
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
  async remove(id) {
    await this.run('meta', 'readwrite', s => s.delete(id));
    await this.run('contents', 'readwrite', s => s.delete(id));
  },
};
