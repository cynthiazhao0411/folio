// sync.js — Keeps the phone and the computer on the same library.
//
// From v1.2.6 the library lives in a private GitHub repository (see repo.js), reached with a
// fine-grained personal access token limited to that repository (Contents: read and write).
// Devices set up before v1.2.6 keep using the secret gists described below until they are
// moved over with 升级到私有仓库 (migrate.js); the gists are never deleted by Folio.
//
// Model: the whole library is one snapshot and the side that changed last wins.
// Nothing is merged, so there are never half-merged records.
// Repository: sync/ holds the snapshot, inbox/ the bookmark inbox (repo.js has the layout).
// Gists (before v1.2.6):
//   index gist  folio.json      { app, v, updatedAt, device, stores: { name: rows }, contents: { bookId: hash } }
//   books gist  book-<id>.json  { id, chapters }  (one file per book, uploaded only when it changes)
//   inbox gist  in-*.html       works sent from a site by the 收书 bookmark (collector.js);
//               library.json    what the bookmark needs to spot new chapters: [{ w, c, t, done }]
// Keeping book text in its own gist means the frequent index updates stay small.
const Sync = {
  API: 'https://api.github.com',
  INDEX: 'Folio sync · index',
  BOOKS: 'Folio sync · books',
  INBOX: 'Folio sync · inbox',
  PUSH_DELAY: 60 * 1000,      // after a local change, upload at most once a minute
  st: {},                     // persisted state (localStorage 'folio-sync')
  busy: false,
  applying: false,            // true while remote data is written locally (those writes are not local changes)
  waiting: false,             // a newer remote arrived while a book was open; pull once it is closed
  rev: 0,                     // bumps on every local write, to notice writes made during an upload
  timer: 0,

  // ---------- state ----------
  load() { try { this.st = JSON.parse(localStorage.getItem('folio-sync')) || {}; } catch { this.st = {}; } },
  save() { localStorage.setItem('folio-sync', JSON.stringify(this.st)); },
  get repoMode() { return !!this.st.repo; },
  get on() { return !!(this.st.token && (this.st.repo || (this.st.index && this.st.books))); },
  useRepo() { Repo.use({ token: this.st.token, repo: this.st.repo, branch: this.st.branch }); },
  remote: null,               // the last sync manifest read from the repository

  init() {
    this.load();
    if (this.repoMode) this.useRepo();
    if (!this.st.device) {
      this.st.device = /iPhone|iPad|Android/i.test(navigator.userAgent) ? '手机' : '电脑';
      this.save();
    }
    DB.onWrite = (store, id) => this.touched(store, id);
    document.addEventListener('visibilitychange', () => this.check());   // leaving: upload; returning: look for news
    addEventListener('online', () => this.check());
    this.check();
  },

  // Called after every local database write
  touched(store, id) {
    if (store === 'device' || store === 'snapshots') return;     // this device's own records: neither synced nor backed up
    if (typeof CloudBackup !== 'undefined') CloudBackup.mark(); // any change, local or pulled, goes into the cloud backup
    if (this.applying) return;
    this.rev++;
    this.st.dirty = true;
    this.st.localAt = Date.now();
    if (store === 'contents' && id && !(this.st.pending || []).includes(id)) {
      this.st.pending = [...(this.st.pending || []), id];
    }
    this.save();
    if (!this.on || this.timer) return;
    this.timer = setTimeout(() => { this.timer = 0; this.check(); }, this.PUSH_DELAY);
  },

  // ---------- GitHub ----------
  // ---------- GitHub gists (devices not moved to a repository yet, and reading the old gists) ----------
  async api(path, opts = {}, token = this.st.legacy?.token || this.st.token) {
    const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.API + path, { ...opts, headers, cache: 'no-store' });
    if (res.status === 401) throw new Error('令牌无效或已过期');
    if (res.status === 403 || res.status === 404) throw new Error('令牌没有 Gist 权限，或同步数据已被删除');
    if (!res.ok) throw new Error('GitHub 返回 ' + res.status);
    return res.status === 204 ? null : res.json();
  },
  patch(gist, files, token) {
    return this.api('/gists/' + gist, { method: 'PATCH', body: JSON.stringify({ files }) }, token);
  },
  // The API inlines files up to 1 MB; larger ones must be read from their raw URL
  async fileText(f) {
    if (!f) return null;
    if (!f.truncated) return f.content;
    const r = await fetch(f.raw_url, { cache: 'no-store' });
    if (!r.ok) throw new Error('下载失败 ' + r.status);
    return r.text();
  },
  async readIndex() {
    if (this.repoMode) {
      const m = await Repo.manifest('sync');
      this.remote = m && m.app === 'folio-repo' && m.kind === 'sync' ? m : null;
      return this.remote;
    }
    const g = await this.api('/gists/' + this.st.index);
    // Another device moved the library to a private repository: stop writing here
    const moved = g.files['moved-to-repo.json'];
    if (moved) { try { this.st.moved = JSON.parse(await this.fileText(moved)).repo || '私有仓库'; } catch { this.st.moved = '私有仓库'; } }
    const txt = await this.fileText(g.files['folio.json']);
    if (!txt) return null;
    const m = JSON.parse(txt);
    return m.app === 'folio-sync' ? m : null;
  },
  // A book's checksum in the repository format (packed JSON), to tell whether its text changed
  async bookHash(id) {
    const c = await DB.getContent(id);
    return c ? Backup.hash(JSON.stringify(await Backup.pack(c))) : null;
  },
  remoteHashes(remote) {
    if (!remote) return {};
    return this.repoMode ? Object.fromEntries(Object.entries(remote.books || {}).map(([id, b]) => [id, b.h])) : remote.contents || {};
  },
  hash(str) {   // FNV-1a + length: enough to tell whether a book's text changed
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36) + '.' + str.length.toString(36);
  },

  // ---------- the sync decision ----------
  reading() { return !document.getElementById('reader').classList.contains('hidden'); },

  async check(wait = false) {
    if (!this.on || !navigator.onLine) return;
    if (this.busy) {                                  // a check is already running: optionally wait for it
      if (!wait) return;
      while (this.busy) await new Promise(r => setTimeout(r, 200));
      return;
    }
    this.busy = true;
    clearTimeout(this.timer);
    this.timer = 0;
    try {
      const remote = await this.readIndex();
      const remoteNew = remote && remote.updatedAt !== this.st.base;
      if (this.st.joined === false) {
        // A device whose first sync has not finished never uploads over the cloud library:
        // with an empty shelf it downloads; with books of its own it waits for the user's choice
        if (!remote) { this.st.dirty = true; await this.push(null); this.st.joined = true; }
        else if (!(await DB.allMeta()).length && !this.reading()) { await this.pull(remote); this.st.joined = true; }
      } else if (remoteNew && (!this.st.dirty || remote.updatedAt > this.st.localAt)) {
        // The other device changed last: take its library (but never under an open book)
        if (this.reading()) this.waiting = true;
        else { this.waiting = false; await this.pull(remote); }
      } else if ((this.st.dirty || !remote) && !(this.st.moved && !this.repoMode)) {
        await this.push(remote);
      }
      if (!this.reading()) {
        await this.collectInbox();
        if (this.repoMode && this.st.legacy?.inbox && this.st.legacy.token) await this.collectInbox(true);
      }
      this.st.error = null;
    } catch (e) {
      if (e.changed) { this.st.error = null; setTimeout(() => this.check(), 1500); }   // the other device was quicker: take its library first
      else {
        if (e.missing) this.st.hashes = {};          // re-upload what the repository lost
        this.st.error = e.message;
        console.warn('sync:', e);
      }
    } finally {
      this.save();
      this.busy = false;
    }
  },

  // Replace the local library with the remote snapshot
  async pull(remote) {
    const want = this.remoteHashes(remote), have = this.st.hashes || {};
    const localIds = new Set(await DB.run('contents', 'readonly', s => s.getAllKeys()));
    const need = [];
    for (const id of Object.keys(want)) {
      if (!localIds.has(id)) need.push(id);
      else if (want[id] !== have[id] && !(this.repoMode && !(id in have) && await this.bookHash(id) === want[id])) need.push(id);
    }
    let books = [];
    if (this.repoMode) {
      // Everything is downloaded and checked before anything local is touched
      const pick = new Set(need);
      const data = await Repo.read(remote, { local: await Repo.localTexts(), want: id => pick.has(id), keep: pick.size > 50 });
      remote = { ...remote, stores: data.stores };
      books = data.books;
    } else if (need.length) {
      const g = await this.api('/gists/' + this.st.books);
      for (const id of need) {
        const txt = await this.fileText(g.files['book-' + id + '.json']);
        if (txt) books.push(JSON.parse(txt));
      }
    }
    // Everything is downloaded before anything local is touched
    const names = await DB.storeNames();
    this.applying = true;
    try {
      for (const [name, rows] of Object.entries(remote.stores || {})) {
        if (name !== 'contents' && name !== 'snapshots' && name !== 'device' && names.includes(name)) await DB.replace(name, rows);
      }
      for (const b of books) await DB.putContent(b);
      for (const id of localIds) {
        if (!(id in want)) await DB.run('contents', 'readwrite', s => s.delete(id));
      }
    } finally {
      this.applying = false;
    }
    if (this.repoMode) await Repo.dropKept();
    Object.assign(this.st, {
      hashes: { ...want }, base: remote.updatedAt, localAt: remote.updatedAt,
      dirty: false, pending: [], lastSync: Date.now(), lastFrom: remote.device,
    });
    this.save();
    CloudBackup.mark();                               // the pulled library is what the cloud backup should hold
    await Library.render();
    toast(`已同步${remote.device ? '「' + remote.device + '」' : ''}的书架`);
  },

  // Upload the local library as the new snapshot
  async push(remote) {
    if (this.repoMode) return this.pushRepo(remote);
    const rev0 = this.rev;
    const names = (await DB.storeNames()).filter(n => n !== 'contents' && n !== 'snapshots' && n !== 'device');
    const stores = {};
    for (const n of names) stores[n] = await DB.dump(n);
    const ids = new Set((stores.meta || []).map(m => m.id));
    const remoteHashes = remote?.contents || {}, known = this.st.hashes || {};
    const pending = new Set(this.st.pending || []);
    const hashes = {};

    // Book text: upload only what the other side does not already have
    for (const id of ids) {
      let h = known[id];
      if (!h || pending.has(id) || h !== remoteHashes[id]) {
        const c = await DB.getContent(id);
        if (!c) continue;
        const txt = JSON.stringify(c);
        h = this.hash(txt);
        if (h !== remoteHashes[id]) await this.patch(this.st.books, { ['book-' + id + '.json']: { content: txt } });
      }
      hashes[id] = h;
    }
    const gone = Object.keys(remoteHashes).filter(id => !ids.has(id));
    if (gone.length) {
      await this.patch(this.st.books, Object.fromEntries(gone.map(id => ['book-' + id + '.json', null])));
    }

    // The index goes last, so the other side never sees a book whose text is not there yet
    const updatedAt = this.st.dirty && this.st.localAt ? this.st.localAt : Date.now();
    const manifest = { app: 'folio-sync', v: 1, updatedAt, device: this.st.device, stores, contents: hashes };
    await this.patch(this.st.index, { 'folio.json': { content: JSON.stringify(manifest) } });

    Object.assign(this.st, { hashes, base: updatedAt, lastSync: Date.now() });
    if (this.rev === rev0) { this.st.dirty = false; this.st.pending = []; }   // else: changed meanwhile, go again later
    this.save();
  },

  // Upload the library to sync/ in one commit; unchanged books point at the files already there
  async pushRepo(remote) {
    const rev0 = this.rev;
    const prev = remote?.books || {}, known = this.st.hashes || {}, pending = new Set(this.st.pending || []);
    const src = await Repo.dbSource(id => !pending.has(id) && known[id] && prev[id]?.h === known[id] ? prev[id] : null);
    const ids = new Set((src.stores.meta || []).map(m => m.id));
    src.bookIds = src.bookIds.filter(id => ids.has(id));          // only books on the shelf, as before
    const snap = await Repo.build(src);
    const updatedAt = this.st.dirty && this.st.localAt ? this.st.localAt : Date.now();
    Object.assign(snap.manifest, { kind: 'sync', updatedAt, device: this.st.device });
    // Written only if sync/ is still what this device last saw; otherwise the other device wins
    const base = remote?.updatedAt ?? null;
    await Repo.save('sync', snap, `sync: ${this.st.device}`, async head => {
      const m = await Repo.manifest('sync', head.commit);
      if ((m?.updatedAt ?? null) !== base) throw Object.assign(new Error('另一台设备刚刚同步过'), { changed: true });
    });
    this.remote = snap.manifest;
    const hashes = Object.fromEntries(Object.entries(snap.manifest.books).map(([id, b]) => [id, b.h]));
    Object.assign(this.st, { hashes, base: updatedAt, lastSync: Date.now() });
    if (this.rev === rev0) { this.st.dirty = false; this.st.pending = []; }
    this.save();
  },

  // ---------- inbox: works sent by the 收书 bookmark ----------
  async ensureInbox() {
    if (this.repoMode) return null;
    if (this.st.inbox) return this.st.inbox;
    const list = await this.api('/gists?per_page=100');
    this.st.inbox = list.find(g => g.description === this.INBOX)?.id || (await this.api('/gists', {
      method: 'POST',
      body: JSON.stringify({ description: this.INBOX, public: false, files: { 'library.json': { content: '[]' } } }),
    })).id;
    this.save();
    return this.st.inbox;
  },

  // Upload the library right after works were imported, so a work is never removed from the
  // inbox while it exists on this device only (a later pull from the other device would replace
  // the local library and the work would be gone). Returns false, uploading nothing, when the
  // other device has uploaded in the meantime: its snapshot is never overwritten from here.
  async savedToCloud() {
    if (!this.st.dirty) return true;                 // nothing here that the cloud lacks
    const remote = await this.readIndex();
    if (remote && remote.updatedAt !== this.st.base) return false;
    await this.push(remote);
    return true;
  },

  // Where the inbox lives: the repository's inbox/ folder, or (before v1.2.6) the inbox gist.
  // `legacy`: the old inbox gist read with the old token after the move to a repository; works the
  // old bookmark still sends there are imported, and the gist itself is left as it is.
  async inboxSource(legacy) {
    if (this.repoMode && !legacy) {
      const head = await Repo.head(), files = await Repo.ls(head.tree, 'inbox');
      const dec = async sha => new TextDecoder().decode(await Repo.blob(sha));
      return {
        names: [...files.keys()].filter(p => /^inbox\/in-[^/]+$/.test(p) && !p.endsWith('.meta.json')).map(p => p.slice(6)),
        async read(n) {
          const sha = files.get('inbox/' + n);
          if (n.endsWith('.html') || n.endsWith('.b64')) return dec(sha);
          const m = files.get(`inbox/${n}.meta.json`);   // an e-book file with what its page said about it
          const info = m ? JSON.parse(await dec(m)) : {};
          return { blob: new Blob([await Repo.blob(sha)]), name: info.name || n.replace(/^in-[^.]+\./, '收到的作品.'), meta: info.meta || null };
        },
        remove: group => Repo.commit('inbox: collected', { del: group.flatMap(n => ['inbox/' + n, `inbox/${n}.meta.json`]) }),
        shelf: { have: files.get('inbox/library.json') },
      };
    }
    const token = legacy ? this.st.legacy.token : this.st.token;
    const id = legacy ? this.st.legacy.inbox : await this.ensureInbox();
    const g = await this.api('/gists/' + id, {}, token);
    // After the move the old inbox is only read: what was imported is remembered, the gist is not changed
    const readOnly = legacy || !!this.st.moved;
    const copied = new Set(legacy ? this.st.legacy.copied || [] : this.st.moved ? this.st.inboxSeen || [] : []);
    return {
      names: Object.keys(g.files).filter(n => /^in-.*\.(html|b64)$/.test(n) && !copied.has(n)),
      read: n => this.fileText(g.files[n]),
      remove: async group => {
        if (!readOnly) return this.patch(id, Object.fromEntries(group.map(n => [n, null])), token);
        if (legacy) this.st.legacy.copied = [...copied, ...group]; else this.st.inboxSeen = [...copied, ...group];
        this.save();
      },
      shelf: readOnly ? null : { gist: g.files['library.json']?.content },
    };
  },

  // A work from the inbox as import sources
  async inboxBooks(n, got) {
    if (got && typeof got === 'object') {               // an e-book file sent as itself (repository inbox)
      return (await booksFromFile(got.blob, got.name, got.meta)).filter(r => r.book).map(r => ({ book: r.book, label: bookName(r.book.title) }));
    }
    const text = got;
    if (!text) return [];
    if (n.endsWith('.b64')) {                     // an e-book file (EPUB, PDF, TXT…) sent by the bookmark as text
      const ext = n.replace(/\.b64$/, '').split('.').pop();
      // First line: JSON { name, meta } (or, from older bookmarks, just the file name)
      const cut = text.indexOf('\n'), head = cut > 0 ? text.slice(0, cut).trim() : '';
      let fname = '收到的作品.' + ext, meta = null;
      if (head.startsWith('{')) { try { ({ name: fname = fname, meta = null } = JSON.parse(head)); } catch { /* keep defaults */ } }
      else if (head) fname = head;
      const bin = atob(text.slice(cut + 1).trim()), bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      return (await booksFromFile(new Blob([bytes]), fname, meta)).filter(r => r.book).map(r => ({ book: r.book, label: bookName(r.book.title) }));
    }
    const book = Importer.parseText(text, '收到的作品');
    return [{ book, label: bookName(book.title) }];
  },

  // Import everything waiting in the inbox, then clear it
  async collectInbox(legacy = false) {
    const box = await this.inboxSource(legacy);
    const names = box.names;
    // A few at a time, each group removed from the inbox right after it is saved (and uploaded),
    // so an interruption never loses a work and never imports more than the last group twice
    // (and importing a book again only updates it).
    const total = { count: 0, updated: 0, added: 0, same: 0 };
    let kept = 0, unsynced = 0, skipped = 0;
    for (let i = 0; i < names.length; i += 5) {
      const group = names.slice(i, i + 5), sources = [];
      for (const n of group) {
        const got = await box.read(n);
        const list = await this.inboxBooks(n, got);
        if (!list.length) skipped++;
        sources.push(...list);
      }
      const res = await importBooks(sources, false);
      const retry = res.failed.filter(f => f.retry).length;
      skipped += res.failed.length - retry;          // no text at all: nothing to retry, but say so
      // A group that hit a storage error stays in the inbox, so nothing is lost and the next launch retries it
      if (retry) kept += retry;
      else if (!this.on || await this.savedToCloud()) await box.remove(group);
      else unsynced += group.length;                 // saved here, not yet uploaded: stays in the inbox too
      for (const k in total) total[k] += res[k] || 0;
    }
    const msg = [];
    if (kept) msg.push(`有 ${kept} 篇没能保存，先留在收件箱，下次打开再试`);
    else if (unsynced) msg.push('收到的作品已存在本机，还没同步到云端，先留在收件箱，下次再试');
    else if (total.count) msg.push('收到作品：' + importSummary(total));
    if (skipped) msg.push(`${skipped} 篇没有正文，已跳过`);
    if (msg.length) toast(msg.join(' · '));
    if (box.shelf) await this.writeShelfList(box.shelf);
  },

  // The bookmark compares this list with the site to find new chapters
  async writeShelfList(shelf) {
    const list = (await DB.allMeta()).map(m => {
      const w = (m.source || '').match(/\/works\/(\d+)/)?.[1];
      const stats = Object.entries(m.tags || {}).find(([k]) => /stat/i.test(k))?.[1]?.[0] || '';
      const ch = stats.match(/Chapters:\s*(\d+)\s*\/\s*(\d+|\?)/);
      return w && { w, c: m.chapterCount || 0, t: m.title, done: !!ch && ch[1] === ch[2] };
    }).filter(Boolean);
    const text = JSON.stringify(list);
    if (this.repoMode) {
      const s = await Repo.gitSha(new TextEncoder().encode(text));
      if (s !== shelf.have) await Repo.commit('inbox: shelf list', { put: new Map([['inbox/library.json', { s, text }]]) });
    } else if (text !== shelf.gist) await this.patch(this.st.inbox, { 'library.json': { content: text } });
  },

  // The bookmark: collector.js with this device's token and inbox filled in
  async bookmarklet() {
    await this.ensureInbox();
    const src = await (await fetch('collector.js', { cache: 'no-store' })).text();
    const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).map(l => l.trim()).filter(Boolean).join('\n')
      .replace('__TOKEN__', this.st.token).replace('__INBOX__', this.st.inbox || '')
      .replace('__APP__', new URL('./', location.href).href)
      .replace('__INSTALLED__', matchMedia('(display-mode: standalone)').matches || navigator.standalone ? 'yes' : '')
      .replace('__REPO__', this.st.repo || '').replace('__BRANCH__', this.st.branch || 'main');
    return 'javascript:' + encodeURIComponent(code);
  },

  // The bookmark sheet: the copy button first, then how to add it on this kind of device
  async showBookmarklet() {
    let url;
    try { url = await this.bookmarklet(); } catch (e) { return toast('生成失败：' + e.message); }
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const s = quickSheet(`
      <div class="pk-title">网页收书书签<small>在作品页或列表页点一下，作品就进 Folio 书架</small></div>
      <div class="pk-list"><button class="pk-row strong" data-a="copy"><span>复制书签</span></button></div>
      <ol class="bm-steps bm-add">${ios
        ? '<li>在 Safari 里给任意网页加书签，名字写「Folio 收书」。</li><li>编辑这个书签，把网址换成刚复制的内容。</li>'
        : '<li>Chrome 按 Ctrl+Shift+O →「⋮」→「添加新书签」。</li><li>名字写「Folio 收书」，网址粘贴刚复制的内容。</li>'}</ol>
      <p class="sync-note bm-note">${ios ? '' : '在已安装的 Folio 窗口里复制，送完可以一键打开 Folio。'}书签里有你的同步令牌，不要分享；换了令牌要重新复制。</p>`);
    const btn = s.card.querySelector('[data-a=copy]');
    btn.onclick = async () => {
      try { await copyText(url); } catch { return toast('复制失败，请再试一次'); }
      btn.classList.add('done');
      btn.firstElementChild.textContent = '已复制 ✓';      // the button itself is the confirmation
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.classList.remove('done'); btn.firstElementChild.textContent = '复制书签'; }, 2400);
    };
  },

  // ---------- setup ----------
  // Connect this device to a private repository. A device moved over from the gists continues
  // its own history (migrate.js); otherwise, when both sides have books, the user picks one.
  async connect(token, repo) {
    Repo.use({ token, repo });
    await Repo.open();                                   // exists, is private, has a first commit
    Object.assign(this.st, { token, repo, branch: Repo.branch, hashes: {}, base: null, error: null, moved: null, joined: false });
    delete this.st.index; delete this.st.books; delete this.st.inbox;
    this.save();

    const remote = await this.readIndex();
    const localCount = (await DB.allMeta()).length;
    if (!remote) { this.st.dirty = true; await this.push(null); this.joined(); return '已把本机书架上传到私有仓库，在另一台设备上连接同一个仓库即可'; }
    if (!localCount) { await this.pull(remote); this.joined(); return null; }
    // Both sides have books: ask which one to keep
    const choice = await new Promise(resolve => {
      const n = remote.stores?.meta?.count ?? 0;
      const s = quickSheet(`
        <div class="pk-title">两边都有书，保留哪一边？</div>
        <div class="pk-list">
          <button class="pk-row" data-c="remote"><span>用云端的书架</span><small>${n} 本 · 来自${esc(remote.device || '另一台设备')}</small></button>
          <button class="pk-row" data-c="local"><span>用这台设备的书架</span><small>${localCount} 本</small></button>
        </div>
        <p class="sync-note">另一边的书架会被整个替换，不会合并。被替换的一边在仓库历史和云端备份里还找得到。</p>`);
      s.card.onclick = async e => {
        const row = e.target.closest('[data-c]');
        if (!row) return;
        await s.close();
        resolve(row.dataset.c);
      };
      s.root.addEventListener('click', e => { if (e.target === s.root) resolve(null); });
    });
    if (choice === 'remote') { await this.pull(remote); this.joined(); return null; }
    if (choice === 'local') { this.st.dirty = true; this.st.localAt = Date.now(); await this.push(remote); this.joined(); return '已用本机书架覆盖云端'; }
    return '还没有同步，之后可以在「设备同步」里再选';
  },
  joined() { this.st.joined = true; this.save(); },

  disconnect() {
    const device = this.st.device;   // token, repository and the old gists' details go too
    this.st = { device };
    this.save();
  },

  // ---------- UI ----------
  summary() {
    if (!this.on) return '手机和电脑共用一个书架';
    if (this.st.error) return '同步出错：' + this.st.error;
    if (!this.repoMode && this.st.moved) return '另一台设备已经升级到私有仓库，请在这里也升级';
    if (this.st.joined === false) return '已连接，还没有同步完第一次';
    return this.st.lastSync ? '上次同步 ' + fmtTime(this.st.lastSync) : '已连接';
  },

  async openPanel() {
    if (!this.on) return this.setup();
    const where = this.repoMode ? `私有仓库 ${this.st.repo}` : '秘密 Gist（有链接的人都能看到）';
    const s = quickSheet(`
      <div class="pk-title">设备同步</div>
      <p class="sync-note">本机：${esc(this.st.device)} · ${esc(this.summary())}<br>存在：${esc(where)}</p>
      <div class="pk-list">
        ${this.repoMode ? '' : '<button class="pk-row strong" data-a="move"><span>升级到私有仓库</span><small>只有你能看到；旧 Gist 会原样保留</small></button>'}
        <button class="pk-row" data-a="now"><span>立即同步</span></button>
        <button class="pk-row" data-a="cloud"><span>云端自动备份</span><small>${esc(CloudBackup.summary())}</small></button>
        <button class="pk-row" data-a="bm"><span>网页收书书签</span><small>在网站上一点就进书架</small></button>
        ${this.repoMode && Push.supported() ? '<button class="pk-row" data-a="push"><span>收书通知</span><small>网页收书完成后收到一条通知</small></button>' : ''}
        <button class="pk-row" data-a="name"><span>本机名称</span><small>${esc(this.st.device)}</small></button>
        ${this.st.legacy ? '<button class="pk-row" data-a="legacy"><span>旧 Gist</span><small>还保留着，可以停用</small></button>' : ''}
        <button class="pk-row muted" data-a="off"><span>断开同步</span></button>
      </div>`);
    s.card.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      await s.close();
      if (a === 'now') {
        if (this.st.joined === false) {                // the first sync waits for a choice: ask again
          try { const msg = await this.connect(this.st.token, this.st.repo); if (msg) toast(msg); } catch (err) { toast('同步失败：' + err.message); }
          return;
        }
        await this.check();
        toast(this.st.error ? '同步失败：' + this.st.error : '已是最新');
      } else if (a === 'move') {
        Migrate.start();
      } else if (a === 'legacy') {
        Migrate.legacyPanel();
      } else if (a === 'cloud') {
        CloudBackup.openPanel();
      } else if (a === 'bm') {
        this.showBookmarklet();
      } else if (a === 'push') {
        Push.open();
      } else if (a === 'name') {
        const v = await promptDialog({ title: '本机名称', value: this.st.device, placeholder: '比如：手机、电脑', ok: '保存' });
        if (v) { this.st.device = v; this.save(); }
      } else if (a === 'off') {
        const ok = await confirmDialog({ title: '断开同步？', message: '这台设备上的书都会保留，只是以后不再同步。仓库里的数据也不会被删除。', ok: '断开', danger: true });
        if (ok) { this.disconnect(); toast('已断开同步'); }
      }
    };
  },

  // The repository and token, asked together with how to make them
  askRepo({ title, intro, ok }) {
    return new Promise(resolve => {
      // The explanation scrolls inside the sheet; the button stays visible below it (phones)
      const s = quickSheet(`
        <div class="pk-title">${esc(title)}</div>
        <div class="sheet-scroll">
        ${intro ? `<p class="sync-note">${intro}</p>` : ''}
        <ol class="bm-steps">
          <li>在 GitHub 新建一个仓库，比如 <b>folio-data</b>，选 <b>Private</b>。</li>
          <li>Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token。Repository access 选 <b>Only select repositories</b>，只勾这个仓库；Permissions 里只把 <b>Contents</b> 设为 <b>Read and write</b>（Metadata 只读会自动加上）。</li>
          <li>把仓库名和令牌填在下面。两台设备填同一个仓库，可以用同一个令牌。</li>
        </ol>
        <input class="alert-input" data-f="repo" placeholder="用户名/仓库名，比如 cynthiazhao0411/folio-data" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(this.st.repo || '')}">
        <input class="alert-input" data-f="token" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <p class="sync-note">令牌只保存在这台设备上，也会写进你复制的收书书签里，不要发给别人。</p>
        </div>
        <div class="pk-list form-foot"><button class="pk-row strong" data-a="ok"><span>${esc(ok)}</span></button></div>`, 'form');
      // With the iPhone keyboard open, keep the sheet inside the part of the screen still visible
      const vv = window.visualViewport;
      const fit = () => { if (vv) Object.assign(s.root.style, { top: vv.offsetTop + 'px', height: vv.height + 'px', bottom: 'auto' }); };
      vv?.addEventListener('resize', fit); vv?.addEventListener('scroll', fit);
      const unfit = () => { vv?.removeEventListener('resize', fit); vv?.removeEventListener('scroll', fit); };
      new MutationObserver((_, o) => { if (!s.root.isConnected) { unfit(); o.disconnect(); } }).observe(document.body, { childList: true });
      s.card.addEventListener('focusin', e => { if (e.target.matches('input')) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300); });
      const val = f => s.card.querySelector(`[data-f=${f}]`).value.trim();
      s.card.onclick = async e => {
        if (!e.target.closest('[data-a=ok]')) return;
        const repo = val('repo').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, ''), token = val('token');
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return toast('仓库要写成「用户名/仓库名」');
        if (token.length < 20) return toast('请粘贴完整的令牌');
        await s.close();
        resolve({ repo, token });
      };
      s.root.addEventListener('click', e => { if (e.target === s.root) resolve(null); });
    });
  },

  async setup() {
    const got = await this.askRepo({ title: '连接 GitHub 同步', intro: '书架存在你自己的 GitHub 私有仓库里，手机和电脑共用。', ok: '连接' });
    if (!got) return;
    toast('正在连接…');
    try {
      const msg = await this.connect(got.token, got.repo);
      if (msg) toast(msg);
    } catch (e) {
      const reached = this.st.repo && this.st.joined === false && !e.public && e.status !== 401 && e.status !== 403 && e.status !== 404;
      if (!reached) this.disconnect();               // wrong repository or token: forget them
      else this.save();                              // reached the repository: the first download continues on the next sync
      dialog({ title: reached ? '还没有同步完' : '连接失败', ok: '好',
        message: (e instanceof TypeError ? '连不上 GitHub，请检查网络。' : e.message) + (reached ? '\n\n已经连上仓库，Folio 会在下次同步时接着下载，不会上传这台设备的空书架。' : '') });
    }
  },
};
