// app.js — Application shell: library, import, settings, progress persistence
Reader.init();

// ================= Settings (persisted in localStorage) =================
const settings = Object.assign({ theme: 0, font: 19, turn: 'curl' },
  JSON.parse(localStorage.getItem('settings') || '{}'));
const THEMES = ['', 'theme-green', 'theme-night'];

const THEME_NAMES = ['浅色', '护眼', '深色'];
const THEME_ICONS = [
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14z"/><path d="M5 19l7-7"/></svg>',
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>',
];
function applySettings() {
  document.body.classList.remove(...THEMES.filter(Boolean));
  if (THEMES[settings.theme]) document.body.classList.add(THEMES[settings.theme]);
  const tb = document.getElementById('shelf-theme');
  if (tb) { tb.innerHTML = THEME_ICONS[settings.theme] + `<span>${THEME_NAMES[settings.theme]}</span>`; }
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc && document.getElementById('reader')?.classList.contains('hidden')) tc.content = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  document.documentElement.style.setProperty('--font-size', settings.font + 'px');
  Reader.turnMode = settings.turn;
  document.querySelector('#btn-turn span').textContent = settings.turn === 'curl' ? '仿真' : '平移';
  // Match the status bar to the page background (applies in standalone mode)
  document.querySelector('meta[name="theme-color"]').content =
    getComputedStyle(document.body).getPropertyValue('--bg').trim();
  localStorage.setItem('settings', JSON.stringify(settings));
}
applySettings();

// ================= Library =================
// The shelf itself lives in library.js
const renderShelf = () => Library.render();
Library.bind();
// Refresh: sync now (and collect works waiting in the inbox), then redraw the shelf
document.getElementById('btn-refresh').onclick = async e => {
  const btn = e.currentTarget;
  if (btn.classList.contains('spinning')) return;
  btn.classList.add('spinning');
  const before = JSON.stringify((await DB.allMeta()).map(m => [m.id, m.chapterCount, m.lastReadAt]));
  try {
    if (Sync.on) await Sync.check(true);
    await renderShelf();
    const after = JSON.stringify((await DB.allMeta()).map(m => [m.id, m.chapterCount, m.lastReadAt]));
    toast(Sync.on && Sync.st.error ? '同步失败：' + Sync.st.error
      : before !== after ? '书架已更新' : Sync.on ? '已是最新 · 刚刚同步' : '已是最新（未开启设备同步）');
  } finally {
    setTimeout(() => btn.classList.remove('spinning'), 400);
  }
};
document.getElementById('continue').onclick = e => {
  const id = e.currentTarget.dataset.id;
  if (id) openBook(id, e.currentTarget.querySelector('.cover'));
};

// ================= Opening books / saving progress =================
let current = null, saveTimer = null;

// The shelf stays rendered underneath the reader, so its scroll position survives.
let animating = false;
async function openBook(id, fromCover) {
  if (animating) return;
  animating = true;
  const reader = document.getElementById('reader');
  try {
    const meta = await DB.getMeta(id);
    const content = await DB.getContent(id);
    meta.lastReadAt = Date.now();
    delete meta.newChapters;                                   // the new-chapter badge is cleared once seen
    current = meta;
    DB.putMeta(meta);
    Reader.setAnnots(await DB.notesFor(id));                  // bookmarks, highlights, notes
    reader.style.opacity = '0';                                // lay out invisibly first
    Reader.open({ ...meta, chapters: content.chapters }, meta.progress);
    if (!meta.words) { meta.words = Reader.wordCount; DB.putMeta(meta); }   // books imported before word counts existed
    if (meta.est?.chapters?.length !== content.chapters.length || meta.est?.speed !== READ_SPEED) { meta.est = estimateBook(content.chapters); DB.putMeta(meta); }
    if (meta.t2s === undefined) { meta.t2s = Reader.t2s; DB.putMeta(meta); }  // remember the script detection
    t2sLabel();
    Clock.start(id);
    Session.begin(meta);
    const run = currentRun(meta);                          // the read-through this opening belongs to
    if (!run.start) { run.start = Session.cur.start; DB.putMeta(meta); }
    const cover = fromCover || document.querySelector(`.card[data-id="${CSS.escape(id)}"] .cover`);
    if (cover) await BookAnim.open(cover, reader);
    else await BookAnim.fadeIn(reader);
  } catch (err) {
    // Never leave the app stuck: show the error and stay on the shelf
    console.error(err);
    reader.classList.add('hidden');
    reader.style.opacity = '';
    document.querySelectorAll('.book-anim').forEach(n => n.remove());
    document.querySelectorAll('.card .cover').forEach(c => { c.style.visibility = ''; });
    current = null;
    toast('打开失败：' + err.message);
  } finally {
    animating = false;
  }
}

