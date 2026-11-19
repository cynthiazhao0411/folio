// backup.js — Complete manual backup and one-step restore.
//
// A backup is one ZIP file (format 3):
//   manifest.json        what is inside, with a count and a checksum for every part
//   stores/<name>.json   every database store except book text: metadata (titles, authors, covers,
//                        progress, ratings, status, folders, tags, pins…), notes (highlights,
//                        bookmarks, notes), daily totals, reading sessions, prefs (empty folders…)
//                        and any store a later version adds — stores are listed, never hard-coded
//   books/<id>.json      one file per book with its full text and chapter structure
//   local.json           this device's settings (theme, font size, page turn…)
// The same split as device sync (one snapshot + one file per book), so a backup and a synced
// library are the same data in the same shape.
//
// Every backup is checked before it is offered: the ZIP is opened again and every part is read
// back and compared with the manifest. A restore is checked the same way before anything is
// written, and again afterwards. Older backups (JSON, versions 1 and 2) are still accepted.
// Before a restore writes anything, the current data is copied aside, so 撤销上次恢复 can bring
// it back.
const Backup = {
  FORMAT: 3,
  UNDO: 'undo-restore',
  // localStorage keys that belong to this device only: never backed up, never restored
  DEVICE_ONLY: /^folio-(sync|cloud|backup-at|backup-asked|collect-job)/,

  // ---------- values that JSON cannot hold (blobs, bytes, dates) ----------
  async pack(v) {
    if (v instanceof Blob) return { $folio: 'blob', type: v.type, b64: await this.b64(new Uint8Array(await v.arrayBuffer())) };
    if (v instanceof ArrayBuffer) return { $folio: 'bytes', b64: await this.b64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return { $folio: 'bytes', b64: await this.b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (v instanceof Date) return { $folio: 'date', v: v.getTime() };
    if (Array.isArray(v)) { const out = []; for (const x of v) out.push(await this.pack(x)); return out; }
    if (v && typeof v === 'object') { const out = {}; for (const k in v) out[k] = await this.pack(v[k]); return out; }
    return v;
  },
  unpack(v) {
    if (Array.isArray(v)) return v.map(x => this.unpack(x));
    if (v && typeof v === 'object') {
      if (v.$folio === 'blob') return new Blob([this.unb64(v.b64)], { type: v.type });
      if (v.$folio === 'bytes') return this.unb64(v.b64).buffer;
      if (v.$folio === 'date') return new Date(v.v);
      const out = {};
      for (const k in v) out[k] = this.unpack(v[k]);
      return out;
    }
    return v;
  },
  async b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  unb64(s) { const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
  hash(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + '.' + str.length.toString(36); },

  // ---------- what the library holds (shown before backing up and before restoring) ----------
  summarize(stores, books) {
    const meta = stores.meta || [], notes = stores.notes || [];
    const tags = new Set(meta.flatMap(m => m.userTags || []));
    const folders = new Set([...meta.map(m => m.folder).filter(Boolean),
      ...((stores.prefs || []).find(p => p.key === 'folders')?.value || [])]);
    return {
      books: meta.length,
      chapters: books.reduce((n, b) => n + (b.chapters?.length || 0), 0),
      covers: meta.filter(m => m.cover).length,
      marks: notes.filter(n => n.type !== 'bookmark').length,
      notes: notes.filter(n => n.note).length,
      bookmarks: notes.filter(n => n.type === 'bookmark').length,
      sessions: (stores.sessions || []).length,
      days: new Set((stores.daily || []).map(d => d.date)).size,
      rated: meta.filter(m => m.rating).length,
      folders: folders.size,
      tags: tags.size,
    };
  },
  describe(s) {
    return `${s.books} 本书 · ${s.chapters} 章 · ${s.covers} 张自定义封面\n`
      + `${s.marks} 处高亮（${s.notes} 条批注）· ${s.bookmarks} 个书签\n`
      + `${s.folders} 个文件夹 · ${s.tags} 个标签 · ${s.rated} 本有评分\n`
      + `${s.sessions} 次阅读记录 · ${s.days} 天的阅读时长`;
  },

  // ---------- the backup's parts (shared by the ZIP file and the cloud backup) ----------
  // Returns the manifest plus every part as text with its checksum. `skipBook(id)` may return a
  // part already known (the cloud backup uses it to avoid re-reading unchanged book text).
  async parts(skipBook) {
    const manifest = {
      app: 'folio-backup', format: this.FORMAT, db: DB.VERSION,
      appVersion: document.querySelector('.app-version')?.textContent.replace(/^\D+/, '') || '',
      createdAt: Date.now(), device: Sync.st?.device || '',
      stores: {}, books: {}, local: {},
    };
    const stores = {}, storeText = {};
    for (const name of await DB.storeNames()) {
      if (name === 'contents' || name === 'snapshots' || name === 'device') continue;
      stores[name] = await DB.dump(name);
      storeText[name] = JSON.stringify(await this.pack(stores[name]));
      manifest.stores[name] = { count: stores[name].length, hash: this.hash(storeText[name]) };
    }
    const books = [], bookText = {};
    for (const id of await DB.keys('contents')) {
      const known = skipBook?.(id, stores.meta?.find(m => m.id === id));
      if (known) { manifest.books[id] = known; continue; }
      const c = await DB.getContent(id);
      books.push(c);
      bookText[id] = JSON.stringify(await this.pack(c));
      manifest.books[id] = { hash: this.hash(bookText[id]), chapters: c.chapters?.length || 0 };
    }
    const local = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!this.DEVICE_ONLY.test(k)) local[k] = localStorage.getItem(k);
    }
    const localText = JSON.stringify(local);
    manifest.local = { count: Object.keys(local).length, hash: this.hash(localText) };
    return { manifest, stores, storeText, books, bookText, local, localText };
  },

  // ---------- export ----------
  async create() {
    const enc = new TextEncoder(), files = [];
    const { manifest, stores, storeText, books, bookText, local, localText } = await this.parts();
    for (const name in storeText) files.push({ name: `stores/${name}.json`, data: enc.encode(storeText[name]) });
    for (const id in bookText) files.push({ name: `books/${encodeURIComponent(id)}.json`, data: enc.encode(bookText[id]) });
    files.push({ name: 'local.json', data: enc.encode(localText) });
    manifest.summary = this.summarize(stores, books);
    files.unshift({ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 1)) });

    const blob = await zipDeflate(files);
    // Read the file back exactly as a restore would, and compare it with what was just saved
    const check = await this.read(blob);
    const mismatch = this.compare(check, stores, books, local);
    if (mismatch) throw new Error('备份自检没有通过：' + mismatch);
    return { blob, manifest };
  },

  // The parts read back from a backup must equal the data it was made from
  compare(got, stores, books, local) {
    for (const name in stores) {
      if (JSON.stringify(got.stores[name]) !== JSON.stringify(stores[name])) return `「${name}」内容不一致`;
    }
    const byId = new Map(got.books.map(b => [b.id, b]));
    for (const b of books) if (JSON.stringify(byId.get(b.id)) !== JSON.stringify(b)) return `《${b.id}》正文不一致`;
    if (JSON.stringify(got.local) !== JSON.stringify(local)) return '设置不一致';
    return null;
  },

  // ---------- read any backup file: ZIP (format 3) or JSON (formats 1 and 2) ----------
  async read(file) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b) {                 // "PK": a ZIP file
      const zip = await Zip.open(file);
      if (!zip.has('manifest.json')) throw new Error('这个压缩包不是 Folio 备份');
      const manifest = JSON.parse(await zip.text('manifest.json'));
      if (manifest.app !== 'folio-backup') throw new Error('这个压缩包不是 Folio 备份');
      const part = async (name, want) => {
        if (!zip.has(name)) throw new Error('备份缺少 ' + name + '，文件可能不完整');
        const text = new TextDecoder().decode(await zip.bytes(name));
        if (want && this.hash(text) !== want) throw new Error(name + ' 已损坏（校验不一致）');
        return this.unpack(JSON.parse(text));
      };
      const stores = {}, books = [];
      for (const [name, info] of Object.entries(manifest.stores)) {
        stores[name] = await part(`stores/${name}.json`, info.hash);
        if (stores[name].length !== info.count) throw new Error(`「${name}」数量不对`);
      }
      for (const [id, info] of Object.entries(manifest.books)) books.push(await part(`books/${encodeURIComponent(id)}.json`, info.hash));
      const local = zip.has('local.json') ? await part('local.json', manifest.local?.hash) : {};
      return { manifest, stores, books, local };
    }
    // Older JSON backups
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('读不出这个文件，它不是 Folio 备份'); }
    if (data.app !== 'folio') throw new Error('不是 Folio 备份文件');
    const all = data.stores || { meta: data.meta, contents: data.contents, notes: data.notes, daily: data.daily };
    const stores = {};
    for (const [k, v] of Object.entries(all)) if (Array.isArray(v) && k !== 'contents' && k !== 'snapshots') stores[k] = v;
    const local = {};
    if (data.settings) local.settings = JSON.stringify(data.settings);
    if (Array.isArray(data.folders) && data.folders.length) {        // version 2 kept empty folders outside the database
      stores.prefs = [...(stores.prefs || []).filter(p => p.key !== 'folders'), { key: 'folders', value: data.folders }];
    }
    return { manifest: { app: 'folio-backup', format: data.version || 1, createdAt: data.savedAt, device: '' }, stores, books: all.contents || [], local };
  },

  // ---------- restore ----------
  // mode 'merge': backup records are added, a record with the same id is replaced by the
  //               backup's, everything only on this device stays.
  // mode 'replace': the library becomes exactly the backup.
  async apply(data, mode) {
    const names = await DB.storeNames();
    const unknown = Object.keys(data.stores).filter(n => !names.includes(n));
    // 1. Copy the current data aside first, so the restore can be undone
    const undo = { id: this.UNDO, at: Date.now(), stores: {}, local: {} };
    for (const n of names) if (n !== 'snapshots' && n !== 'device') undo.stores[n] = await DB.dump(n);
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!this.DEVICE_ONLY.test(k)) undo.local[k] = localStorage.getItem(k); }
    await DB.run('snapshots', 'readwrite', s => s.put(undo));

    // 2. Write
    const write = { ...data.stores, contents: data.books };
    delete write.device; delete write.snapshots;                 // this device's own records never come from a backup
    for (let [name, rows] of Object.entries(write)) {
      if (!names.includes(name)) continue;
      if (mode === 'replace') { await DB.replace(name, rows); continue; }
      if (name === 'prefs') {                                    // merge list-valued prefs (folders) instead of replacing them
        const cur = new Map((await DB.dump('prefs')).map(p => [p.key, p.value]));
        rows = rows.map(p => Array.isArray(p.value) && Array.isArray(cur.get(p.key)) ? { ...p, value: [...new Set([...cur.get(p.key), ...p.value])] } : p);
      }
      await DB.putMany(name, rows);
    }
    if (mode === 'replace') {                                    // stores the backup does not have (it is older): leave empty
      for (const n of names) if (!(n in write) && n !== 'snapshots' && n !== 'device') await DB.replace(n, []);
    }
    for (const [k, v] of Object.entries(data.local || {})) if (!this.DEVICE_ONLY.test(k)) localStorage.setItem(k, v);

    // 3. Check: every record of the backup must now be in the database
    for (const [name, rows] of Object.entries(write)) {
      if (!names.includes(name) || !rows.length) continue;
      const have = new Set((await DB.keys(name)).map(String));
      const key = await DB.keyPath(name);
      const missing = rows.filter(r => !have.has(String(r[key])));
      if (missing.length) throw new Error(`恢复后「${name}」少了 ${missing.length} 条，可以点「撤销上次恢复」回到恢复前`);
    }
    // The cloud copy follows the restored library: every book's text is compared again on the next upload
    if (Sync.st) Sync.st.hashes = {};
    Sync.touched?.('restore');
    return { unknown };
  },

  async canUndo() { return !!(await DB.run('snapshots', 'readonly', s => s.get(this.UNDO))); },
  async undo() {
    const snap = await DB.run('snapshots', 'readonly', s => s.get(this.UNDO));
    if (!snap) throw new Error('没有可以撤销的恢复');
    const names = await DB.storeNames();
    for (const n of names) if (n !== 'snapshots' && n !== 'device') await DB.replace(n, snap.stores[n] || []);
    for (const [k, v] of Object.entries(snap.local || {})) localStorage.setItem(k, v);
    await DB.run('snapshots', 'readwrite', s => s.delete(this.UNDO));
    if (Sync.st) Sync.st.hashes = {};
    Sync.touched?.('restore');
  },
};

// ZIP writer with compression (the browser's own CompressionStream); crc32 comes from epub.js
async function zipDeflate(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    let data = f.data, method = 0;
    if (typeof CompressionStream !== 'undefined' && size > 256) {
      const z = new Uint8Array(await new Response(new Blob([f.data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
      if (z.length < size) { data = z; method = 8; }
    }
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, method, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, method, true); cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, size, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
