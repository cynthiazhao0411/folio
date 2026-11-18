// db.js — Minimal IndexedDB wrapper. Books persist across reloads and app restarts.
// Object stores:
//   meta     book metadata + reading progress (small; all the library view needs)
//   contents chapter bodies (large; loaded only when a book is opened)
//   notes    bookmarks, highlights and notes (indexed by bookId)
//   daily    reading time per day per book: { key: 'YYYY-MM-DD|bookId', date, bookId, ms }
//   sessions one record per time a book is opened: { id, bookId, start, end, ms, from, to }
//            (from / to = { ch, frac, pct }) — the source for history, the calendar and year reviews
//   snapshots copies of the data taken right before a database upgrade (never synced)
//
// Upgrades only ever add stores and fields; nothing is deleted. Each upgrade first copies
// the existing records into `snapshots`, inside the same transaction, so a failed or
// faulty migration can always be undone.
// Every store except contents is synced as one snapshot; contents are synced per book.
const DB = {
  _db: null,
  onWrite: null,          // set by sync.js: called with (storeName) after every successful write

  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('folio', 4);
      req.onupgradeneeded = e => {            // runs on first launch and when the version number goes up
        const db = req.result, tx = req.transaction, has = n => db.objectStoreNames.contains(n);
        const old = e.oldVersion;
        if (!has('meta')) db.createObjectStore('meta', { keyPath: 'id' });
        if (!has('contents')) db.createObjectStore('contents', { keyPath: 'id' });
        if (!has('notes')) db.createObjectStore('notes', { keyPath: 'id' }).createIndex('bookId', 'bookId');
        if (!has('daily')) db.createObjectStore('daily', { keyPath: 'key' });
        if (!has('sessions')) {
          const s = db.createObjectStore('sessions', { keyPath: 'id' });
          s.createIndex('bookId', 'bookId');
          s.createIndex('start', 'start');
        }
        if (!has('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
        if (old > 0) DB.migrate(tx, old);
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
      tx.oncomplete = () => {
        if (mode === 'readwrite') this.onWrite?.(store, fn._id);
        resolve(req && req.result);
      };
      tx.onerror = () => reject(tx.error);
    });
  },

  // Data migrations, run inside the upgrade transaction (all or nothing)
  migrate(tx, from) {
    const meta = tx.objectStore('meta'), notes = tx.objectStore('notes'), snaps = tx.objectStore('snapshots');
    const m = meta.getAll(), n = notes.getAll();
    n.onsuccess = () => {
      snaps.put({ id: 'before-v' + this.VERSION + '-' + Date.now(), from, at: Date.now(), meta: m.result, notes: n.result });
      if (from < 4) {
        // v4: every rating is kept as its own entry; every note keeps its history
        for (const b of m.result) {
          if (b.rating && !b.ratings) { b.ratings = [{ v: b.rating, at: b.lastReadAt || b.addedAt || Date.now() }]; meta.put(b); }
        }
        for (const a of n.result) {
          if (a.note && !a.notes) { a.notes = [{ text: a.note, at: a.updatedAt || a.createdAt || Date.now() }]; notes.put(a); }
        }
      }
    };
  },
  VERSION: 4,

  // Whole-store helpers used by sync
  async storeNames() { return [...(await this.open()).objectStoreNames]; },
  dump(store)   { return this.run(store, 'readonly', s => s.getAll()); },
  // Replace a store's whole contents in one transaction (no onWrite: this is how remote data comes in)
  async replace(store, rows) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite'), s = tx.objectStore(store);
      s.clear();
      for (const r of rows) s.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  allMeta()     { return this.run('meta', 'readonly', s => s.getAll()); },
  getMeta(id)   { return this.run('meta', 'readonly', s => s.get(id)); },
  putMeta(m)    { return this.run('meta', 'readwrite', s => s.put(m)); },
  getContent(id){ return this.run('contents', 'readonly', s => s.get(id)); },
  allContents() { return this.run('contents', 'readonly', s => s.getAll()); },
  putContent(c) { return this.run('contents', 'readwrite', Object.assign(s => s.put(c), { _id: c.id })); },
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
  putSession(s) { return this.run('sessions', 'readwrite', st => st.put(s)); },
  allSessions() { return this.run('sessions', 'readonly', st => st.getAll()); },
  async remove(id) {
    await this.run('meta', 'readwrite', s => s.delete(id));
    await this.run('contents', 'readwrite', Object.assign(s => s.delete(id), { _id: id }));
    for (const n of await this.notesFor(id)) await this.delNote(n.id);
  },
};