async function closeBook() {
  if (animating) return;
  animating = true;
  Reader.closeMenu();
  const reader = document.getElementById('reader');
  try {
    await Clock.stop();                                        // save the last seconds of reading time
    const id = current?.id;
    if (current) await DB.putMeta(current);
    await Session.end(current);
    current = null;
    await renderShelf();                                       // refresh progress on the cards
    const card = id && document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (card) {
      const r = card.getBoundingClientRect();
      if (r.top < 60 || r.bottom > innerHeight - 20) card.scrollIntoView({ block: 'center' });
      await BookAnim.close(card.querySelector('.cover'), reader);
    } else {
      await BookAnim.fadeOut(reader);
    }
  } catch (err) {
    console.error(err);
    document.querySelectorAll('.book-anim').forEach(n => n.remove());
  } finally {
    reader.classList.add('hidden');
    reader.style.opacity = '';
    reader.getAnimations().forEach(a => a.cancel());
    animating = false;
    Sync.check();                                              // upload this session / take news from the other device
  }
}

Reader.store = { put: rec => DB.putNote(rec), del: id => DB.delNote(id) };
Reader.metaInfo = () => current;

// ================= Reading sessions =================
// One record per opening of a book: when, how long (effective reading time), and from
// where to where. Title and authors are copied in so history outlives a deleted book.
const Session = {
  cur: null,
  pos: p => p ? { ch: p.ch, frac: +(p.frac || 0).toFixed(4), pct: +(p.pct || 0).toFixed(2) } : { ch: 0, frac: 0, pct: 0 },
  begin(m) {
    const now = Date.now();
    this.cur = { id: 's-' + now.toString(36) + Math.random().toString(36).slice(2, 6), bookId: m.id,
                 title: m.title, authors: m.authors || [], start: now, end: now, ms: 0,
                 from: this.pos(m.progress), to: this.pos(m.progress) };
    DB.putSession(this.cur);
  },
  touch(m, ms = 0) {
    if (!this.cur || this.cur.bookId !== m?.id) return;
    this.cur.end = Date.now();
    this.cur.ms += ms;
    this.cur.to = this.pos(m.progress);
    return DB.putSession(this.cur);
  },
  async end(m) {
    await this.touch(m);
    this.cur = null;
  },
};

