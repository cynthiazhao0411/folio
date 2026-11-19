// desktop.js — Two ways to bring files in on a computer.
//
// Downloads folder (Chrome / Edge): you pick a folder once; Folio keeps the permission on this
// device only (database store `device`, never synced or backed up) and, each time you ask,
// imports the e-book files in it that it has not imported before. A file counts as seen by
// its path, size and modification time, so a re-downloaded or changed file is offered again.
// Folio reads the folder only when you tap 从下载文件夹收书, and only after the browser has
// your permission; it never reads anything on its own.
//
// Drag and drop: files dropped anywhere on the shelf are imported like files picked with
// 从文件导入 (same formats, same progress and report; one failing file never stops the others).

const BOOK_FILE = /\.(epub|txt|pdf|zip|html?)$/i;

const Downloads = {
  supported: () => typeof window.showDirectoryPicker === 'function',

  async pick() {
    const dir = await window.showDirectoryPicker({ id: 'folio-downloads', mode: 'read', startIn: 'downloads' });
    await DB.setDevice('downloads', dir);
    await DB.setDevice('downloads-seen', {});
    return dir;
  },

  // Files in the folder and one level of subfolders
  async scan(dir) {
    const out = [];
    const walk = async (d, prefix, depth) => {
      for await (const entry of d.values()) {
        if (entry.kind === 'directory') { if (depth < 1 && !entry.name.startsWith('.')) await walk(entry, prefix + entry.name + '/', depth + 1); continue; }
        if (!BOOK_FILE.test(entry.name) || entry.name.startsWith('.')) continue;
        const file = await entry.getFile();
        out.push({ path: prefix + entry.name, file, key: `${prefix}${entry.name}|${file.size}|${file.lastModified}` });
      }
    };
    await walk(dir, '', 0);
    return out;
  },

  async collect() {
    if (!this.supported()) return dialog({ title: '这个浏览器不支持', message: '下载文件夹收书需要电脑上的 Chrome 或 Edge。也可以把文件直接拖进书架。', ok: '好' });
    let dir = await DB.getDevice('downloads');
    try {
      if (!dir) {
        if (!(await confirmDialog({ title: '选择下载文件夹', message: '选一次你平时下载电子书的文件夹（比如「下载」）。以后点这里，Folio 就会把里面还没导入过的电子书文件收进书架。\n\nFolio 只在你点按钮时读取这个文件夹，权限只存在这台电脑上。', ok: '选择文件夹' }))) return;
        dir = await this.pick();
      }
      // The browser asks again after a restart; the request must come from this tap
      let perm = await dir.queryPermission?.({ mode: 'read' }) ?? 'granted';
      if (perm !== 'granted') perm = await dir.requestPermission({ mode: 'read' });
      if (perm !== 'granted') return dialog({ title: '没有读取权限', message: `浏览器没有允许读取「${dir.name}」。再点一次「从下载文件夹收书」并选择「允许」。`, ok: '好' });
      const all = await this.scan(dir);
      const seen = (await DB.getDevice('downloads-seen')) || {};
      const fresh = all.filter(f => !seen[f.key]);
      if (!fresh.length) {
        const bad = all.filter(f => seen[f.key] < 0).length;
        return this.panel(dir, !all.length ? `「${dir.name}」里没有电子书文件（EPUB、TXT、PDF、ZIP、HTML）。`
          : `「${dir.name}」里没有新的电子书文件：${all.length - bad} 个已经导入过${bad ? `，${bad} 个上次没能导入（文件有问题）` : ''}。`);
      }
      const { ok } = await importFileList(fresh.map(f => f.file), { open: false });
      // A failed file is remembered with a negative time so it is not reported on every scan;
      // its key holds size and date, so a fresh download of it is tried again, and so does a full recheck
      for (const f of fresh) seen[f.key] = ok.has(f.file) ? Date.now() : -Date.now();
      await DB.setDevice('downloads-seen', seen);
    } catch (err) {
      if (err?.name === 'AbortError') return;                  // the folder picker was closed
      if (err?.name === 'NotFoundError') {
        await DB.delDevice('downloads');
        return dialog({ title: '找不到下载文件夹', message: '之前选的文件夹不见了（可能被移动、改名或删除）。再点一次「从下载文件夹收书」重新选择。', ok: '好' });
      }
      if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return dialog({ title: '没有读取权限', message: '浏览器没有允许读取这个文件夹。', ok: '好' });
      console.error(err);
      dialog({ title: '读取下载文件夹出错', message: err?.message || String(err), ok: '好' });
    }
  },

  // Nothing new: say so, and offer to change or forget the folder
  panel(dir, message) {
    const s = quickSheet(`
      <div class="pk-title">下载文件夹<small>${esc(dir.name)}</small></div>
      <p class="sync-note">${esc(message)}</p>
      <div class="pk-list">
        <button class="pk-row" data-a="rescan"><span>把所有文件重新检查一遍</span><small>上次失败的也再试一次；已导入的书不会重复</small></button>
        <button class="pk-row" data-a="change"><span>换一个文件夹</span></button>
        <button class="pk-row muted" data-a="forget"><span>取消授权</span><small>Folio 不再记住这个文件夹</small></button>
      </div>`);
    s.card.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'change') { s.close(); try { await this.pick(); this.collect(); } catch (err) { if (err?.name !== 'AbortError') toast(err.message); } return; }
      await s.close();
      if (a === 'rescan') { await DB.setDevice('downloads-seen', {}); this.collect(); }
      if (a === 'forget') { await DB.delDevice('downloads'); await DB.delDevice('downloads-seen'); toast('已取消授权'); }
    };
  },
};

// ---------- drag and drop onto the shelf ----------
(() => {
  const shelf = document.getElementById('shelf');
  const reading = () => !document.getElementById('reader').classList.contains('hidden');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  const veil = Object.assign(document.createElement('div'), { className: 'drop-veil hidden', innerHTML: '<div class="drop-card">松手导入<small>EPUB、TXT、PDF、ZIP、HTML，可以一次拖多个</small></div>' });
  document.body.appendChild(veil);
  let depth = 0;
  const hide = () => { depth = 0; veil.classList.add('hidden'); };
  addEventListener('dragenter', e => { if (!hasFiles(e) || reading()) return; e.preventDefault(); depth++; veil.classList.remove('hidden'); });
  addEventListener('dragover', e => { if (!hasFiles(e) || reading()) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--depth <= 0) hide(); });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hide();
    if (reading() || !shelf) return;
    const files = [...e.dataTransfer.files];
    const books = files.filter(f => BOOK_FILE.test(f.name));
    const skipped = files.length - books.length;
    if (!books.length) return dialog({ title: '没有可以导入的文件', message: `拖进来的 ${files.length} 个文件都不是 Folio 能读的格式（EPUB、TXT、PDF、ZIP、HTML）。`, ok: '好' });
    importFileList(books).then(() => { if (skipped) toast(`另有 ${skipped} 个文件格式不支持，已跳过`); });
  });
})();
