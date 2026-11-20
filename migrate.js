// migrate.js — Moves a library from the secret gists (before v1.2.6) to a private repository.
//
// What moves: the sync snapshot and every book (index and books gists), the automatic cloud
// backup (backup gists) and everything waiting in the bookmark inbox (inbox gist).
// Safety rules:
//   • Nothing in the old gists is changed or deleted. Once the move is checked, one small file,
//     moved-to-repo.json, is added to the index gist so a second device on v1.2.6 knows to stop
//     writing there. The gists stay as a fallback; deleting them is left to the user.
//   • The old sync is finished first, so the gists hold this device's latest changes.
//   • Everything is written to the repository in one commit (all or nothing), then read back
//     from the repository and compared record by record and book by book with the gists.
//     Only after that does this device switch to the repository.
//   • An interrupted move simply runs again: the commit replaces what an earlier attempt wrote,
//     and the gists are untouched, so nothing is duplicated or lost.
//   • A second device does not move the data again: migration.json in the repository records the
//     move, and the second device joins the repository instead.
const Migrate = {
  async start() {
    const got = await Sync.askRepo({
      title: '升级到私有仓库',
      intro: '把同步、云端备份和收件箱从秘密 Gist 搬到只有你能看到的私有仓库。<b>旧 Gist 会原样保留</b>，检查通过之前这台设备继续用旧 Gist。',
      ok: '开始升级',
    });
    if (!got) return;
    const wait = quickSheet(`<div class="pk-title">正在升级…<small>请保持 Folio 打开；旧 Gist 不会被改动</small></div><p class="sync-note mg-step">准备中</p><div class="bk-spin"></div>`);
    const step = t => { const el = wait.card.querySelector('.mg-step'); if (el) el.textContent = t; };
    try {
      this.choose = null;
      const report = await this.run(got, step);
      await wait.close();
      await dialog({ title: report.startsWith('已连接到') ? '已连接私有仓库' : '升级完成，检查通过 ✓', message: report, ok: '好' });
      if (this.choose) {                              // joined with unsynced changes: pick the side to keep
        const msg = await Sync.connect(this.choose.token, this.choose.repo);
        if (msg) toast(msg);
      }
    } catch (e) {
      console.error(e);
      await wait.close();
      dialog({ title: '没有升级', ok: '好',
        message: (e instanceof TypeError ? '连不上 GitHub，请检查网络。' : e.message) + '\n\n这台设备仍然用旧 Gist 同步，什么都没有改变，可以稍后再试。' });
    }
  },

  // A gist file's text. A gist's file list stops at 300 files, so a file missing from the list
  // is read from its raw address instead (the checksum check catches a stale copy).
  async gistText(g, name) {
    const f = g.files[name];
    if (f) return Sync.fileText(f);
    if (Object.keys(g.files).length < 300 || !g.owner?.login) return null;
    const r = await fetch(`https://gist.githubusercontent.com/${g.owner.login}/${g.id}/raw/${encodeURIComponent(name)}`, { cache: 'no-store' });
    return r.ok ? r.text() : null;
  },
  canon: async rows => JSON.stringify(await Backup.pack(rows)),
  async keyPaths(names) {
    const have = await DB.storeNames(), out = {};
    for (const n of names) out[n] = have.includes(n) ? await DB.keyPath(n) : 'id';
    return out;
  },

  async run({ token, repo }, step) {
    if (Sync.repoMode) throw new Error('这台设备已经在用私有仓库了');
    const old = { token: Sync.st.token, index: Sync.st.index, books: Sync.st.books, inbox: Sync.st.inbox,
      backup: CloudBackup.st.gist, backupBooks: CloudBackup.st.booksGist };

    // 1. Finish the old sync, so the gists hold this device's latest changes
    step('先完成旧 Gist 上的同步…');
    await Sync.check(true);
    if (Sync.st.error) throw new Error('旧 Gist 同步出错：' + Sync.st.error);
    if (Sync.st.dirty && !Sync.st.moved) throw new Error('这台设备还有改动没有同步到旧 Gist，请稍后再试。');

    // 2. The repository: private, writable, and either empty of Folio data or moved from these gists
    step('检查私有仓库…');
    Repo.use({ token, repo });
    await Repo.open();
    const record = JSON.parse(await Repo.file('migration.json') || 'null');
    const existing = await Repo.manifest('sync');
    if (record && record.from?.index !== old.index) throw new Error(`「${repo}」里已经有另一个 Folio 书架。请换一个新的空仓库。`);
    if (!record && existing) throw new Error(`「${repo}」里已经有 Folio 书架（不是从这些 Gist 搬过来的）。请换一个新的空仓库，或者先断开这台设备的同步，再连接这个仓库。`);
    // Another device already moved these gists: join its repository, never move the data again.
    // Only the device that wrote the record may write it again (its own retry after a failed check).
    Sync.st.moveId ||= Math.random().toString(36).slice(2) + Date.now().toString(36);
    Sync.save();
    if (record && existing && record.by !== Sync.st.moveId) return this.join(record, { token, repo }, old);
    if (record && existing && existing.updatedAt !== record.updatedAt) return this.join(record, { token, repo }, old);

    // 3. Read everything from the gists
    step('读取旧 Gist 里的书架…');
    const ig = await Sync.api('/gists/' + old.index, {}, old.token);
    const itext = await this.gistText(ig, 'folio.json');
    const idx = itext ? JSON.parse(itext) : null;
    if (!idx || idx.app !== 'folio-sync') throw new Error('旧 Gist 里没有同步数据，没有可以搬的。');
    const bg = await Sync.api('/gists/' + old.books, {}, old.token);
    const books = new Map(), titles = new Map((idx.stores.meta || []).map(m => [m.id, bookName(m.title)]));
    let n = 0;
    for (const [id, h] of Object.entries(idx.contents || {})) {
      step(`读取旧 Gist 里的书 ${++n} / ${Object.keys(idx.contents).length}…`);
      const txt = await this.gistText(bg, 'book-' + id + '.json');
      if (!txt) throw new Error(`旧 Gist 缺少《${titles.get(id) || id}》的正文，没有升级。`);
      if (Sync.hash(txt) !== h) throw new Error(`旧 Gist 里《${titles.get(id) || id}》的正文和记录对不上，请过几分钟再试。`);
      books.set(id, JSON.parse(txt));
    }

    step('读取旧云端备份…');
    let backup = null;
    if (old.backup) {
      try { backup = await CloudBackup.read(); }
      catch (e) { if (!/还没有备份/.test(e.message)) throw new Error('旧云端备份读取失败：' + e.message); }
    }

    step('读取旧收件箱…');
    const inbox = new Map();
    if (old.inbox) {
      const g = await Sync.api('/gists/' + old.inbox, {}, old.token);
      const done = new Set(record?.inbox || []);         // already moved by an earlier attempt
      for (const name of Object.keys(g.files)) {
        if (!/^in-.*\.(html|b64)$/.test(name) && name !== 'library.json') continue;
        if (done.has(name)) continue;
        const t = await this.gistText(g, name);
        if (t) inbox.set(name, t);
      }
    }

    // 4. One commit with everything
    step('写入私有仓库…');
    const syncSnap = await Repo.build({ stores: idx.stores, keyPaths: await this.keyPaths(Object.keys(idx.stores)),
      bookIds: [...books.keys()], book: id => books.get(id) });
    Object.assign(syncSnap.manifest, { kind: 'sync', updatedAt: idx.updatedAt, device: idx.device });
    const put = await Repo.files('sync', syncSnap);
    let backupSnap = null;
    if (backup) {
      const byId = new Map(backup.books.map(b => [b.id, b]));
      backupSnap = await Repo.build({ stores: backup.stores, keyPaths: await this.keyPaths(Object.keys(backup.stores)),
        bookIds: [...byId.keys()], book: id => byId.get(id) });
      const ltext = JSON.stringify(backup.local), lent = { f: 'local.json', h: Backup.hash(ltext), s: await Repo.gitSha(new TextEncoder().encode(ltext)) };
      backupSnap.files.set('local.json', { ...lent, text: ltext });
      Object.assign(backupSnap.manifest, { kind: 'backup', device: backup.manifest.device || '', createdAt: backup.manifest.createdAt,
        summary: backup.manifest.summary, local: [lent] });
      await Repo.files('backup', backupSnap, put);
    }
    const enc = new TextEncoder();
    for (const [name, text] of inbox) put.set('inbox/' + name, { s: await Repo.gitSha(enc.encode(text)), text });
    const moved = [...new Set([...(record?.inbox || []), ...[...inbox.keys()].filter(k => k !== 'library.json')])];
    const rtext = JSON.stringify({ app: 'folio-migration', at: Date.now(), updatedAt: idx.updatedAt, by: Sync.st.moveId, device: Sync.st.device, from: old.index ? { index: old.index } : {}, inbox: moved }, null, 1);
    put.set('migration.json', { s: await Repo.gitSha(enc.encode(rtext)), text: rtext });
    await Repo.commit('Move Folio data from gists', { put, clear: backup ? ['sync', 'backup'] : ['sync'] });

    // 5. Read it all back from the repository and compare with the gists
    step('核对仓库里的数据…');
    const m = await Repo.manifest('sync');
    if (!m || m.updatedAt !== idx.updatedAt) throw new Error('仓库里的同步数据和旧 Gist 对不上。');
    const got = await Repo.read(m, { onStep: (i, total) => step(`核对仓库里的书 ${i} / ${total}…`) });
    const compare = async (want, have, what) => {
      for (const name of Object.keys(want.stores)) {
        if ((have.stores[name] || []).length !== want.stores[name].length) throw new Error(`${what}「${name}」数量不对`);
        if (await this.canon(have.stores[name]) !== await this.canon(want.stores[name])) throw new Error(`${what}「${name}」内容不一致`);
      }
      const byId = new Map(have.books.map(b => [b.id, b]));
      if (byId.size !== want.books.length) throw new Error(`${what}书的数量不对`);
      for (const b of want.books) if (await this.canon(byId.get(b.id)) !== await this.canon(b)) throw new Error(`${what}《${titles.get(b.id) || b.id}》正文不一致`);
    };
    await compare({ stores: idx.stores, books: [...books.values()] }, got, '同步数据');
    if (backup) {
      const bm = await Repo.manifest('backup');
      const bgot = await Repo.read(bm);
      await compare(backup, bgot, '云端备份');
      const lt = (await Promise.all(bm.local.map(e => Repo.text(e)))).join('');
      if (lt !== JSON.stringify(backup.local)) throw new Error('云端备份的设置不一致');
    }
    if (inbox.size) {
      const head = await Repo.head(), files = await Repo.ls(head.tree, 'inbox');
      for (const [name, text] of inbox) {
        const sha = files.get('inbox/' + name);
        // a work already collected by another device is gone from the inbox, which is fine
        if (sha && new TextDecoder().decode(await Repo.blob(sha)) !== text) throw new Error(`收件箱里的 ${name} 不一致`);
      }
    }

    // 6. Switch this device over
    await this.switchTo({ token, repo }, old, moved, Sync.st.base === idx.updatedAt && !Sync.st.dirty ? m : null);
    if (backup) CloudBackup.st.at = backup.manifest.createdAt || Date.now();
    CloudBackup.save();

    // 7. Tell a second device on v1.2.6 that the library moved (adds one file; nothing else changes)
    try { await Sync.patch(old.index, { 'moved-to-repo.json': { content: JSON.stringify({ repo, at: Date.now() }) } }, old.token); } catch { /* not needed for this device */ }
    setTimeout(() => Sync.check(), 500);

    const sum = Backup.summarize(idx.stores, [...books.values()]);
    return `已搬到私有仓库 ${repo}，并逐项核对一致：\n${Backup.describe(sum)}`
      + `\n云端备份：${backup ? '已搬过去' : await Repo.manifest('backup') ? '仓库里已经有了' : '旧 Gist 里没有，之后会自动备份'}`
      + `\n收件箱：${moved.length ? moved.length + ' 篇' : '空的'}`
      + '\n\n旧 Gist 原样保留在你的 GitHub 账号里。另一台设备也更新到 v1.2.6 后，在「设备同步」里点「升级到私有仓库」，填同一个仓库和令牌即可。请重新复制一次收书书签。';
  },

  // The library was already moved (from the other device) and the repository has moved on since:
  // join it; the usual last-changed-wins decision takes it from there
  // Nothing is written to the repository here: this device takes the library that is there.
  // If it has changes it never synced, it first asks which side to keep.
  async join(record, { token, repo }, old) {
    const dirty = Sync.st.dirty;
    await this.switchTo({ token, repo }, old, record.inbox || [], null);
    CloudBackup.st.dirty = false;                     // nothing new to back up until something changes here
    CloudBackup.save();
    if (dirty) {
      Sync.st.joined = false;                         // no upload until the choice is made
      Sync.save();
      this.choose = { token, repo };
      return `已连接到 ${repo}（${record.device ? '由' + record.device + '搬过去' : '另一台设备已经搬过去'}）。\n\n这台设备有还没同步的改动，接下来请选择保留哪一边的书架。\n\n旧 Gist 原样保留。请重新复制一次收书书签。`;
    }
    setTimeout(() => Sync.check(), 500);
    return `已连接到 ${repo}（${record.device ? '由' + record.device + '搬过去' : '另一台设备已经搬过去'}），会下载仓库里的书架，只下载这台设备没有或不一样的书。\n\n仓库里已有的数据不会被改写。旧 Gist 原样保留。请重新复制一次收书书签。`;
  },

  async switchTo({ token, repo }, old, copied, manifest) {
    const st = Sync.st;
    st.legacy = { token: old.token, index: old.index, books: old.books, inbox: old.inbox,
      backup: old.backup, backupBooks: old.backupBooks, copied: [...new Set([...copied, ...(st.inboxSeen || [])])], at: Date.now() };
    delete st.inboxSeen;
    Object.assign(st, { token, repo, branch: Repo.branch, error: null, moved: null, joined: true });
    delete st.index; delete st.books; delete st.inbox;
    st.hashes = {}; st.base = null;
    if (manifest) {
      // This device synced with exactly what was moved, but its copy may still be incomplete
      // (before v1.2.6 a device could miss books past the 300 files a gist lists): each book is
      // checked, and if any is missing or different the next sync downloads just those
      let all = true;
      for (const [id, b] of Object.entries(manifest.books)) {
        if (await Sync.bookHash(id) === b.h) st.hashes[id] = b.h; else all = false;
      }
      if (all) st.base = manifest.updatedAt;
      Sync.remote = manifest;
    }
    Sync.save();
    Sync.useRepo();
    delete CloudBackup.st.gist; delete CloudBackup.st.booksGist;
    CloudBackup.st.repoBooks = {};
    CloudBackup.st.dirty = true;                      // the next automatic backup goes to the repository
  },

  // After the move: the old gists are kept; the old bookmark may still deliver to the old inbox
  legacyPanel() {
    const l = Sync.st.legacy;
    const s = quickSheet(`
      <div class="pk-title">旧 Gist<small>${esc(fmtTime(l.at))} 搬到私有仓库</small></div>
      <p class="sync-note">旧的同步、备份和收件箱 Gist 还在你的 GitHub 账号里，Folio 没有删除或改动里面的数据（只加了一个说明文件）。<br>
      还没换新书签之前，旧书签送来的作品 Folio 照样会收（只读，不改旧 Gist）。</p>
      <div class="pk-list">
        <button class="pk-row muted" data-a="drop"><span>停用旧 Gist</span><small>两台设备都换了新书签后再停用；Gist 本身不会被删除</small></button>
      </div>
      <p class="sync-note">确认不需要以后，可以在 gist.github.com 上自己删除这些 Gist，并在 GitHub 设置里删掉旧的 Gist 令牌。</p>`);
    s.card.onclick = async e => {
      if (!e.target.closest('[data-a=drop]')) return;
      await s.close();
      if (!(await confirmDialog({ title: '停用旧 Gist？', message: '这台设备会忘掉旧令牌，不再读旧收件箱。旧 Gist 本身仍在你的 GitHub 账号里。', ok: '停用' }))) return;
      delete Sync.st.legacy;
      Sync.save();
      toast('已停用旧 Gist');
    };
  },
};
