// repo.js — Folio's cloud storage in a private GitHub repository (from v1.2.6).
//
// Device sync, the automatic cloud backup and the bookmark inbox share one private repository,
// each in its own folder, so they never overwrite each other:
//   sync/     the library the devices share (the device that changed last wins)
//   backup/   the automatic cloud backup (every earlier backup stays in the repository history)
//   inbox/    works sent by the 收书 bookmark, and library.json for its update checks
//
// A snapshot folder (sync/ or backup/) holds:
//   manifest.json            what is inside: for every file its path, an FNV checksum (h) and its
//                            Git blob id (s), plus record counts
//   stores/<name>/<n>.json   one database store, split into shards by record key; a shard stays
//                            around 64 KB, so a change (reading progress, a note) rewrites one small
//                            file instead of the whole store
//   media/<xx>/<hash>.txt    long values (covers and other images) taken out of the records, named
//                            by their checksum: stored once, never uploaded again
//   books/<xx>/<id>.json     one book's text and chapters; a book over 2 MB is split into parts
//   local.json               (backup only) this device's settings
// Stores are listed from the database, never hard-coded, so data added by later versions is
// included automatically. Values JSON cannot hold (blobs, bytes, dates) use Backup.pack.
//
// Writing goes through the Git Data API, not the Contents API: new files are uploaded a few MB
// per request as one throwaway tree, then a single commit swaps the whole folder at once and the
// branch is moved only if nobody else moved it in the meantime (otherwise it is redone on top of
// the newer commit). An interrupted or failed write therefore changes nothing. Files already in
// the repository (same Git blob id) are never uploaded again.
// Reading never lists folders: the manifest names every blob, which is fetched by id.
//
// Limits taken into account: GitHub allows about 80 writing requests a minute (500 an hour), so
// uploads are batched; Git blobs may be up to 100 MB, and no single upload request here exceeds
// about 3 MB; recursive tree listings stop at 100,000 entries, so listings fall back to walking
// one folder at a time.
const Repo = {
  API: 'https://api.github.com',
  SHARD: 64 * 1024,          // target size of one store shard
  PART: 2 * 1024 * 1024,     // a file larger than this is split into parts
  BIG: 16 * 1024,            // values longer than this move to media/
  UPLOAD: 3 * 1024 * 1024,   // content per upload request
  POOL: 6,                   // parallel downloads
  token: '', repo: '', branch: 'main',
  known: new Set(),          // blob ids seen in the repository during this session

  use({ token, repo, branch }) { this.token = token; this.repo = repo; this.branch = branch || 'main'; },

  // ---------- GitHub ----------
  async api(path, opts = {}, accept = 'application/vnd.github+json') {
    const url = this.API + (path.startsWith('/repos') || path === '/user' ? path : `/repos/${this.repo}${path}`);
    const headers = { Authorization: 'Bearer ' + this.token, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
    if (opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...opts, headers, cache: 'no-store' });
    if (res.ok) return accept.includes('raw') ? res : res.status === 204 ? null : res.json();
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* no body */ }
    const err = new Error(
      res.status === 401 ? '令牌无效或已过期'
      : (res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(msg)) ? 'GitHub 暂时限制了请求次数，稍后会自动再试'
      : res.status === 403 ? '令牌没有这个仓库的读写权限（需要 Contents：Read and write）'
      : res.status === 404 ? '找不到这个仓库，或令牌没有授权这个仓库'
      : res.status === 409 && /empty/i.test(msg) ? '仓库是空的'
      : 'GitHub 返回 ' + res.status + (msg ? '：' + msg : ''));
    err.status = res.status;
    err.empty = res.status === 409 && /empty/i.test(msg);
    throw err;
  },

  // The repository must exist, be private, and have a first commit (an empty repository has no
  // branch for the Git Data API to work on)
  async open() {
    const info = await this.api(`/repos/${this.repo}`);
    if (!info.private) {
      const e = new Error(`「${this.repo}」是公开仓库，任何人都能看到里面的内容。请在 GitHub 上把它改成 Private，或换一个私有仓库。`);
      e.public = true;
      throw e;
    }
    this.branch = info.default_branch || 'main';
    try { await this.head(); } catch (e) {
      if (!e.empty && e.status !== 404 && e.status !== 409) throw e;
      await this.api('/contents/README.md', { method: 'PUT', body: JSON.stringify({
        message: 'Set up Folio data', branch: this.branch,
        content: btoa('# Folio data\n\nPrivate data of the Folio reader (sync, backup, inbox). Do not edit by hand.\n'),
      }) });
    }
    return info;
  },

  async head() {
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const commit = await this.api(`/git/commits/${ref.object.sha}`);
    return { commit: ref.object.sha, tree: commit.tree.sha };
  },

  // Every file under `prefix` at a tree: Map(path → blob id)
  async ls(tree, prefix) {
    const out = new Map();
    const root = await this.api(`/git/trees/${tree}`);
    const top = root.tree.find(e => e.path === prefix && e.type === 'tree');
    if (!top) return out;
    const walk = async (sha, base, recursive) => {
      const t = await this.api(`/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
      if (recursive && t.truncated) return walk(sha, base, false);       // too big to list at once
      for (const e of t.tree) {
        const p = base + '/' + e.path;
        if (e.type === 'blob') { out.set(p, e.sha); this.known.add(e.sha); }
        else if (e.type === 'tree' && !recursive) await walk(e.sha, p, false);
      }
    };
    await walk(top.sha, prefix, true);
    return out;
  },

  async blob(sha) { return (await this.api(`/git/blobs/${sha}`, {}, 'application/vnd.github.raw+json')).arrayBuffer(); },
  async file(path, ref = this.branch) {        // one small file by path (the manifest); null if missing
    try { return await (await this.api(`/contents/${path}?ref=${encodeURIComponent(ref)}`, {}, 'application/vnd.github.raw+json')).text(); }
    catch (e) { if (e.status === 404) return null; throw e; }
  },

  // Git's own blob id, so a file is uploaded only when the repository does not have it
  async gitSha(bytes) {
    const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const all = new Uint8Array(head.length + bytes.length);
    all.set(head); all.set(bytes, head.length);
    return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))].map(b => b.toString(16).padStart(2, '0')).join('');
  },

  // ---------- one atomic commit ----------
  // put: Map(path → { s, text? | bytes? }) — a file with only `s` is taken from the repository as it is.
  // clear: folders whose files not in `put` are removed. del: single paths to remove.
  // guard(head): may throw to stop (another device changed what this commit was based on).
  async commit(message, { put = new Map(), clear = [], del = [], guard } = {}) {
    // 1. Upload what the repository does not have, a few MB per request
    let batch = [], size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const t = await this.api('/git/trees', { method: 'POST', body: JSON.stringify({
        tree: batch.map((f, i) => ({ path: 'u' + i, mode: '100644', type: 'blob', content: f.text })),
      }) });
      for (const e of t.tree) {
        const f = batch[+e.path.slice(1)];
        if (e.sha !== f.s) throw new Error('上传校验不一致，已停止（没有改动云端）');
        this.known.add(e.sha);
      }
      batch = []; size = 0;
    };
    for (const f of put.values()) {
      if (this.known.has(f.s)) continue;
      if (f.bytes) {                               // binary (an e-book file from the inbox)
        const b = await this.api('/git/blobs', { method: 'POST', body: JSON.stringify({ content: await Backup.b64(f.bytes), encoding: 'base64' }) });
        if (b.sha !== f.s) throw new Error('上传校验不一致，已停止（没有改动云端）');
        this.known.add(b.sha);
        continue;
      }
      if (f.text === undefined) continue;          // expected to be in the repository already
      if (size && size + f.text.length > this.UPLOAD) await flush();
      batch.push(f); size += f.text.length;
    }
    await flush();

    // 2. One commit on top of the newest state; redone if another device committed meanwhile
    for (let attempt = 0; attempt < 5; attempt++) {
      const head = await this.head();
      if (guard) await guard(head);
      const have = new Map();
      const dirs = new Set([...clear, ...del.map(p => p.split('/')[0])]);
      for (const d of dirs) for (const [p, s] of await this.ls(head.tree, d)) have.set(p, s);
      const entries = [];
      for (const [p, f] of put) {
        if (have.get(p) === f.s) continue;
        entries.push({ path: p, mode: '100644', type: 'blob', sha: f.s });
      }
      const gone = new Set(del.filter(p => have.has(p) && !put.has(p)));
      for (const p of have.keys()) if (clear.some(d => p.startsWith(d + '/')) && !put.has(p)) gone.add(p);
      for (const p of gone) entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
      if (!entries.length) return { commit: head.commit, changed: false };
      let tree;
      try { tree = await this.api('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree, tree: entries }) }); }
      catch (e) {
        if (e.status === 422) { const m = new Error('云端缺少之前上传的文件，下次会重新上传'); m.missing = true; throw m; }
        throw e;
      }
      const c = await this.api('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [head.commit] }) });
      try {
        await this.api(`/git/refs/heads/${encodeURIComponent(this.branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha, force: false }) });
        return { commit: c.sha, changed: true };
      } catch (e) {
        if (e.status !== 422 && e.status !== 409) throw e;   // not a fast-forward: someone was quicker
        await new Promise(r => setTimeout(r, 400 + Math.random() * 800));
      }
    }
    throw new Error('仓库一直在被别的设备改动，稍后会再试');
  },

  // ---------- snapshots (sync/ and backup/) ----------
  shardOf(key, n) { let h = 0x811c9dc5; const s = typeof key === 'string' ? key : JSON.stringify(key); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0) % n; },
  dir(id) { return Backup.hash(String(id)).slice(0, 2); },
  split(text) {                                    // parts of at most PART characters, never inside a surrogate pair
    if (text.length <= this.PART) return [text];
    const out = [];
    for (let i = 0; i < text.length;) {
      let j = Math.min(text.length, i + this.PART);
      const c = text.charCodeAt(j - 1);
      if (j < text.length && c >= 0xd800 && c <= 0xdbff) j--;
      out.push(text.slice(i, j)); i = j;
    }
    return out;
  },

  // Long strings inside a packed record move to media files: { $folio: 'ref', f: 'media/…' }
  extract(v, media) {
    if (typeof v === 'string' && v.length > this.BIG) {
      const h = Backup.hash(v), f = `media/${h.slice(0, 2)}/${h}.txt`;
      media.set(f, { h, text: v });
      return { $folio: 'ref', f };
    }
    if (Array.isArray(v)) return v.map(x => this.extract(x, media));
    if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = this.extract(v[k], media); return o; }
    return v;
  },
  inject(v, media) {
    if (Array.isArray(v)) return v.map(x => this.inject(x, media));
    if (v && typeof v === 'object') {
      if (v.$folio === 'ref') { const t = media.get(v.f); if (t === undefined) throw new Error('云端缺少 ' + v.f); return t; }
      const o = {}; for (const k in v) o[k] = this.inject(v[k], media); return o;
    }
    return v;
  },

  // Turn data into snapshot files. `src`: { stores: {name: rows}, keyPaths: {name: keyPath},
  // bookIds: [...], book(id) → content, reuse(id) → previous manifest entry for an unchanged book }.
  // Every logical file is a list of parts (usually one): [{ f, h, s }].
  // Returns { manifest, files: Map(relative path → { f, h, s, text? }) }.
  async build(src, { sha = true, books = true } = {}) {
    const manifest = { app: 'folio-repo', v: 1, db: DB.VERSION, createdAt: Date.now(), stores: {}, books: {}, media: {} };
    const files = new Map(), media = new Map(), enc = new TextEncoder();
    const add = async (f, text) => {
      const parts = this.split(text), list = [];
      for (const [i, t] of parts.entries()) {
        const p = parts.length > 1 ? f.replace(/(\.\w+)$/, `.p${i}$1`) : f;
        const e = { f: p, h: Backup.hash(t), s: sha ? await this.gitSha(enc.encode(t)) : '' };
        files.set(p, { ...e, text: t });
        list.push(e);
      }
      return list;
    };
    for (const [name, rows] of Object.entries(src.stores)) {
      const kp = src.keyPaths[name];
      const packed = [];
      let bytes = 0;
      for (const row of rows) {
        const t = JSON.stringify(this.extract(await Backup.pack(row), media));
        packed.push([Array.isArray(kp) ? kp.map(k => row[k]) : row[kp], t]);
        bytes += t.length;
      }
      let n = 1;
      while (n * this.SHARD < bytes) n *= 2;
      const shards = Array.from({ length: n }, () => []);
      for (const [key, t] of packed) shards[this.shardOf(key ?? '', n)].push(t);
      const list = [];
      for (const [i, sh] of shards.entries()) list.push(await add(`stores/${name}/${i}.json`, '[' + sh.join(',') + ']'));
      manifest.stores[name] = { count: rows.length, key: kp, files: list };
    }
    for (const [f, m] of media) manifest.media[f] = await add(f, m.text);
    if (books) {
      for (const id of src.bookIds) {
        const prev = src.reuse?.(id);
        if (prev) {                                  // unchanged: point at the files already uploaded
          manifest.books[id] = prev;
          for (const e of prev.files) files.set(e.f, { f: e.f, h: e.h, s: e.s });
          continue;
        }
        const c = await src.book(id);
        if (!c) continue;
        const text = JSON.stringify(await Backup.pack(c));
        manifest.books[id] = { h: Backup.hash(text), chapters: c.chapters?.length || 0,
          files: await add(`books/${this.dir(id)}/${encodeURIComponent(id)}.json`, text) };
      }
    }
    return { manifest, files };
  },

  // The database as a snapshot source
  async dbSource(reuse) {
    const stores = {}, keyPaths = {};
    for (const n of await DB.storeNames()) {
      if (n === 'contents' || n === 'snapshots' || n === 'device') continue;
      stores[n] = await DB.dump(n);
      keyPaths[n] = await DB.keyPath(n);
    }
    return { stores, keyPaths, bookIds: await DB.keys('contents'), book: id => DB.getContent(id), reuse };
  },

  // Write a snapshot into `prefix` in one commit. Files of the previous snapshot that the new one
  // does not use are removed in the same commit.
  async save(prefix, snap, message, guard) {
    return this.commit(message, { put: await this.files(prefix, snap), clear: [prefix], guard });
  },
  async files(prefix, { manifest, files }, put = new Map()) {
    for (const [p, f] of files) put.set(`${prefix}/${p}`, f);
    const mtext = JSON.stringify(manifest);
    put.set(`${prefix}/manifest.json`, { s: await this.gitSha(new TextEncoder().encode(mtext)), text: mtext });
    return put;
  },

  async manifest(prefix, ref) {
    const t = await this.file(`${prefix}/manifest.json`, ref);
    return t ? JSON.parse(t) : null;
  },

  // Download and check one file entry (or its parts)
  async text(e) {
    const t = new TextDecoder().decode(await this.blob(e.s));
    if (Backup.hash(t) !== e.h) throw new Error(e.f + ' 校验不一致');
    return t;
  },
  async pool(items, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(this.POOL, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
    }));
    return out;
  },

  // Read a snapshot. Parts whose checksum matches something this device already has
  // (`local`: Map(h → text)) are not downloaded. `want(id, entry)` picks the books to download.
  async read(manifest, { local = new Map(), want = () => true, onStep, keep = false } = {}) {
    if (manifest.app !== 'folio-repo') throw new Error('云端数据的格式不对');
    const whole = async parts => (await Promise.all(parts.map(e => local.has(e.h) ? local.get(e.h) : this.text(e)))).join('');
    for (const s of Object.values(manifest.stores)) for (const p of s.files) for (const e of p) this.known.add(e.s);
    for (const p of Object.values(manifest.media)) for (const e of p) this.known.add(e.s);
    for (const b of Object.values(manifest.books)) for (const e of b.files) this.known.add(e.s);
    const media = new Map();
    await this.pool(Object.entries(manifest.media), async ([f, parts]) => media.set(f, await whole(parts)));
    const stores = {};
    for (const [name, s] of Object.entries(manifest.stores)) {
      const rows = [];
      for (const t of await this.pool(s.files, whole)) for (const r of JSON.parse(t)) rows.push(Backup.unpack(this.inject(r, media)));
      if (rows.length !== s.count) throw new Error(`「${name}」数量不对（应有 ${s.count}，读到 ${rows.length}）`);
      if (s.key) {                                   // back in the database's own key order
        const k = r => Array.isArray(s.key) ? s.key.map(x => r[x]) : r[s.key];
        try { rows.sort((a, b) => indexedDB.cmp(k(a), k(b))); } catch { /* a key the database cannot compare: leave as is */ }
      }
      stores[name] = rows;
    }
    const ids = Object.keys(manifest.books).filter(id => want(id, manifest.books[id]));
    let done = 0;
    const books = await this.pool(ids, async id => {
      const b = manifest.books[id];
      // Books already downloaded by an attempt that stopped half way (rate limit, network) are
      // kept in this device's own store, so trying again continues instead of starting over
      const kept = keep ? await DB.getDevice('dl:' + b.h) : null;
      const text = kept?.text ?? await whole(b.files);
      if (keep && !kept) await DB.setDevice('dl:' + b.h, { text });
      if (Backup.hash(text) !== b.h) throw new Error(`《${id}》正文校验不一致`);
      onStep?.(++done, ids.length);
      return Backup.unpack(JSON.parse(text));
    });
    return { stores, books };
  },

  async dropKept() {
    for (const k of await DB.keys('device')) if (String(k).startsWith('dl:')) await DB.delDevice(k);
  },

  // What this device already holds, by checksum, so reading a snapshot downloads only the rest
  async localTexts() {
    const { files } = await this.build(await this.dbSource(), { sha: false, books: false });
    const out = new Map();
    for (const f of files.values()) out.set(f.h, f.text);
    return out;
  },
};
