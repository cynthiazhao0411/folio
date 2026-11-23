// cloud.js — Automatic backup to GitHub.
//
// From v1.2.6 the backup is the backup/ folder of the private sync repository (repo.js has the
// layout). Every backup is one commit, so earlier backups stay in the repository history and
// 从云端备份恢复 can go back to any of the recent ones. Book text the repository already holds
// (from sync/ or an earlier backup) is referenced, not uploaded again.
//
// Before v1.2.6 (devices not moved yet) it uses the same token as device sync and the same data
// as the manual ZIP backup (Backup.parts), stored in two secret gists:
//   "Folio backup"          folio-backup.json            the manifest: counts, checksums, file names
//                           s-<store>-<checksum>.json    one database store
//                           local-<checksum>.json        this device's settings
//   "Folio backup · books"  b-<book id>-<checksum>.json  one book's text and chapters
// Book text sits in its own gist so the frequent small backups (progress, notes) never have to
// move it; it is uploaded only when a book changes.
// File names carry their checksum, so a new backup never overwrites a file of the previous
// one. A backup uploads only the files the gist does not have yet, then switches the manifest
// in one write, then removes files nothing points to. If anything fails before the manifest is
// switched, the previous backup is still complete and untouched; the local data is never
// changed by a backup.
//
// When it runs: a minute and a half after data changes (changes in between are gathered into
// one backup), when the app goes to the background, and when Folio is opened with changes
// that were not backed up yet. A web app cannot run while it is closed, so changes made just
// before closing are backed up the next time Folio is opened.
const CloudBackup = {
  NAME: 'Folio backup',
  BOOKS: 'Folio backup · books',
  DELAY: 90 * 1000,
  RETRY: 5 * 60 * 1000,
  st: {},                         // localStorage 'folio-cloud' (this device only)
  busy: false,
  timer: 0,

  load() { try { this.st = JSON.parse(localStorage.getItem('folio-cloud')) || {}; } catch { this.st = {}; } if (this.st.enabled === undefined) this.st.enabled = true; },
  save() { localStorage.setItem('folio-cloud', JSON.stringify(this.st)); },
  // A device still on the gists stops writing to them once another device moved the library
  get on() { return Sync.on && this.st.enabled !== false && !(Sync.st.moved && !Sync.repoMode); },

  init() {
    this.load();
    if (DEMO) return;
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.st.dirty) this.run(); });
    addEventListener('online', () => { if (this.st.dirty) this.run(); });
    // Opened with changes that were never backed up (or never backed up at all): catch up
    if (this.on && (this.st.dirty || !this.st.at)) setTimeout(() => this.run(), 8000);
  },

  // Called after every data change (from Sync.touched)
  mark() {
    if (DEMO) return;                                  // the demo shelf is never in the cloud backup
    this.st.dirty = true;
    this.st.rev = (this.st.rev || 0) + 1;
    this.save();
    this.schedule(this.DELAY);
  },
  schedule(ms) {
    if (!this.on) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = 0; this.run(); }, ms);
  },

  // The two gists, found by name (so a second device or a re-connect finds the same ones) or created.
  // Their file lists come from the gist list, which does not carry file contents.
  async gists() {
    const list = await Sync.api('/gists?per_page=100');
    const make = async name => (await Sync.api('/gists', {
      method: 'POST',
      body: JSON.stringify({ description: name, public: false, files: { 'about.txt': { content: 'Folio automatic backup. Do not edit by hand.' } } }),
    })).id;
    const find = (id, name) => list.find(g => g.id === id) || list.find(g => g.description === name);
    let main = find(this.st.gist, this.NAME), books = find(this.st.booksGist, this.BOOKS);
    if (!main) main = { id: await make(this.NAME), files: { 'about.txt': {} } };
    if (!books) books = { id: await make(this.BOOKS), files: { 'about.txt': {} } };
    this.st.gist = main.id; this.st.booksGist = books.id;
    this.save();
    return { main: main.id, books: books.id, haveMain: new Set(Object.keys(main.files || {})), haveBooks: new Set(Object.keys(books.files || {})) };
  },

  // One backup. Returns true when the cloud holds the current data.
  async run() {
    if (!this.on || this.busy) return false;
    if (!navigator.onLine) { this.fail('没有网络，联网后会自动补上'); return false; }
    this.busy = true;
    clearTimeout(this.timer);
    const startedDirty = this.st.rev || 0;
    try {
      if (Sync.repoMode) return await this.runRepo(startedDirty);
      const g = await this.gists();

      // Book text only changes when a book is imported or updated: reuse what was uploaded
      // before unless the book's own record says it changed
      const cache = this.st.books || {};
      const sig = m => m ? [m.chapterCount, m.words, (m.versions || []).length].join('|') : '';
      const parts = await Backup.parts((id, m) => {
        const c = cache[id];
        return c && c.sig === sig(m) && g.haveBooks.has(c.file) ? { hash: c.hash, chapters: c.chapters, file: c.file } : null;
      });
      const { manifest } = parts;
      const send = async (gist, list) => {           // a few files per request
        let batch = {}, size = 0;
        for (const [name, text] of list) {
          if (size && size + text.length > 4e6) { await Sync.patch(gist, batch); batch = {}; size = 0; }
          batch[name] = { content: text };
          size += text.length;
        }
        if (size) await Sync.patch(gist, batch);
      };

      // 1. Book text the books gist does not have yet
      const bookFiles = new Set(), newBooks = [];
      for (const [id, info] of Object.entries(manifest.books)) {
        info.file = info.file || `b-${id}-${info.hash}.json`;
        bookFiles.add(info.file);
        if (parts.bookText[id] && !g.haveBooks.has(info.file)) newBooks.push([info.file, parts.bookText[id]]);
      }
      await send(g.books, newBooks);

      // 2. The manifest, the stores and the settings in one write: from this moment the new
      //    backup is the one that counts (until then the previous one is complete and untouched)
      manifest.files = {
        stores: Object.fromEntries(Object.keys(parts.storeText).map(n => [n, `s-${n}-${manifest.stores[n].hash}.json`])),
        local: `local-${manifest.local.hash}.json`,
      };
      manifest.summary = Backup.summarize(parts.stores, []);
      manifest.summary.chapters = Object.values(manifest.books).reduce((n, b) => n + (b.chapters || 0), 0);
      const mainFiles = [['folio-backup.json', JSON.stringify(manifest, null, 1)]];
      for (const n in parts.storeText) if (!g.haveMain.has(manifest.files.stores[n])) mainFiles.push([manifest.files.stores[n], parts.storeText[n]]);
      if (!g.haveMain.has(manifest.files.local)) mainFiles.push([manifest.files.local, parts.localText]);
      if (mainFiles.reduce((n, f) => n + f[1].length, 0) > 9e6) {
        await send(g.main, mainFiles.slice(1));      // very large stores: parts first, the manifest last
        await Sync.patch(g.main, { 'folio-backup.json': { content: mainFiles[0][1] } });
      } else {
        await Sync.patch(g.main, Object.fromEntries(mainFiles.map(([n, t]) => [n, { content: t }])));
      }

      // 3. Tidy up: files of earlier backups that nothing points to any more (failure is harmless)
      const keepMain = new Set(['folio-backup.json', 'about.txt', manifest.files.local, ...Object.values(manifest.files.stores)]);
      const oldMain = [...g.haveMain].filter(n => !keepMain.has(n));
      const oldBooks = [...g.haveBooks].filter(n => n !== 'about.txt' && !bookFiles.has(n));
      try {
        if (oldMain.length) await Sync.patch(g.main, Object.fromEntries(oldMain.map(n => [n, null])));
        if (oldBooks.length) await Sync.patch(g.books, Object.fromEntries(oldBooks.map(n => [n, null])));
      } catch { /* the next backup retries */ }

      this.st.books = Object.fromEntries(Object.entries(manifest.books).map(([id, b]) => [id, { ...b, sig: sig(parts.stores.meta?.find(m => m.id === id)) }]));
      Object.assign(this.st, { at: Date.now(), error: null, summary: manifest.summary });
      if ((this.st.rev || 0) === startedDirty) this.st.dirty = false;   // changed meanwhile: stay dirty, run again
      this.save();
      if (this.st.dirty) this.schedule(this.DELAY);
      return true;
    } catch (e) {
      console.warn('cloud backup:', e);
      this.fail(e instanceof TypeError ? '连不上 GitHub（网络问题），联网后会自动补上' : e.message);
      return false;
    } finally {
      this.busy = false;
    }
  },
  // A backup into backup/ of the repository, in one commit
  async runRepo(startedDirty) {
    const cache = this.st.repoBooks || {};               // book id → { sig, entry } of the last backup
    const sig = m => m ? [m.chapterCount, m.words, (m.versions || []).length].join('|') : '';
    const metaOf = new Map((await DB.allMeta()).map(m => [m.id, m]));
    const synced = Sync.remote?.books || {}, hashes = Sync.st.hashes || {}, pending = new Set(Sync.st.pending || []);
    const src = await Repo.dbSource(id => {
      const c = cache[id];
      if (c && c.sig === sig(metaOf.get(id))) return c.entry;
      const e = synced[id];                            // the same text is already in sync/
      return e && hashes[id] === e.h && !pending.has(id) ? e : null;
    });
    const snap = await Repo.build(src);
    const local = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!Backup.DEVICE_ONLY.test(k)) local[k] = localStorage.getItem(k);
    }
    const ltext = JSON.stringify(local), lh = Backup.hash(ltext);
    const lent = { f: 'local.json', h: lh, s: await Repo.gitSha(new TextEncoder().encode(ltext)) };
    snap.files.set('local.json', { ...lent, text: ltext });
    const summary = Backup.summarize(src.stores, []);
    summary.chapters = Object.values(snap.manifest.books).reduce((n, b) => n + (b.chapters || 0), 0);
    Object.assign(snap.manifest, { kind: 'backup', device: Sync.st.device, local: [lent], summary,
      appVersion: document.querySelector('.app-version')?.textContent.replace(/^\D+/, '') || '' });
    try {
      await Repo.save('backup', snap, `backup: ${summary.books} books · ${Sync.st.device}`);
    } catch (e) {
      if (e.missing) this.st.repoBooks = {};             // the next backup uploads the book text again
      throw e;
    }
    this.st.repoBooks = Object.fromEntries(Object.entries(snap.manifest.books).map(([id, b]) => [id, { sig: sig(metaOf.get(id)), entry: b }]));
    Object.assign(this.st, { at: Date.now(), error: null, summary });
    if ((this.st.rev || 0) === startedDirty) this.st.dirty = false;
    this.save();
    if (this.st.dirty) this.schedule(this.DELAY);
    return true;
  },

  // Recent backups in the repository history, newest first
  async history() {
    const list = await Repo.api(`/commits?path=backup/manifest.json&sha=${encodeURIComponent(Repo.branch)}&per_page=20`);
    return list.map(c => ({ sha: c.sha, at: Date.parse(c.commit.committer?.date || c.commit.author?.date), message: c.commit.message }));
  },
  async readRepo(ref) {
    const manifest = await Repo.manifest('backup', ref);
    if (!manifest || manifest.kind !== 'backup') throw new Error('云端还没有备份');
    const data = await Repo.read(manifest, { local: await Repo.localTexts() });
    const ltext = (await Promise.all(manifest.local.map(e => Repo.text(e)))).join('');
    return { manifest, stores: data.stores, books: data.books, local: JSON.parse(ltext) };
  },

  fail(msg) {
    this.st.error = msg;
    this.save();
    this.schedule(this.RETRY);                       // the previous cloud backup stays as it was
  },

  // The latest cloud backup, in the same shape as Backup.read(), ready for Backup.apply()
  async read(ref) {
    if (Sync.repoMode) return this.readRepo(ref);
    const g = await this.gists();
    const main = await Sync.api('/gists/' + g.main);
    const mtext = await Sync.fileText(main.files['folio-backup.json']);
    if (!mtext) throw new Error('云端还没有备份');
    const manifest = JSON.parse(mtext);
    const books = await Sync.api('/gists/' + g.books);
    const part = async (gist, name, want) => {
      const text = await Migrate.gistText(gist, name);   // also past the 300 files a gist lists
      if (text == null) throw new Error('云端备份缺少 ' + name);
      if (want && Backup.hash(text) !== want) throw new Error(name + ' 校验不一致');
      return Backup.unpack(JSON.parse(text));
    };
    const stores = {}, list = [];
    for (const [name, info] of Object.entries(manifest.stores)) {
      stores[name] = await part(main, manifest.files.stores[name], info.hash);
      if (stores[name].length !== info.count) throw new Error(`「${name}」数量不对`);
    }
    for (const info of Object.values(manifest.books)) list.push(await part(books, info.file, info.hash));
    const local = await part(main, manifest.files.local, manifest.local.hash);
    return { manifest, stores, books: list, local };
  },

  async openPanel() {
    const s = quickSheet(`
      <div class="pk-title">云端自动备份<small>${Sync.repoMode ? '存在你的私有仓库 ' + esc(Sync.st.repo) + ' 里' : '存在你自己 GitHub 账号下的秘密 Gist 里'}</small></div>
      <p class="sync-note">${esc(this.summary())}${this.st.summary ? '<br>' + esc(Backup.describe(this.st.summary)).replace(/\n/g, '<br>') : ''}</p>
      <div class="pk-list">
        <button class="pk-row" data-a="now"><span>立即备份</span></button>
        <button class="pk-row" data-a="restore"><span>从云端备份恢复</span><small>先检查，再选合并或替换</small></button>
        <button class="pk-row" data-a="toggle"><span>${this.st.enabled === false ? '打开自动备份' : '关闭自动备份'}</span></button>
      </div>
      <p class="sync-note">数据有改动后约一分半钟自动备份，切到后台时也会备份。Folio 关着的时候不会运行，没来得及备份的改动会在下次打开时补上。</p>`);
    s.card.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      await s.close();
      if (a === 'now') {
        toast('正在备份…');
        toast(await this.run() ? '云端备份完成' : '没有备份成功：' + this.st.error);
      } else if (a === 'restore') {
        let ref;
        if (Sync.repoMode) {                          // pick one of the recent backups
          let list;
          try { list = await this.history(); } catch (err) { return dialog({ title: '无法读取云端备份', message: err.message, ok: '好' }); }
          if (!list.length) return dialog({ title: '云端还没有备份', message: '', ok: '好' });
          ref = await new Promise(resolve => {
            const p = quickSheet(`<div class="pk-title">选一个备份<small>最新的在最上面</small></div>
              <div class="pk-list">${list.map((c, i) => `<button class="pk-row" data-i="${i}"><span>${esc(fmtTime(c.at))}${i ? '' : ' · 最新'}</span><small>${esc(c.message.replace(/^backup: /, '').replace(' books', ' 本'))}</small></button>`).join('')}</div>`);
            p.card.onclick = async ev => { const r = ev.target.closest('[data-i]'); if (!r) return; await p.close(); resolve(list[+r.dataset.i].sha); };
            p.root.addEventListener('click', ev => { if (ev.target === p.root) resolve(null); });
          });
          if (!ref) return;
        }
        toast('正在读取云端备份…');
        let data;
        try { data = await this.read(ref); } catch (err) { return dialog({ title: '无法读取云端备份', message: err.message, ok: '好' }); }
        restoreFlow(data);
      } else if (a === 'toggle') {
        this.st.enabled = this.st.enabled === false;
        this.save();
        if (this.on && this.st.dirty) this.schedule(2000);
        toast(this.st.enabled ? '已打开自动备份' : '已关闭自动备份（手动 ZIP 备份不受影响）');
      }
    };
  },

  summary() {
    if (!Sync.on) return '连接设备同步后可用';
    if (Sync.st.moved && !Sync.repoMode) return '已暂停：先在「设备同步」里升级到私有仓库';
    if (this.st.enabled === false) return '已关闭';
    if (this.busy) return '正在备份…';
    if (this.st.error) return `没有备份成功：${this.st.error}${this.st.at ? ' · 上次成功 ' + fmtTime(this.st.at) : ''}`;
    if (this.st.dirty) return '有新的改动，稍后自动备份' + (this.st.at ? ' · 上次 ' + fmtTime(this.st.at) : '');
    return this.st.at ? '已备份 · ' + fmtTime(this.st.at) : '还没有备份';
  },
};