// ================= Screen stays on while reading =================
// Same rule as the reading clock: after 90 s without a touch the lock is let go and the
// phone's own auto-lock takes over; the next touch keeps the screen on again.
const Awake = {
  lock: null,
  async check() {
    const want = !!current && !document.hidden && !Clock.idle();
    try {
      if (want && !this.lock && navigator.wakeLock) {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener('release', () => { this.lock = null; });
      } else if (!want && this.lock) {
        await this.lock.release();
        this.lock = null;
      }
    } catch { this.lock = null; }       // not supported, or refused (e.g. low power mode)
  },
};
setInterval(() => Awake.check(), 3000);
['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, () => Awake.check(), { passive: true }));
document.addEventListener('visibilitychange', () => Awake.check());

// ================= Reading time =================
Clock.init();
Clock.onFlush = async (bookId, ms) => {
  await DB.addDaily(new Date().toLocaleDateString('sv'), bookId, ms);
  const m = current?.id === bookId ? current : await DB.getMeta(bookId);
  if (!m) return;
  m.readMs = (m.readMs || 0) + ms;
  const run = currentRun(m);
  run.ms += ms;
  if (!run.start) run.start = Date.now() - ms;
  if (checkFinished(m)) {
    // The finished read-through: how many times the book was opened for it, from the session records
    const r = m.readThroughs[m.readThroughs.length - 1];
    try { const o = await countOpens(m.id, r.start, r.end); r.opens = o.opens; r.start = r.start || o.first; } catch { /* the count is extra */ }
    celebrate(m);
  }
  await DB.putMeta(m);
  await Session.touch(m, ms);
};
function celebrate(m) {
  toast(m.reads > 1 ? `读完了 · 这是第 ${m.reads} 遍` : '读完了这本书 ✦');
  if (!m.rating) setTimeout(() => askRating(m), 1200);
}

StatsPage.bind();
document.getElementById('btn-stats').onclick = () => StatsPage.open();

// ================= Front pages =================
// Page 1 is the cover: the book jacket centered, the title, characters, tags and the summary.
// Page 2 shows just three figures and an invitation to start the story.
// Known metadata kinds are matched loosely by name; nothing else is shown.
const TP_KNOWN = { cp: /relationship|pairing|\bcp\b/i, chars: /character/i, tags: /tag/i,
                   series: /series/i, stats: /stat/i };

function titlePageHTML(b, wordCount) {
  const tags = b.tags || {}, keys = Object.keys(tags);
  const get = re => { const k = keys.find(k => re.test(k)); return k ? tags[k].filter(Boolean) : []; };
  const series = get(TP_KNOWN.series), chars = get(TP_KNOWN.chars), tagList = get(TP_KNOWN.tags);
  const statsText = get(TP_KNOWN.stats)[0] || '';
  const stat = name => (statsText.match(new RegExp(name + ':\\s*(\\S+)')) || [])[1];
  const sub = coverSubtitle(b);

  // ---- page 1: cover ----
  const list = (vals, n) => esc(vals.slice(0, n).join('、')) + (vals.length > n ? ` 等${vals.length}人` : '');
  const lines = [
    chars.length ? `<div class="tp-line"><span>角色</span>${list(chars, 3)}</div>` : '',
    tagList.length ? `<div class="tp-line"><span>标签</span>${esc(tagList.slice(0, 4).join(' · '))}</div>` : '',
  ].join('');
  const summary = Object.assign(document.createElement('div'), { innerHTML: b.summary || '' }).textContent.trim();
  const cover = `
    <div class="tp">
      ${series.length ? `<div class="tp-series">${esc(series[0])}</div>` : ''}
      ${jacket(b, 'tp-cover')}
      ${coverCP(b) ? `<div class="tp-cp">CP<i>·</i>${esc(coverCP(b))}</div>` : ''}
      ${(() => { const t = splitTitle(bookName(b.title)); return `
      <div class="tp-title"${(() => { const c = titleShades(b.coverColor || bookColor(b)); return c ? ` style="--tt-dark:${c.dark};--tt-light:${c.light}"` : ''; })()}>${wordBreaks(t.main)}</div>`; })()}
      ${lines ? `<div class="tp-lines">${lines}</div>` : ''}
      ${summary ? `<div class="tp-summary">${esc(summary)}</div>` : ''}
    </div>`;

  // ---- page 2: three figures ----
  const words = +(stat('Words') || '').replace(/,/g, '') || wordCount;
  const date = stat('Completed') || stat('Updated') || stat('Published');
  const dateLabel = stat('Completed') ? '完结' : stat('Updated') ? '更新' : '发布';
  const figures = [
    words >= 10000 ? [(words / 10000).toFixed(1), '万字'] : [String(words), '字'],
    [String(b.chapters?.length || b.chapterCount), '章'],
    date ? [date.replace(/-/g, '.'), dateLabel] : null,
  ].filter(Boolean);
  const info = `
    <div class="ip" style="--c:${b.coverColor || bookColor(b)}">
      <div class="ip-figures">
        ${figures.map(([v, l]) => `<div class="ip-fig"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('<div class="ip-dot"></div>')}
      </div>
      <button class="ip-start">翻开，开始故事<i>→</i></button>
    </div>`;
  // ---- after the last chapter: The End ----
  const end = `
    <div class="ip ep" style="--c:${b.coverColor || bookColor(b)}">
      <div class="ep-mid"><div class="ep-end">The End</div><div class="ep-rule"></div><div class="ep-zh">全文完</div></div>
      <div class="ep-mark">Folio</div>
    </div>`;
  return { cover, info, end };
}
Reader.titlePageHTML = titlePageHTML;

Reader.coverHTML = b => {
  const sub = coverSubtitle(b);
  return jacket(b, 'mini');
};

// Called on every page turn; writes are debounced by 400 ms
Reader.onProgress = p => {
  if (!current) return;
  current.progress = p;
  if (checkFinished(current)) celebrate(current);
  clearTimeout(saveTimer);
  const m = current;                      // the book may be closed before the timer fires
  saveTimer = setTimeout(() => DB.putMeta(m), 400);
};

// ================= Import =================
// From files (the 导入 button) or from the clipboard (see the share-sheet shortcut in the README)
const MIN_TEXT = 20;                                       // fewer characters than this is "no text", not a book
const importError = err => /quota/i.test(err?.name + ' ' + err?.message) ? '存储空间不足' : (err?.message || '未知错误');
const bookText = chapters => chapters.reduce((n, c) => n + c.html.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s/g, '').length, 0);

// A progress message that stays up until done() (toast() disappears on its own)
function progressToast() {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: '' });
  document.body.appendChild(t);
  return { set: msg => { t.textContent = msg; }, done: () => t.remove() };
}

// sources: [{ book, label }]. Returns { count, updated, added, failed: [{ label, error }] }.
// A book only counts once its text AND its record have been written and read back; if any step
// fails the book is rolled back (or its previous version restored), so the shelf never holds a
// record without text, and the numbers reported always match what is really on the shelf.
async function importBooks(sources, open = true, onProgress) {
  let lastId = null, count = 0, updated = 0, same = 0;
  const failed = [];
  for (const [i, { book, label }] of sources.entries()) {
    onProgress?.(i + 1, sources.length);
    if (!book.chapters.length) { failed.push({ file: sources[i].file, label, error: '没有读到正文' }); continue; }
    const words = bookText(book.chapters);
    if (words < MIN_TEXT) { failed.push({ file: sources[i].file, label, error: '内容是空的或文字太少' }); continue; }
    let old = null, oldContent = null;
    try {
      old = await DB.getMeta(book.id);
      oldContent = old ? await DB.getContent(book.id) : null;
      const { chapters, ...info } = book;
      // Re-importing a book keeps everything you did with it on the shelf
      const keep = {};
      for (const k of ['readMs', 'reads', 'run', 'finished', 'readThroughs', 'cover', 'coverColor', 'pinned', 'folder', 'userTags', 'rating', 'status', 'hidden', 'renamed', 'palette'])
        if (old?.[k] !== undefined) keep[k] = old[k];
      for (const k of ['ratings', 'reviews', 'versions', 'newChapters'])
        if (old?.[k] !== undefined) keep[k] = old[k];
      if (old?.renamed) info.title = old.title;
      // Every import that changes the book is remembered; new chapters get a badge on the shelf
      const versions = [...(keep.versions || [])];
      const prev = versions[versions.length - 1] || (old ? { chapters: old.chapterCount, words: old.words } : null);
      if (!prev || prev.chapters !== chapters.length || prev.words !== words) versions.push({ at: Date.now(), chapters: chapters.length, words });
      const added = old ? chapters.length - (old.chapterCount || 0) : 0;
      if (added > 0) keep.newChapters = (keep.newChapters || 0) + added;
      // Text first, record second: a failure in between can never leave a record without text
      await DB.putContent({ id: book.id, chapters });
      await DB.putMeta({
        ...info,
        ...keep,
        versions,
        chapterCount: chapters.length,
        words,
        est: estimateBook(chapters),
        addedAt: old?.addedAt || Date.now(),
        lastReadAt: old?.lastReadAt,
        progress: old?.progress,
      });
      const [m, c] = await Promise.all([DB.getMeta(book.id), DB.getContent(book.id)]);   // read back to be sure
      if (!m || !c?.chapters?.length) throw new Error('写入后读不到，没有保存成功');
      if (old) updated++;
      if (old && old.chapterCount === chapters.length && old.words === words) same++;   // already on the shelf, nothing changed
      lastId = book.id; count++;
    } catch (err) {
      console.error(err);
      try {                                                  // undo this book only
        if (old) { if (oldContent) await DB.putContent(oldContent); await DB.putMeta(old); }
        else await DB.remove(book.id);
      } catch (e2) { console.error('rollback failed', e2); }
      failed.push({ file: sources[i].file, label, error: importError(err), retry: true });   // storage problem: worth trying again
    }
  }
  try { await renderShelf(); } catch (err) { console.error(err); }
  if (count === 1 && open && !failed.length) openBook(lastId);  // open right away when a single book comes in
  return { count, updated, same, added: count - updated, failed };
}
// "新增 2 本 · 更新 1 本 · 3 本已在书架（没有变化）"
const importSummary = r => {
  const parts = [];
  if (r.added) parts.push(`新增 ${r.added} 本`);
  if (r.updated - (r.same || 0) > 0) parts.push(`更新 ${r.updated - (r.same || 0)} 本`);
  if (r.same) parts.push(`${r.same} 本已在书架（没有变化）`);
  return parts.join(' · ') || '没有新书';
};

// One honest report for every import: what really went onto the shelf and what did not
function reportImport(res, failed) {
  if (!failed.length) { if (res.count > 1 || res.updated) toast(importSummary(res)); return; }
  const list = failed.slice(0, 8).map(f => `${f.label}：${f.error}`);
  if (failed.length > 8) list.push(`…另有 ${failed.length - 8} 个`);
  dialog({
    title: res.count ? `导入了 ${res.count} 本，${failed.length} 个失败` : `没有导入任何书（${failed.length} 个失败）`,
    message: (res.count ? importSummary(res) + '\n\n' : '') + list.join('\n'),
    ok: '好',
  });
}

// Import a list of files (picker, drag and drop, downloads folder). Each file stands alone:
// one that cannot be read or saved never stops the others. Returns the files that made it.
async function importFileList(files, { open = true, reportDone = true } = {}) {
  const progress = progressToast();
  const ok = new Set(files);
  try {
    const sources = [], parseFailed = [];
    for (const [i, file] of files.entries()) {
      progress.set(files.length > 1 ? `正在读取 ${i + 1} / ${files.length}：${file.name}` : '正在读取…');
      for (const r of await Importer.parseFile(file)) {
        if (r.error) { parseFailed.push(r); ok.delete(file); } else sources.push({ ...r, file });
      }
    }
    const res = await importBooks(sources, open && sources.length === 1 && !parseFailed.length,
      (i, n) => progress.set(n > 1 ? `正在导入 ${i} / ${n}…` : '正在导入…'));
    for (const f of res.failed) ok.delete(f.file);
    progress.done();
    if (reportDone) reportImport(res, [...parseFailed, ...res.failed]);
    return { res, ok, failed: [...parseFailed, ...res.failed] };
  } catch (err) {
    console.error(err);
    progress.done();
    dialog({ title: '导入出错', message: importError(err), ok: '好' });
    return { res: null, ok: new Set(), failed: [] };
  }
}

document.getElementById('picker').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) importFileList(files);
});

// The 导入 button offers two ways in: a file, or a work copied to the clipboard
document.getElementById('btn-import').onclick = e => {
  const items = [['imp-file', '从文件导入'], ['imp-paste', '粘贴作品或链接']];
  if (Downloads.supported()) items.push(['imp-folder', '从下载文件夹收书']);
  Library.popover(e.currentTarget, items, [], true);
};
// A pasted link: collect the book straight from the site when the site allows it (links.js)
async function importFromLink(link) {
  const progress = progressToast();
  try {
    const r = await LinkImport.collect(link, msg => progress.set(msg));
    progress.done();
    if (r.blocked) {
      return dialog({ title: '这个网站不让 Folio 直接读取', ok: '好',
        message: `${r.blocked} 不允许别的网页读取它的内容，所以 Folio 不能从链接直接收书。\n\n请在浏览器里打开这个网页，点「Folio 收书」书签：在网站自己的页面上，能下载的电子书文件会列出来，选好就送进书架。也可以先下载文件，再从「导入」里选它。` });
    }
    if (r.error) return dialog({ title: '没能收书', message: r.error, ok: '好' });
    const res = await importBooks(r.sources, r.sources.length === 1 && !r.failed.length);
    if (r.failed.length) dialog({ title: '有文件没能导入', message: r.failed.map(f => `${f.label}：${f.error}`).join('\n'), ok: '好' });
    else if (res.count !== 1) toast(importSummary(res));
  } catch (err) {
    progress.done();
    dialog({ title: '没能收书', message: err.message, ok: '好' });
  }
}

async function importFromClipboard() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { return toast('没有读取剪贴板的权限'); }
  if (/^\s*https?:\/\/\S+\s*$/.test(text || '')) return importFromLink(text.trim());
  if (!text || text.length < 200) return toast('剪贴板里没有作品内容或链接');
  const progress = progressToast();
  try {
    const sources = [], parseFailed = [];
    // Several works copied by the 收书 bookmark come as one bundle
    const items = text.startsWith('{"app":"folio-bundle"') ? JSON.parse(text).items || [] : [{ html: text }];
    for (const [i, it] of items.entries()) {
      try {
        if (it.b64) {                                // an e-book file copied by the bookmark
          const bin = atob(it.b64), bytes = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          for (const r of await booksFromFile(new Blob([bytes]), it.name || 'book.epub', it.meta)) {
            if (r.book) sources.push({ book: r.book, label: bookName(r.book.title) }); else parseFailed.push({ label: r.label, error: r.error });
          }
        } else { const book = Importer.parseText(it.html, '粘贴的作品'); sources.push({ book, label: bookName(book.title) }); }
      } catch (err) { parseFailed.push({ label: `第 ${i + 1} 篇`, error: importError(err) }); }
    }
    const res = await importBooks(sources, sources.length === 1 && !parseFailed.length,
      (i, n) => progress.set(n > 1 ? `正在导入 ${i} / ${n}…` : '正在导入…'));
    progress.done();
    const failed = [...parseFailed, ...res.failed];
    if (!failed.length && res.count === 1 && sources.length === 1 && items.length === 1) toast(`已导入《${bookName(sources[0].book.title)}》`);
    else reportImport(res, failed);
  } catch (err) {
    console.error(err);
    progress.done();
    dialog({ title: '导入出错', message: importError(err), ok: '好' });
  }
}
// Opening the app with #paste (from the shortcut) shows a one-tap paste prompt;
// browsers only let a page read the clipboard right after a tap.
if (location.hash === '#paste') {
  history.replaceState(null, '', location.pathname);
  setTimeout(() => confirmDialog({ title: '导入刚复制的作品？', message: '从剪贴板读取并加入书架', ok: '粘贴导入' })
    .then(ok => ok && importFromClipboard()), 400);
}

// ================= Reader menu =================
document.getElementById('btn-back').onclick = closeBook;
document.getElementById('btn-toc').onclick = () => Reader.showToc();
document.getElementById('btn-bookmark').onclick = () => Reader.toggleBookmark();
// Paper colour: one tap on the shelf (bottom corner) or in the reader's bottom bar
function nextTheme() {
  document.body.classList.add('theme-fade');
  settings.theme = (settings.theme + 1) % THEMES.length;
  applySettings();
  clearTimeout(nextTheme.t);
  nextTheme.t = setTimeout(() => document.body.classList.remove('theme-fade'), 450);
}
document.getElementById('btn-theme').onclick = nextTheme;
document.getElementById('shelf-theme').onclick = nextTheme;     // the pill's own label shows the new colour
function setFont(d) {
  settings.font = Math.min(28, Math.max(14, settings.font + d));
  applySettings();
  Reader.relayout();
}
document.getElementById('btn-smaller').onclick = () => setFont(-1);
document.getElementById('btn-bigger').onclick = () => setFont(+1);
// 简 / 原文: show a traditional-script book in simplified characters (remembered per book)
const t2sLabel = () => { document.querySelector('#btn-t2s span').textContent = Reader.t2s ? '简体' : '原文'; };
document.getElementById('btn-t2s').onclick = () => {
  if (!current) return;
  current.t2s = !Reader.t2s;
  Reader.setT2S(current.t2s);
  t2sLabel();
  DB.putMeta(current);
  toast(current.t2s ? '已转为简体显示' : '显示原文');
};
document.getElementById('btn-turn').onclick = () => {
  settings.turn = settings.turn === 'curl' ? 'slide' : 'curl';
  applySettings();
};

// ================= Backup / restore =================
// Opened from the 收书 panel's "打开 Folio": either a link to Folio's own address marked #from=collect
// (Chrome opens it in the installed app: navigation capturing) or a web+folio:// link (the manifest's
// protocol_handlers, which Chrome registers with the operating system when Folio is installed; it
// arrives as ?open=...). Either way, collect the inbox now and show the shelf. When Folio is already
// open, launch_handler focus-existing brings that window forward and the launch arrives in launchQueue.
// The marker is removed from the address so a reload does not repeat it.
const FROM_COLLECT = /#from=collect|[?&]open=web(%2B|\+)folio/i;
const fromCollect = FROM_COLLECT.test(location.href);
// Temporary Web Push test (pushtest.js): opened from a notification (?from=push), or brought
// forward by one (sw.js posts 'push-open'); recorded, then synced as on any launch
const fromPush = /[?&]from=push/.test(location.href);
if (fromPush) history.replaceState(null, '', location.pathname);
if (fromPush) addEventListener('load', () => setTimeout(() => PushTest.arrived('url'), 300));
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'push-open') PushTest.arrived('focus'); });
if (fromCollect) history.replaceState(null, '', location.pathname);
async function collectNow() {
  if (!Sync.on) return;
  await Sync.check(true);
  if (Sync.reading()) return;                              // never under an open book; the shelf redraws on close
  await Library.render();
}
if (fromCollect) addEventListener('load', () => setTimeout(collectNow, 300));
if ('launchQueue' in window) launchQueue.setConsumer(p => { if (FROM_COLLECT.test(p?.targetURL || '')) collectNow(); });

function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
const moreSheet = document.getElementById('more-sheet');
document.getElementById('btn-more').onclick = async () => {
  document.getElementById('sync-sub').textContent = Sync.summary();
  document.getElementById('btn-undo-restore').classList.toggle('hidden', !(await Backup.canUndo()));
  Sheet.open(moreSheet);
};
document.getElementById('btn-sync').onclick = async () => { await Sheet.close(moreSheet); Sync.openPanel(); };
document.getElementById('btn-more-close').onclick = () => Sheet.close(moreSheet);
document.getElementById('btn-hidden').onclick = async () => {
  await Sheet.close(moreSheet);
  Library.showHidden = true; Library.filter = 'all';
  Library.render();
};

// Desktop browsers (Chrome, Edge, Safari) also expose the Web Share API, but sharing a file there needs
// a fresh click and a share target. Reading every store takes time, so the click had already expired and
// the share failed with NotAllowedError, which was swallowed as "user cancelled": the button did nothing.
// The share sheet is now used on touch devices only, and any share error other than a cancel falls back
// to a normal download.
const useShareSheet = file => !!navigator.canShare && matchMedia('(pointer: coarse)').matches && navigator.canShare({ files: [file] });

// The link goes into the page before the click (Firefox ignores clicks on detached links) and the
// object URL stays alive long enough for large files to finish saving.
function downloadFile(file) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name, hidden: true });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(a.href); }, 30000);
}

// Save a file: the share sheet on phones ("Save to Files"), a download elsewhere. Must run
// straight from a tap, so it is only ever called from a button's click handler.
async function saveFile(file) {
  if (useShareSheet(file)) {
    try { await navigator.share({ files: [file] }); return true; }
    catch (err) { if (err?.name === 'AbortError') return false; }
  }
  downloadFile(file);
  return true;
}

// 备份书架: build the complete backup (backup.js), check it, then offer the file with a button
// (the save needs a fresh tap: building a large backup takes longer than a tap stays valid)
document.getElementById('btn-backup').onclick = async () => {
  await Sheet.close(moreSheet);
  const wait = quickSheet(`<div class="pk-title">正在备份…<small>打包所有书、进度、笔记和设置，并逐项检查</small></div><div class="bk-spin"></div>`);
  let result;
  try { result = await Backup.create(); }
  catch (err) {
    console.error('backup failed', err);
    await wait.close();
    return dialog({ title: '备份失败', message: err?.message || '未知错误', ok: '好' });
  }
  await wait.close();
  const name = `folio-backup-${new Date().toLocaleDateString('sv')}.zip`;
  const file = new File([result.blob], name, { type: 'application/zip' });
  const size = result.blob.size < 1048576 ? Math.max(1, Math.round(result.blob.size / 1024)) + ' KB' : (result.blob.size / 1048576).toFixed(result.blob.size > 10485760 ? 0 : 1) + ' MB';
  const s = quickSheet(`
    <div class="pk-title">备份已生成，检查通过 ✓<small>${name} · ${size}</small></div>
    <p class="bk-sum">${esc(Backup.describe(result.manifest.summary)).replace(/\n/g, '<br>')}</p>
    <p class="sync-note">恢复时在「⋯ → 恢复备份」里选这个文件即可，不用解压。</p>
    <div class="pk-list"><button class="pk-row strong" data-a="save"><span>保存备份文件</span></button></div>`);
  s.card.onclick = async e => {
    if (!e.target.closest('[data-a=save]')) return;
    if (await saveFile(file)) { localStorage.setItem('folio-backup-at', Date.now()); s.close(); }
  };
};

// 恢复备份: read and check the whole file first, show what is in it, then merge or replace
document.getElementById('restore-picker').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  await Sheet.close(moreSheet);
  if (!file) return;
  let data;
  try { data = await Backup.read(file); }
  catch (err) { return dialog({ title: '无法恢复', message: err.message, ok: '好' }); }
  restoreFlow(data);
});

// Show what a backup holds, ask merge or replace, restore, report (used for files and the cloud)
async function restoreFlow(data) {
  const sum = Backup.summarize(data.stores, data.books);
  const when = data.manifest.createdAt ? new Date(data.manifest.createdAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
  const mode = await new Promise(resolve => {
    const s = quickSheet(`
      <div class="pk-title">恢复这个备份？<small>${esc(when)}${data.manifest.device ? ' · 来自' + esc(data.manifest.device) : ''}</small></div>
      <p class="bk-sum">${esc(Backup.describe(sum)).replace(/\n/g, '<br>')}</p>
      <div class="pk-list">
        <button class="pk-row col" data-m="merge"><span>合并到现在的书架</span><small>备份里的书和记录放回来，这台设备上多出来的都保留</small></button>
        <button class="pk-row col" data-m="replace"><span>完全替换成备份</span><small>书架变得和备份时一模一样</small></button>
      </div>
      <p class="sync-note">恢复前会先自动保存现在的书架，恢复后不满意可以在「⋯」里撤销。</p>`);
    s.card.onclick = async ev => {
      const m = ev.target.closest('[data-m]')?.dataset.m;
      if (!m) return;
      await s.close();
      resolve(m);
    };
    s.root.addEventListener('click', ev => { if (ev.target === s.root) resolve(null); });
  });
  if (!mode) return;
  if (mode === 'replace' && !(await confirmDialog({ title: '完全替换？', message: '现在书架上不在备份里的书和记录会被移走（可以撤销）。', ok: '替换', danger: true }))) return;
  try {
    const { unknown } = await Backup.apply(data, mode);
    Object.assign(settings, JSON.parse(localStorage.getItem('settings') || '{}'));
    applySettings();
    await renderShelf();
    dialog({ title: '恢复完成，检查通过 ✓', ok: '好',
      message: Backup.describe(sum) + (unknown.length ? `\n\n备份来自更新的 Folio，${unknown.join('、')} 需要先把这台设备更新到最新版本再恢复一次。` : '') });
  } catch (err) {
    console.error(err);
    await renderShelf();
    dialog({ title: '恢复没有完成', message: err.message, ok: '好' });
  }
}

document.getElementById('btn-undo-restore').onclick = async () => {
  await Sheet.close(moreSheet);
  if (!(await confirmDialog({ title: '撤销上次恢复？', message: '书架会回到上次恢复之前的样子。', ok: '撤销' }))) return;
  try {
    await Backup.undo();
    Object.assign(settings, JSON.parse(localStorage.getItem('settings') || '{}'));
    applySettings();
    await renderShelf();
    toast('已回到恢复之前');
  } catch (err) { dialog({ title: '撤销失败', message: err.message, ok: '好' }); }
};

// ================= Offline cache + persistent storage =================
// Service workers require HTTPS (or localhost); registration silently fails otherwise
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.();

renderShelf();
Sync.init();
CloudBackup.init();

// Without device sync, the data lives only on this device: a gentle weekly reminder to back up
setTimeout(async () => {
  if (Sync.on || !(await DB.allMeta()).length) return;
  if (!localStorage.getItem('folio-backup-at')) localStorage.setItem('folio-backup-at', Date.now());   // start counting now
  const at = +localStorage.getItem('folio-backup-at'), asked = +localStorage.getItem('folio-backup-asked') || 0;
  const week = 7 * 864e5;
  if (Date.now() - at > week && Date.now() - asked > week) {
    localStorage.setItem('folio-backup-asked', Date.now());
    toast('一周没备份了：可以在「⋯」里备份或开启设备同步');
  }
}, 4000);

// Books imported before estimated reading times existed get theirs once, a few at a time, in the background
setTimeout(async function backfillEstimates() {
  try {
    for (const m of await DB.allMeta()) {
      if (m.est?.speed === READ_SPEED && m.est.chapters?.length === m.chapterCount) continue;
      const c = await DB.getContent(m.id);
      if (!c?.chapters?.length) continue;
      const fresh = await DB.getMeta(m.id);                 // the record as it is now, not as it was listed
      if (!fresh) continue;
      fresh.est = estimateBook(c.chapters);
      await DB.putMeta(fresh);
      await new Promise(r => setTimeout(r, 30));
    }
  } catch (e) { console.warn('estimates:', e); }
}, 4000);
