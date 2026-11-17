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
// Cover color is derived from a hash of the subtitle, so related books share a color
const COVER_COLORS = ['#7b4b3a', '#3f5a4c', '#45506e', '#6b4a63', '#8a6a3b', '#4b6470', '#5c4f43', '#733f45'];
function coverColor(key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COVER_COLORS[h % COVER_COLORS.length];
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Cover subtitle: prefer a relationship/pairing metadata field, then fall back to the author
function coverSubtitle(b) {
  const keys = Object.keys(b.tags || {});
  const key = keys.find(k => /relationship|pairing|配对|cp/i.test(k));
  return (key && b.tags[key][0]) || b.authors.join('、') || '';
}

async function renderShelf() {
  const books = (await DB.allMeta()).sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
  document.getElementById('shelf-count').textContent = books.length ? `共 ${books.length} 本 · 长按可删除` : '';
  const grid = document.getElementById('grid');
  if (!books.length) {
    grid.innerHTML = `<div class="empty">书架还是空的<br>点右上角“＋ 导入”<br>支持 HTML、TXT 电子书</div>`;
    return;
  }
  grid.innerHTML = books.map(b => {
    const cp = coverSubtitle(b);
    const pct = b.progress?.pct || 0;
    return `
      <div class="card" data-id="${esc(b.id)}">
        <div class="cover" style="background:${coverColor(cp || b.title)}">
          <div><div class="c-title">${esc(b.title)}</div><div class="c-rule"></div></div>
          <div class="c-cp">${esc(cp)}</div>
        </div>
        <div class="card-info">
          <div class="t">${esc(b.title)}</div>
          <div class="s">${esc([b.authors.join('、'), pct ? pct.toFixed(0) + '%' : '未读'].filter(Boolean).join(' · '))}</div>
          <div class="progress"><i style="width:${pct}%"></i></div>
        </div>
      </div>`;
  }).join('');
}

// Tap a card to open it; long-press to delete
let pressTimer = null, longPressed = false;
const grid = document.getElementById('grid');
grid.addEventListener('touchstart', e => {
  const card = e.target.closest('.card');
  if (!card) return;
  longPressed = false;
  pressTimer = setTimeout(() => { longPressed = true; askDelete(card.dataset.id); }, 600);
}, { passive: true });
['touchend', 'touchmove'].forEach(t => grid.addEventListener(t, () => clearTimeout(pressTimer), { passive: true }));
grid.addEventListener('contextmenu', e => {       // Right-click acts as long-press on desktop
  const card = e.target.closest('.card');
  if (card) { e.preventDefault(); askDelete(card.dataset.id); }
});
grid.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (card && !longPressed) openBook(card.dataset.id);
});

async function askDelete(id) {
  const m = await DB.getMeta(id);
  if (m && confirm(`从书架删除《${m.title}》？`)) { await DB.remove(id); renderShelf(); }
}

// ================= Opening books / saving progress =================
let current = null, saveTimer = null;

async function openBook(id) {
  const meta = await DB.getMeta(id);
  const content = await DB.getContent(id);
  meta.lastReadAt = Date.now();
  current = meta;
  DB.putMeta(meta);
  document.getElementById('shelf').classList.add('hidden');
  Reader.open({ ...meta, chapters: content.chapters }, meta.progress);
}

// Called on every page turn; writes are debounced by 400 ms
Reader.onProgress = p => {
  if (!current) return;
  current.progress = p;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => DB.putMeta(current), 400);
};

// ================= Import =================
document.getElementById('picker').addEventListener('change', async e => {
  const files = [...e.target.files];
  e.target.value = '';
  let lastId = null;
  for (const file of files) {
    const book = await Importer.parse(file);
    if (!book.chapters.length) { alert(`《${file.name}》里没有读到正文`); continue; }
    const old = await DB.getMeta(book.id);        // Re-importing the same book keeps its progress
    const { chapters, ...info } = book;
    await DB.putMeta({
      ...info,
      chapterCount: chapters.length,
      addedAt: old?.addedAt || Date.now(),
      lastReadAt: old?.lastReadAt,
      progress: old?.progress,
    });
    await DB.putContent({ id: book.id, chapters });
    lastId = book.id;
  }
  await renderShelf();
  if (files.length === 1 && lastId) openBook(lastId);   // Open immediately when a single book is imported
});

// ================= Reader menu =================
document.getElementById('btn-back').onclick = () => {
  Reader.closeMenu();
  document.getElementById('reader').classList.add('hidden');
  document.getElementById('shelf').classList.remove('hidden');
  current = null;
  renderShelf();
};
document.getElementById('btn-toc').onclick = () => Reader.showToc();
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
document.getElementById('btn-more').onclick = () => moreSheet.classList.remove('hidden');
document.getElementById('btn-more-close').onclick = () => moreSheet.classList.add('hidden');
moreSheet.onclick = e => { if (e.target === moreSheet) moreSheet.classList.add('hidden'); };

document.getElementById('btn-backup').onclick = async () => {
  moreSheet.classList.add('hidden');
  const data = { app: 'folio', version: 1, savedAt: Date.now(),
                 meta: await DB.allMeta(), contents: await DB.allContents(), settings };
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
  moreSheet.classList.add('hidden');
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'folio') throw new Error('不是书架备份文件');
    for (const m of data.meta) await DB.putMeta(m);
    for (const c of data.contents) await DB.putContent(c);
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
