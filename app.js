// app.js — Application shell: library, import, settings, progress persistence
Reader.init();

// ================= Settings (persisted in localStorage) =================
const settings = Object.assign({ theme: 0, font: 19, turn: 'curl' },
  JSON.parse(localStorage.getItem('settings') || '{}'));
const THEMES = ['', 'theme-green', 'theme-night'];

function applySettings() {
  document.body.classList.remove(...THEMES.filter(Boolean));
  if (THEMES[settings.theme]) document.body.classList.add(THEMES[settings.theme]);
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

// ================= Opening books / saving progress =================
let current = null, saveTimer = null;

// The shelf stays rendered underneath the reader, so its scroll position survives.
let animating = false;
async function openBook(id) {
  if (animating) return;
  animating = true;
  const reader = document.getElementById('reader');
  try {
    const meta = await DB.getMeta(id);
    const content = await DB.getContent(id);
    meta.lastReadAt = Date.now();
    current = meta;
    DB.putMeta(meta);
    Reader.setAnnots(await DB.notesFor(id));                  // bookmarks, highlights, notes
    reader.style.opacity = '0';                                // lay out invisibly first
    Reader.open({ ...meta, chapters: content.chapters }, meta.progress);
    if (!meta.words) { meta.words = Reader.wordCount; DB.putMeta(meta); }   // books imported before word counts existed
    Clock.start(id);
    const cover = document.querySelector(`.card[data-id="${CSS.escape(id)}"] .cover`);
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
      ${(() => { const t = splitTitle(b.title); return `
      ${t.pre || t.suf ? `<div class="tp-tagline">${esc([t.pre, t.suf].filter(Boolean).join(' · '))}</div>` : ''}
      <div class="tp-title">${wordBreaks(t.main)}</div>`; })()}
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
    <div class="ip" style="--c:${b.coverColor || coverColor(sub || b.title)}">
      <div class="ip-figures">
        ${figures.map(([v, l]) => `<div class="ip-fig"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('<div class="ip-dot"></div>')}
      </div>
      <button class="ip-start">翻开，开始故事<i>→</i></button>
    </div>`;
  return { cover, info };
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
  saveTimer = setTimeout(() => DB.putMeta(current), 400);
};

// ================= Import =================
// From files (the 导入 button) or from the clipboard (see the share-sheet shortcut in the README)
async function importBooks(sources) {        // sources: [{ book, label }]
  let lastId = null, count = 0;
  for (const { book, label } of sources) {
    if (!book.chapters.length) { toast(`《${label}》里没有读到正文`); continue; }
    const old = await DB.getMeta(book.id);
    const { chapters, ...info } = book;
    // Re-importing a book keeps everything you did with it on the shelf
    const keep = {};
    for (const k of ['readMs', 'reads', 'run', 'finished', 'cover', 'coverColor', 'pinned', 'folder', 'userTags', 'rating', 'status', 'hidden', 'renamed'])
      if (old?.[k] !== undefined) keep[k] = old[k];
    if (old?.renamed) info.title = old.title;
    await DB.putMeta({
      ...info,
      ...keep,
      chapterCount: chapters.length,
      words: chapters.reduce((n, c) => n + c.html.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s/g, '').length, 0),
      addedAt: old?.addedAt || Date.now(),
      lastReadAt: old?.lastReadAt,
      progress: old?.progress,
    });
    await DB.putContent({ id: book.id, chapters });
    lastId = book.id; count++;
  }
  await renderShelf();
  if (count === 1) openBook(lastId);          // open right away when a single book comes in
  return count;
}

document.getElementById('picker').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  const sources = [];
  for (const file of files) sources.push({ book: await Importer.parse(file), label: file.name });
  importBooks(sources);
});

// The 导入 button offers two ways in: a file, or a work copied to the clipboard
document.getElementById('btn-import').onclick = e => {
  Library.popover(e.currentTarget, [['imp-file', '从文件导入'], ['imp-paste', '粘贴剪贴板里的作品']], [], true);
};
async function importFromClipboard() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { return toast('没有读取剪贴板的权限'); }
  if (!text || text.length < 200) return toast('剪贴板里没有作品内容');
  const book = Importer.parseText(text, '粘贴的作品');
  const n = await importBooks([{ book, label: book.title }]);
  if (n) toast(`已导入《${book.title}》`);
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
document.getElementById('btn-theme').onclick = () => {
  settings.theme = (settings.theme + 1) % THEMES.length;
  applySettings();
};
function setFont(d) {
  settings.font = Math.min(28, Math.max(14, settings.font + d));
  applySettings();
  Reader.relayout();
}
document.getElementById('btn-smaller').onclick = () => setFont(-1);
document.getElementById('btn-bigger').onclick = () => setFont(+1);
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

document.getElementById('btn-backup').onclick = async () => {
  Sheet.close(moreSheet);
  const data = { app: 'folio', version: 1, savedAt: Date.now(),
                 meta: await DB.allMeta(), contents: await DB.allContents(),
                 notes: await DB.allNotes(), daily: await DB.allDaily(), settings };
  const name = `folio-backup-${new Date().toLocaleDateString('sv')}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  // iOS: use the share sheet ("Save to Files"); desktop: regular download
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch { /* user cancelled */ }
  } else {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
    for (const m of data.meta) await DB.putMeta(m);
    for (const c of data.contents) await DB.putContent(c);
    for (const n of data.notes || []) await DB.putNote(n);
    for (const d of data.daily || []) await DB.putDaily(d);
    if (data.settings) { Object.assign(settings, data.settings); applySettings(); }
    await renderShelf();
    toast(`已恢复 ${data.meta.length} 本书`);
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
