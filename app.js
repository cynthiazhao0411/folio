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
    if (meta.t2s === undefined) { meta.t2s = Reader.t2s; DB.putMeta(meta); }  // remember the script detection
    t2sLabel();
    Clock.start(id);
    Session.begin(meta);
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
  (m.run || (m.run = { ms: 0, counted: false })).ms += ms;
  if (checkFinished(m)) celebrate(m);
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
  let lastId = null, count = 0, updated = 0;
  const failed = [];
  for (const [i, { book, label }] of sources.entries()) {
    onProgress?.(i + 1, sources.length);
    if (!book.chapters.length) { failed.push({ label, error: '没有读到正文' }); continue; }
    const words = bookText(book.chapters);
    if (words < MIN_TEXT) { failed.push({ label, error: '内容是空的或文字太少' }); continue; }
    let old = null, oldContent = null;
    try {
      old = await DB.getMeta(book.id);
      oldContent = old ? await DB.getContent(book.id) : null;
      const { chapters, ...info } = book;
      // Re-importing a book keeps everything you did with it on the shelf
      const keep = {};
      for (const k of ['readMs', 'reads', 'run', 'finished', 'cover', 'coverColor', 'pinned', 'folder', 'userTags', 'rating', 'status', 'hidden', 'renamed', 'palette'])
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
        addedAt: old?.addedAt || Date.now(),
        lastReadAt: old?.lastReadAt,
        progress: old?.progress,
      });
      const [m, c] = await Promise.all([DB.getMeta(book.id), DB.getContent(book.id)]);   // read back to be sure
      if (!m || !c?.chapters?.length) throw new Error('写入后读不到，没有保存成功');
      if (old) updated++;
      lastId = book.id; count++;
    } catch (err) {
      console.error(err);
      try {                                                  // undo this book only
        if (old) { if (oldContent) await DB.putContent(oldContent); await DB.putMeta(old); }
        else await DB.remove(book.id);
      } catch (e2) { console.error('rollback failed', e2); }
      failed.push({ label, error: importError(err), retry: true });   // storage problem: worth trying again
    }
  }
  try { await renderShelf(); } catch (err) { console.error(err); }
  if (count === 1 && open && !failed.length) openBook(lastId);  // open right away when a single book comes in
  return { count, updated, added: count - updated, failed };
}
const importSummary = r => r.updated && r.added ? `新增 ${r.added} 本 · 更新 ${r.updated} 本`
  : r.updated ? `更新了 ${r.updated} 本` : `新增 ${r.added} 本`;

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

document.getElementById('picker').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const progress = progressToast();
  try {
    const sources = [], parseFailed = [];
    for (const [i, file] of files.entries()) {
      progress.set(files.length > 1 ? `正在读取 ${i + 1} / ${files.length}…` : '正在读取…');
      for (const r of await Importer.parseFile(file)) (r.error ? parseFailed : sources).push(r);
    }
    const res = await importBooks(sources, sources.length === 1 && !parseFailed.length,
      (i, n) => progress.set(n > 1 ? `正在导入 ${i} / ${n}…` : '正在导入…'));
    progress.done();
    reportImport(res, [...parseFailed, ...res.failed]);
  } catch (err) {
    console.error(err);
    progress.done();
    dialog({ title: '导入出错', message: importError(err), ok: '好' });
  }
});

// The 导入 button offers two ways in: a file, or a work copied to the clipboard
document.getElementById('btn-import').onclick = e => {
  Library.popover(e.currentTarget, [['imp-file', '从文件导入'], ['imp-paste', '粘贴剪贴板里的作品']], [], true);
};
async function importFromClipboard() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { return toast('没有读取剪贴板的权限'); }
  if (!text || text.length < 200) return toast('剪贴板里没有作品内容');
  const progress = progressToast();
  try {
    const sources = [], parseFailed = [];
    // Several works copied by the 收书 bookmark come as one bundle
    const items = text.startsWith('{"app":"folio-bundle"') ? JSON.parse(text).items || [] : [{ html: text }];
    for (const [i, it] of items.entries()) {
      try { const book = Importer.parseText(it.html, '粘贴的作品'); sources.push({ book, label: bookName(book.title) }); }
      catch (err) { parseFailed.push({ label: `第 ${i + 1} 篇`, error: importError(err) }); }
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
function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
const moreSheet = document.getElementById('more-sheet');
document.getElementById('btn-more').onclick = () => {
  document.getElementById('sync-sub').textContent = Sync.summary();
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

document.getElementById('btn-backup').onclick = async () => {
  Sheet.close(moreSheet);
  try {
    // Every store is included, so records added in later versions are backed up too. Book titles are
    // saved exactly as stored (including any 【】 pairing); only the display is cleaned.
    const stores = {};
    for (const n of await DB.storeNames()) if (n !== 'snapshots') stores[n] = await DB.dump(n);
    const data = { app: 'folio', version: 2, savedAt: Date.now(), stores, settings, folders: Library.extraFolders() };   // folders: empty ones live outside the database
    const name = `folio-backup-${new Date().toLocaleDateString('sv')}.json`;
    const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
    let saved = false;
    if (useShareSheet(file)) {                       // iOS / Android: share sheet ("Save to Files")
      try { await navigator.share({ files: [file] }); saved = true; }
      catch (err) { if (err?.name === 'AbortError') return; }
    }
    if (!saved) downloadFile(file);
    localStorage.setItem('folio-backup-at', Date.now());
  } catch (err) {
    console.error('backup failed', err);
    alert('备份失败：' + (err?.message || '未知错误'));
  }
};

document.getElementById('restore-picker').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  Sheet.close(moreSheet);
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'folio') throw new Error('不是书架备份文件');
    // Version 1 files kept each store as a top-level field
    const stores = data.stores || { meta: data.meta, contents: data.contents, notes: data.notes, daily: data.daily };
    const names = await DB.storeNames();
    for (const [name, rows] of Object.entries(stores)) {
      if (!rows || !names.includes(name) || name === 'snapshots') continue;
      for (const r of rows) await DB.run(name, 'readwrite', s => s.put(r));
    }
    if (data.settings) { Object.assign(settings, data.settings); applySettings(); }
    await renderShelf();
    toast(`已恢复 ${(stores.meta || []).length} 本书`);
  } catch (err) {
    alert('恢复失败：' + err.message);
  }
});

// ================= Offline cache + persistent storage =================
// Service workers require HTTPS (or localhost); registration silently fails otherwise
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.();

renderShelf();
Sync.init();

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
