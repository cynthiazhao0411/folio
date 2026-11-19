// sync.js — Keeps the phone and the computer on the same library through two secret
// GitHub gists, using a personal access token that only needs gist access.
//
// Model: the whole library is one snapshot and the side that changed last wins.
// Nothing is merged, so there are never half-merged records.
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
  get on() { return !!(this.st.token && this.st.index && this.st.books); },

  init() {
    this.load();
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
  async api(path, opts = {}) {
    const headers = { Authorization: 'Bearer ' + this.st.token, Accept: 'application/vnd.github+json' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(this.API + path, { ...opts, headers, cache: 'no-store' });
    if (res.status === 401) throw new Error('令牌无效或已过期');
    if (res.status === 403 || res.status === 404) throw new Error('令牌没有 Gist 权限，或同步数据已被删除');
    if (!res.ok) throw new Error('GitHub 返回 ' + res.status);
    return res.status === 204 ? null : res.json();
  },
  patch(gist, files) {
    return this.api('/gists/' + gist, { method: 'PATCH', body: JSON.stringify({ files }) });
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
    const g = await this.api('/gists/' + this.st.index);
    const txt = await this.fileText(g.files['folio.json']);
    if (!txt) return null;
    const m = JSON.parse(txt);
    return m.app === 'folio-sync' ? m : null;
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
      if (remoteNew && (!this.st.dirty || remote.updatedAt > this.st.localAt)) {
        // The other device changed last: take its library (but never under an open book)
        if (this.reading()) this.waiting = true;
        else { this.waiting = false; await this.pull(remote); }
      } else if (this.st.dirty || !remote) {
        await this.push(remote);
      }
      if (!this.reading()) await this.collectInbox();
      this.st.error = null;
    } catch (e) {
      this.st.error = e.message;
      console.warn('sync:', e);
    } finally {
      this.save();
      this.busy = false;
    }
  },

  // Replace the local library with the remote snapshot
  async pull(remote) {
    const want = remote.contents || {}, have = this.st.hashes || {};
    const localIds = new Set(await DB.run('contents', 'readonly', s => s.getAllKeys()));
    const need = Object.keys(want).filter(id => want[id] !== have[id] || !localIds.has(id));
    const books = [];
    if (need.length) {
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
        if (name !== 'contents' && name !== 'snapshots' && names.includes(name)) await DB.replace(name, rows);
      }
      for (const b of books) await DB.putContent(b);
      for (const id of localIds) {
        if (!(id in want)) await DB.run('contents', 'readwrite', s => s.delete(id));
      }
    } finally {
      this.applying = false;
    }
    Object.assign(this.st, {
      hashes: { ...want }, base: remote.updatedAt, localAt: remote.updatedAt,
      dirty: false, pending: [], lastSync: Date.now(), lastFrom: remote.device,
    });
    this.save();
    await Library.render();
    toast(`已同步${remote.device ? '「' + remote.device + '」' : ''}的书架`);
  },

  // Upload the local library as the new snapshot
  async push(remote) {
    const rev0 = this.rev;
    const names = (await DB.storeNames()).filter(n => n !== 'contents' && n !== 'snapshots');
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

  // ---------- inbox: works sent by the 收书 bookmark ----------
  async ensureInbox() {
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

  // Import everything waiting in the inbox, then clear it
  async collectInbox() {
    const g = await this.api('/gists/' + await this.ensureInbox());
    const names = Object.keys(g.files).filter(n => /^in-.*\.(html|b64)$/.test(n));
    // A few at a time, each group removed from the inbox right after it is saved (and uploaded),
    // so an interruption never loses a work and never imports more than the last group twice
    // (and importing a book again only updates it).
    const total = { count: 0, updated: 0, added: 0 };
    let kept = 0, unsynced = 0, skipped = 0;
    for (let i = 0; i < names.length; i += 5) {
      const group = names.slice(i, i + 5), sources = [];
      for (const n of group) {
        const text = await this.fileText(g.files[n]);
        if (!text) { skipped++; continue; }
        if (n.endsWith('.b64')) {                     // an e-book file (EPUB, PDF, TXT…) sent by the bookmark
          const ext = n.replace(/\.b64$/, '').split('.').pop();
          const cut = text.indexOf('\n'), fname = cut > 0 ? text.slice(0, cut).trim() : '收到的作品.' + ext;
          const bin = atob(text.slice(cut + 1).trim()), bytes = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          for (const r of await Importer.parseFile(new Blob([bytes]), fname)) {
            if (r.book) sources.push({ book: r.book, label: bookName(r.book.title) }); else skipped++;
          }
        } else { const book = Importer.parseText(text, '收到的作品'); sources.push({ book, label: bookName(book.title) }); }
      }
      const res = await importBooks(sources, false);
      const retry = res.failed.filter(f => f.retry).length;
      skipped += res.failed.length - retry;          // no text at all: nothing to retry, but say so
      // A group that hit a storage error stays in the inbox, so nothing is lost and the next launch retries it
      if (retry) kept += retry;
      else if (!this.on || await this.savedToCloud()) await this.patch(this.st.inbox, Object.fromEntries(group.map(n => [n, null])));
      else unsynced += group.length;                 // saved here, not yet uploaded: stays in the inbox too
      for (const k in total) total[k] += res[k];
    }
    const msg = [];
    if (kept) msg.push(`有 ${kept} 篇没能保存，先留在收件箱，下次打开再试`);
    else if (unsynced) msg.push('收到的作品已存在本机，还没同步到云端，先留在收件箱，下次再试');
    else if (total.count) msg.push('收到作品：' + importSummary(total));
    if (skipped) msg.push(`${skipped} 篇没有正文，已跳过`);
    if (msg.length) toast(msg.join(' · '));
    await this.writeShelfList(g.files['library.json']?.content);
  },

  // The bookmark compares this list with the site to find new chapters
  async writeShelfList(currentText) {
    const list = (await DB.allMeta()).map(m => {
      const w = (m.source || '').match(/\/works\/(\d+)/)?.[1];
      const stats = Object.entries(m.tags || {}).find(([k]) => /stat/i.test(k))?.[1]?.[0] || '';
      const ch = stats.match(/Chapters:\s*(\d+)\s*\/\s*(\d+|\?)/);
      return w && { w, c: m.chapterCount || 0, t: m.title, done: !!ch && ch[1] === ch[2] };
    }).filter(Boolean);
    const text = JSON.stringify(list);
    if (text !== currentText) await this.patch(this.st.inbox, { 'library.json': { content: text } });
  },

  // The bookmark: collector.js with this device's token and inbox filled in
  async bookmarklet() {
    await this.ensureInbox();
    const src = await (await fetch('collector.js', { cache: 'no-store' })).text();
    const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).map(l => l.trim()).filter(Boolean).join('\n')
      .replace('__TOKEN__', this.st.token).replace('__INBOX__', this.st.inbox);
    return 'javascript:' + encodeURIComponent(code);
  },

  async showBookmarklet() {
    let url;
    try { url = await this.bookmarklet(); } catch (e) { return toast('生成失败：' + e.message); }
    const s = quickSheet(`
      <div class="pk-title">网页收书书签<small>在网站上点一下，作品就进 Folio 书架</small></div>
      <ol class="bm-steps">
        <li>点下面的「复制书签」。</li>
        <li><b>iPhone</b>：在 Safari 里随便打开一个网页，点分享 →「添加书签」，名字写「Folio 收书」，存好。然后打开书签列表 → 编辑 → 点这个书签，把地址全部删掉，粘贴刚才复制的内容。</li>
        <li><b>电脑 Chrome</b>：按 Ctrl+Shift+O 打开书签管理器 → 右上角 ⋮ →「添加新书签」，名字写「Folio 收书」，网址粘贴。</li>
        <li>以后在作品页点这个书签，作品会直接送到 Folio；在列表页（收藏、订阅、搜索结果）可以勾选多篇一起送，书架上有新章节的会自动勾上。</li>
      </ol>
      <p class="sync-note">书签里含有你的同步令牌，不要发给别人。换了令牌要重新复制一次。</p>
      <div class="pk-list"><button class="pk-row strong" data-a="copy"><span>复制书签</span></button></div>`);
    s.card.onclick = async e => {
      if (!e.target.closest('[data-a=copy]')) return;
      await copyText(url);
      toast('已复制书签');
    };
  },

  // ---------- setup ----------
  async connect(token) {
    this.st.token = token;
    const list = await this.api('/gists?per_page=100');
    const make = async d => (await this.api('/gists', {
      method: 'POST',
      body: JSON.stringify({ description: d, public: false, files: { 'about.txt': { content: 'Folio sync data. Do not edit by hand.' } } }),
    })).id;
    const find = d => list.find(g => g.description === d)?.id;
    this.st.index = find(this.INDEX) || await make(this.INDEX);
    this.st.books = find(this.BOOKS) || await make(this.BOOKS);
    Object.assign(this.st, { hashes: {}, base: null, error: null });
    this.save();

    const remote = await this.readIndex();
    const localCount = (await DB.allMeta()).length;
    if (!remote) { this.st.dirty = true; await this.push(null); return '已把本机书架上传，在另一台设备上连接同一个令牌即可'; }
    if (!localCount) { await this.pull(remote); return null; }
    // Both sides have books: ask which one to keep
    const choice = await new Promise(resolve => {
      const n = (remote.stores?.meta || []).length;
      const s = quickSheet(`
        <div class="pk-title">两边都有书，保留哪一边？</div>
        <div class="pk-list">
          <button class="pk-row" data-c="remote"><span>用云端的书架</span><small>${n} 本 · 来自${esc(remote.device || '另一台设备')}</small></button>
          <button class="pk-row" data-c="local"><span>用这台设备的书架</span><small>${localCount} 本</small></button>
        </div>
        <p class="sync-note">另一边的书架会被整个替换，不会合并。</p>`);
      s.card.onclick = async e => {
        const row = e.target.closest('[data-c]');
        if (!row) return;
        await s.close();
        resolve(row.dataset.c);
      };
      s.root.addEventListener('click', e => { if (e.target === s.root) resolve(null); });
    });
    if (choice === 'remote') { await this.pull(remote); return null; }
    if (choice === 'local') { this.st.dirty = true; this.st.localAt = Date.now(); await this.push(remote); return '已用本机书架覆盖云端'; }
    return '还没有同步，之后可以在「设备同步」里再选';
  },

  disconnect() {
    const device = this.st.device;   // inbox and token go too; a new connection finds the gists again
    this.st = { device };
    this.save();
  },

  // ---------- UI ----------
  summary() {
    if (!this.on) return '手机和电脑共用一个书架';
    if (this.st.error) return '同步出错：' + this.st.error;
    return this.st.lastSync ? '上次同步 ' + fmtTime(this.st.lastSync) : '已连接';
  },

  async openPanel() {
    if (!this.on) return this.setup();
    const s = quickSheet(`
      <div class="pk-title">设备同步</div>
      <p class="sync-note">本机：${esc(this.st.device)} · ${esc(this.summary())}</p>
      <div class="pk-list">
        <button class="pk-row" data-a="now"><span>立即同步</span></button>
        <button class="pk-row" data-a="bm"><span>网页收书书签</span><small>在网站上一点就进书架</small></button>
        <button class="pk-row" data-a="name"><span>本机名称</span><small>${esc(this.st.device)}</small></button>
        <button class="pk-row muted" data-a="off"><span>断开同步</span></button>
      </div>`);
    s.card.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      await s.close();
      if (a === 'now') {
        await this.check();
        toast(this.st.error ? '同步失败：' + this.st.error : '已是最新');
      } else if (a === 'bm') {
        this.showBookmarklet();
      } else if (a === 'name') {
        const v = await promptDialog({ title: '本机名称', value: this.st.device, placeholder: '比如：手机、电脑', ok: '保存' });
        if (v) { this.st.device = v; this.save(); }
      } else if (a === 'off') {
        const ok = await confirmDialog({ title: '断开同步？', message: '这台设备上的书都会保留，只是以后不再同步。', ok: '断开', danger: true });
        if (ok) { this.disconnect(); toast('已断开同步'); }
      }
    };
  },

  async setup() {
    const token = await promptDialog({
      title: '连接 GitHub 同步',
      message: '粘贴一个有 Gist 读写权限的个人令牌。令牌只保存在这台设备上。',
      placeholder: 'ghp_… 或 github_pat_…', ok: '连接', max: 200,
    });
    if (!token) return;
    toast('正在连接…');
    try {
      const msg = await this.connect(token.trim());
      if (msg) toast(msg);
    } catch (e) {
      this.disconnect();
      dialog({ title: '连接失败', message: e.message, ok: '好' });
    }
  },
};
