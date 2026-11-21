// library.js — The bookshelf: jackets, sorting & filters, the long-press context menu,
// multi-select mode with its toolbar, and the small dialogs/pickers they use.
//
// Per-book fields managed here (all on the book's meta record):
//   pinned (timestamp) · folder (name) · userTags [] · rating 0–5 · status 'unread'|'reading'|'done'
//   hidden (bool) · renamed (bool, so a re-import keeps the custom title)

// ================= Jackets =================
// Cover color is derived from a hash of the pairing, so related books share a color
const COVER_COLORS = ['#7b4b3a', '#3f5a4c', '#45506e', '#6b4a63', '#8a6a3b', '#4b6470', '#5c4f43', '#733f45'];
function coverColor(key) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COVER_COLORS[h % COVER_COLORS.length];
}
// Each book keeps its own colour (m.palette: an index into COVER_COLORS), stored with the
// book so it never changes on its own. Colours are handed out to keep them evenly used:
// the first time, the whole shelf is shuffled evenly; after that, a new book gets one of
// the least-used colours.
function bookColor(b) { return Number.isInteger(b.palette) ? COVER_COLORS[b.palette % COVER_COLORS.length] : coverColor(b.id || b.title); }
// Cover-page title colour: the jacket colour pushed to a very dark shade of the same hue (a light
// tint on the night theme), so a purple jacket gives a deep purple title, a blue one a deep blue.
function titleShades(color) {
  const m = String(color || '').match(/^#([0-9a-f]{6})$/i) || String(color || '').match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  let r, g, b;
  if (m && m.length === 2) [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255);
  else if (m) [r, g, b] = [1, 2, 3].map(i => parseInt(m[i] + m[i], 16) / 255);
  else {
    const n = String(color || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
    if (!n) return null;
    [r, g, b] = [1, 2, 3].map(i => +n[i] / 255);
  }
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  const hsl = (sat, lig) => `hsl(${Math.round(h * 60)} ${Math.round(sat * 100)}% ${Math.round(lig * 100)}%)`;
  return { dark: hsl(Math.min(.65, Math.max(.4, s)), .14), light: hsl(Math.min(.5, Math.max(.3, s)), .78) };
}
// Books saved by older versions may have an empty author list for anonymous works, or
// spell it differently; the same rule as new imports (normalizeAuthors) is applied to them.
async function fixAuthors() {
  const changed = new Map();
  for (const m of await DB.allMeta()) {
    const fixed = normalizeAuthors(m.authors, m.source);
    if (JSON.stringify(fixed) !== JSON.stringify(m.authors || [])) { m.authors = fixed; await DB.putMeta(m); changed.set(m.id, fixed); }
  }
  if (!changed.size) return;
  // Reading history keeps its own copy of the author names
  const fix = (await DB.allSessions()).filter(s => changed.has(s.bookId));
  if (fix.length) await DB.putMany('sessions', fix.map(s => ({ ...s, authors: changed.get(s.bookId) })));
}
async function balancePalettes() {
  const all = await DB.allMeta();
  const missing = all.filter(m => !Number.isInteger(m.palette));
  if (!missing.length) return;
  const counts = COVER_COLORS.map(() => 0);
  all.forEach(m => { if (Number.isInteger(m.palette)) counts[m.palette % counts.length]++; });
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  for (const m of shuffle(missing)) {
    const min = Math.min(...counts);
    const choices = counts.map((n, i) => n === min ? i : -1).filter(i => i >= 0);
    m.palette = choices[Math.floor(Math.random() * choices.length)];
    counts[m.palette]++;
    await DB.putMeta(m);
  }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The book's own metadata, matched loosely by name
const metaGroup = (b, re) => { const k = Object.keys(b.tags || {}).find(k => re.test(k)); return k ? b.tags[k].filter(Boolean) : []; };
function coverSubtitle(b) {
  return metaGroup(b, /relationship|pairing|配对|\bcp\b/i)[0] || b.authors.join('、') || '';
}
// The pairing taken from the 【】 in the title: shown under the jacket on the cover page only
const coverCP = b => bookCP(b.title);

// Titles often carry a bracketed tag in front and a status at the end, e.g.
// "【tag】Main Title (完结)". Typeset them separately: small tag above, the main title
// large, the status small below.
function splitTitle(t) {
  let pre = '', suf = '', main = t.trim();
  const p = main.match(/^[【\[［〔(（]([^】\]］〕)）]{1,24})[】\]］〕)）]\s*/);
  if (p && p[0].length < main.length) { pre = p[1].trim(); main = main.slice(p[0].length); }
  const s = main.match(/\s*[(（【\[［]([^)）】\]］]{1,10})[)）】\]］]\s*$/);
  if (s && s.index > 0) { suf = s[1].trim(); main = main.slice(0, s.index); }
  return { pre, main: main.trim(), suf };
}

// Mark word boundaries with zero-width spaces (Intl.Segmenter understands Chinese words).
// With word-break: keep-all these are the only places a title can wrap, so it breaks
// between words — 曼哈顿 | 娇妻, never 曼哈 | 顿娇妻.
function wordBreaks(text) {
  if (!window.Intl?.Segmenter) return esc(text);
  const seg = new Intl.Segmenter('zh', { granularity: 'word' });
  return [...seg.segment(text)].map(x => esc(x.segment)).join('​');
}

// One jacket design used everywhere: title left-aligned in the middle, author at the foot
function jacket(b, cls = '') {
  if (b.cover) return `<div class="cover has-img ${cls}" style="background:${b.coverColor || '#555'} url(${b.cover}) center / cover no-repeat"></div>`;
  const t = splitTitle(bookName(b.title));
  return `<div class="cover ${cls}" style="background:${bookColor(b)}">
      <div class="c-mid">
        <div class="c-title">${wordBreaks(t.main)}</div>
        <div class="c-rule"></div>
      </div>
      ${b.authors?.length ? `<div class="c-author">${esc(b.authors.join('、'))}</div>` : ''}
    </div>`;
}

// Phone shelf: three columns, and exactly three full rows on the first screen. The cover
// height follows the real space left under the header (status bar and notch included);
// the third row is padded so the fourth starts below the screen's edge.
function fitShelf() {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const props = ['--cw', '--ar', '--rg', '--cf', '--tail'];
  if (innerWidth > 600 || shelfMode() !== 'shelf' || !grid.querySelector('.card')) { props.forEach(p => grid.style.removeProperty(p)); return; }
  props.forEach(p => grid.style.removeProperty(p));
  const shelf = document.getElementById('shelf');
  const top = grid.getBoundingClientRect().top + shelf.scrollTop + scrollY;
  const card = grid.querySelector('.card-info');
  const info = card.getBoundingClientRect().height + parseFloat(getComputedStyle(card).marginTop);
  const pill = document.getElementById('shelf-theme').getBoundingClientRect();
  const reserve = pill.height ? innerHeight - pill.top + 6 : 48;    // keep the paper-colour pill clear of the books
  const avail = innerHeight - top - reserve;
  const minGap = 12;
  const byWidth = (grid.clientWidth - 2 * 18) / 3;     // at least 18px between columns
  const byHeight = ((avail - 2 * minGap) / 3 - info) * 2 / 3;
  const cw = Math.floor(Math.max(70, Math.min(byWidth, byHeight)));
  const rowH = cw * 1.5 + info;
  const rg = Math.max(minGap, Math.min(30, (avail - 3 * rowH) / 2));
  // Covers are a little wider than the height budget alone allows: the height stays as computed
  // (so three rows still fit), the width grows ~10%, never below an 18px gap between columns.
  const wide = Math.max(cw, Math.min(Math.floor(byWidth), Math.round(cw * 1.1)));
  grid.style.setProperty('--cw', wide + 'px');
  grid.style.setProperty('--ar', (wide / (cw * 1.5)).toFixed(4));
  grid.style.setProperty('--rg', rg + 'px');
  grid.style.setProperty('--cf', (cw / 10.5).toFixed(2) + 'px');     // cover lettering scales with the cover
  // Push the fourth row just past the bottom of the screen
  const row3End = top + 3 * rowH + 2 * rg;
  grid.style.setProperty('--tail', Math.max(0, innerHeight - row3End - rg + 2) + 'px');
}
addEventListener('resize', () => { fitShelf(); const g = document.getElementById('grid'); if (g) fitTitles(g); });
document.fonts?.ready.then(() => { const g = document.getElementById('grid'); if (g) fitTitles(g); });

// Reading status: set by hand, or inferred from progress and finished read-throughs
function statusOf(b) {
  if (b.status) return b.status;
  if (b.reads) return 'done';
  return (b.progress?.pct || 0) > 0 ? 'reading' : 'unread';
}
const STATUS_NAMES = { unread: '未读', reading: '在读', done: '读完' };

// Shelf display modes. The choice is a view preference of this device (localStorage, kept in
// backups with the other local settings, not synced), and never touches the books' data.
//   shelf: the default three-column bookshelf · list: rows with title, author and details ·
//   wall:  covers as plates in a private catalogue, with a numbered caption under each
const SHELF_MODES = [
  { key: 'shelf', name: '书架模式', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="4" width="4" height="7" rx="1"/><rect x="10" y="4" width="4" height="7" rx="1"/><rect x="16" y="4" width="4" height="7" rx="1"/><rect x="4" y="14" width="4" height="7" rx="1"/><rect x="10" y="14" width="4" height="7" rx="1"/><rect x="16" y="14" width="4" height="7" rx="1"/></svg>' },
  { key: 'list', name: '列表模式', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="4" y="4.5" width="4" height="6" rx="1"/><rect x="4" y="13.5" width="4" height="6" rx="1"/><path d="M11 6h9M11 9h6M11 15h9M11 18h6"/></svg>' },
  { key: 'wall', name: '封面墙', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="3.5" y="3.5" width="9" height="12" rx="1"/><rect x="15" y="3.5" width="5.5" height="7.5" rx="1"/><rect x="15" y="13" width="5.5" height="7.5" rx="1"/><path d="M3.5 19h9M3.5 21h6"/></svg>' },
];
const MODE_KEY = 'folio-shelf-mode';
function shelfMode() {
  let m; try { m = localStorage.getItem(MODE_KEY); } catch {}
  return SHELF_MODES.some(x => x.key === m) ? m : 'shelf';
}

// Cover wall rhythm: a large plate opens every group of nine; on the phone the right-hand
// column of each group is set a little lower, like plates on facing pages
function wallClass(i) {
  const k = i % 9;
  return k === 0 ? ' plate' : (k % 2 === 0 ? ' lo' : '');
}
// The extra lines list and wall modes show (the shelf mode keeps its card as it was)
function cardExtra(b, i, st, pct) {
  const tags = systemTags(b), au = (b.authors || []).join('、');
  const w = b.words ? (b.words >= 10000 ? (b.words / 10000).toFixed(1).replace(/\.0$/, '') + ' 万字' : b.words + ' 字') : '';
  return `<div class="x">
      <div class="x-no">No. ${String(i + 1).padStart(2, '0')}</div>
      ${au ? `<div class="x-au">${esc(au)}</div>` : ''}
      <div class="x-meta">${[w, b.chapterCount ? b.chapterCount + ' 章' : ''].filter(Boolean).map(esc).join('<i>·</i>')}</div>
      ${tags.length ? `<div class="x-tags">${tags.map(t => `<span>${t}</span>`).join('')}</div>` : ''}
    </div>`;
}

// System tags, worked out from the book and its reading record whenever they are shown and never
// stored, so they can't overwrite or remove the user's own tags (m.userTags) and are always current.
//   length:  短篇 under 30,000 characters, 中篇 under 100,000, 长篇 from 100,000
//   state:   完结 / 连载 from the work's "Chapters: n/total" line ("?" = still updating);
//            without that line, 完结 only when the title says so
//   重读:    finished twice or more, or finished once and being read again
function systemTags(b) {
  const out = [], w = b.words || 0;
  if (w) out.push(w < 30000 ? '短篇' : w < 100000 ? '中篇' : '长篇');
  const stats = Object.entries(b.tags || {}).find(([k]) => /stat/i.test(k))?.[1]?.[0] || '';
  const ch = String(stats).match(/Chapters:\s*(\d+)\s*\/\s*(\d+|\?)/);
  if (ch) out.push(ch[2] !== '?' && ch[1] === ch[2] ? '完结' : '连载');
  else if (/完结|完本|全文完/.test(b.title || '')) out.push('完结');
  if ((b.reads || 0) >= 2 || (b.reads && b.run?.ms > 0 && !b.run.counted)) out.push('重读');
  return out;
}

// How many times a book has been read: finished read-throughs (m.reads, see checkFinished), and
// the one under way, if any. Opening, reloading or jumping around never changes it.
function readsRow(b) {
  const n = b.reads || 0, pct = Math.round(b.progress?.pct || 0);
  const spent = b.run?.ms >= 60000 ? ` · 这一遍已读 ${fmtDur(b.run.ms, true)}` : '';
  const now = b.run?.counted ? (pct >= 10 ? '' : `重读中 · 读到 ${pct}%`)       // finished this round already
    : (b.run?.ms || (pct > 0 && pct < 100)) ? `第 ${n + 1} 遍 · 读到 ${Math.max(1, pct)}%${spent}` : '';
  return `<button class="bc-reads" data-act="stats">
    <span class="bc-reads-n">${n ? `读完 <b>${n}</b> 遍` : '还没读完过'}</span>
    <span class="bc-reads-now">${now || (n ? '' : '还没开始读')}</span>
    <i>读完记录 ›</i>
  </button>`;
}

// Setting a status by hand. The first time a book is marked 读完 by hand it also
// counts as one read-through (unless the current read-through was already counted).
function applyStatus(m, s) {
  m.status = s;
  if (s === 'done' && !m.manualCounted) {
    m.manualCounted = true;
    const run = m.run || (m.run = newRun());
    if (!run.counted) {
      run.counted = true;
      m.reads = (m.reads || 0) + 1;
      const now = Date.now();
      (m.finished || (m.finished = [])).push(now);
      (m.readThroughs || (m.readThroughs = [])).push({ n: m.reads, start: run.start, end: now, ms: Math.round(run.ms || 0), opens: null, est: Math.round(estimateMs(m)), manual: true });
    }
  }
}

// Every rating is kept in m.ratings ({ v, at, read }); the book's rating is their average,
// to the nearest half star, halves rounding up. Rating again within 5 minutes counts as
// fixing a slip and replaces the last entry instead of adding one.
const RATE_FIX_MS = 5 * 60 * 1000;
function ratingOf(list) {
  if (!list?.length) return 0;
  const avg = list.reduce((s, r) => s + r.v, 0) / list.length;
  return Math.floor(avg * 2 + .5) / 2;
}
function rateBook(m, n) {
  const list = m.ratings || (m.ratings = m.rating ? [{ v: m.rating, at: m.lastReadAt || Date.now() }] : []);
  const last = list[list.length - 1], now = Date.now();
  if (last && now - last.at < RATE_FIX_MS) Object.assign(last, { v: n, at: now });
  else list.push({ v: n, at: now, read: m.reads || 0 });
  m.rating = ratingOf(list);
  return m.rating;
}
const starCount = r => Math.round(r || 0);      // whole stars shown until half-star display arrives

// After finishing a book (or marking it 读完), ask for a rating — once. A book has a
// single rating; later it can be changed from its card, never added twice.
function askRating(m) {
  if (m.rating) return;
  const root = document.createElement('div');
  root.className = 'rate-prompt';
  root.innerHTML = `
    <div class="rp-card">
      ${jacket(m, 'rp-jacket')}
      <div class="rp-kicker">读完了</div>
      <div class="rp-title">${esc(bookName(m.title))}</div>
      <div class="rp-q">给这本书打个分吧</div>
      <div class="rp-stars">${[1, 2, 3, 4, 5].map(n => `<button data-n="${n}">★</button>`).join('')}</div>
      <button class="rp-later">以后再说</button>
    </div>`;
  document.body.appendChild(root);
  const card = root.querySelector('.rp-card'), stars = [...root.querySelectorAll('[data-n]')];
  root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
  card.animate([{ transform: 'translateY(30px) scale(.94)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.32,1.2,.6,1)' });
  const close = async () => {
    await root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished;
    root.remove();
  };
  // Hovering (desktop) or sliding a finger previews the stars
  const preview = n => stars.forEach((s, i) => s.classList.toggle('on', i < n));
  root.querySelector('.rp-stars').addEventListener('pointerover', e => { const b = e.target.closest('[data-n]'); if (b) preview(+b.dataset.n); });
  root.querySelector('.rp-stars').addEventListener('pointerleave', () => preview(0));
  root.addEventListener('click', async e => {
    if (e.target === root || e.target.closest('.rp-later')) return close();
    const b = e.target.closest('[data-n]');
    if (!b) return;
    const n = +b.dataset.n;
    preview(n);
    stars.slice(0, n).forEach((s, i) => s.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.4)' }, { transform: 'scale(1)' }], { duration: 300, delay: i * 50 }));
    const meta = await DB.getMeta(m.id);
    rateBook(meta, n);
    await DB.putMeta(meta);
    if (typeof current !== 'undefined' && current?.id === m.id) Object.assign(current, { rating: meta.rating, ratings: meta.ratings });
    setTimeout(() => { close(); toast('已评分 ' + '★'.repeat(n)); Library.render(); }, 600);
  });
}

// ================= Icons =================
const ICON = (() => {
  const p = d => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  return {
    rename: p('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
    folder: p('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>'),
    tag: p('<path d="M3 12V4h8l9 9-8 8-9-9z"/><circle cx="7.5" cy="8.5" r="1.3"/>'),
    pin: p('<path d="M9 3h6l-1 6 3 3H7l3-3-1-6z"/><path d="M12 15v6"/>'),
    star: p('<path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/>'),
    image: p('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>'),
    share: p('<path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>'),
    chart: p('<path d="M5 20V11M12 20V5M19 20v-6"/>'),
    book: p('<path d="M3 5.5C5.5 4 9 4 12 6c3-2 6.5-2 9-.5V19c-2.5-1.5-6-1.5-9 .5-3-2-6.5-2-9-.5V5.5z"/><path d="M12 6v13.5"/>'),
    hide: p('<path d="M3 3l18 18"/><path d="M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.4.6-1.2 1.7-2.4 2.8M6.5 7.6C4.6 8.9 3.2 10.8 2.5 12c1 1.5 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1"/><path d="M9.9 10a3 3 0 0 0 4.1 4.1"/>'),
    show: p('<path d="M2.5 12C3.5 10.5 7 6 12 6s8.5 4.5 9.5 6c-1 1.5-4.5 6-9.5 6s-8.5-4.5-9.5-6z"/><circle cx="12" cy="12" r="3"/>'),
    trash: p('<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>'),
    more: p('<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>'),
    right: p('<path d="M9 6l6 6-6 6"/>'),
    down: p('<path d="M6 9l6 6 6-6"/>'),
    check: p('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/>'),
    circle: p('<circle cx="12" cy="12" r="9"/>'),
    select: p('<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/>'),
  };
})();

// ================= Dialogs (iOS-style) =================
// confirmDialog → Promise<boolean>; promptDialog → Promise<string|null>
function dialog({ title, message = '', input = null, ok = '确定', danger = false }) {
  return new Promise(resolve => {
    const root = document.createElement('div');
    root.className = 'alert';
    root.innerHTML = `
      <div class="alert-card">
        <div class="alert-body">
          <div class="alert-title">${esc(title)}</div>
          ${message ? `<div class="alert-msg">${esc(message)}</div>` : ''}
          ${input !== null ? `<input class="alert-input" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" maxlength="${input.max || 80}">` : ''}
        </div>
        <div class="alert-actions">
          ${ok === '好' && input === null ? '' : '<button data-r="0">取消</button>'}
          <button data-r="1" class="${danger ? 'danger' : 'strong'}">${esc(ok)}</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    const card = root.querySelector('.alert-card'), field = root.querySelector('.alert-input');
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
    card.animate([{ transform: 'scale(1.12)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.32,.72,0,1)' });
    if (field) setTimeout(() => { field.focus(); field.select(); }, 60);
    const done = async r => {
      field?.blur();
      await root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' }).finished;
      root.remove();
      resolve(input !== null ? (r ? field.value.trim() || null : null) : !!r);
    };
    root.querySelector('.alert-actions').onclick = e => { const b = e.target.closest('[data-r]'); if (b) done(+b.dataset.r); };
    field?.addEventListener('keydown', e => { if (e.key === 'Enter') done(1); });
  });
}
const confirmDialog = o => dialog(o);
const promptDialog = o => dialog({ ...o, input: { value: o.value, placeholder: o.placeholder, max: o.max } });

// A bottom sheet built on the fly (pickers). Returns { root, card, close }
function quickSheet(html, cls = '') {
  const root = document.createElement('div');
  root.className = 'sheet-modal fixed';
  root.innerHTML = `<div class="sheet-card ${cls}"><div class="sheet-grip"></div>${html}</div>`;
  // While books are being multi-selected the whole sheet sits on top of the toolbar, never behind it
  const bar = document.getElementById('select-bar');
  if (Library.selecting && bar && !bar.classList.contains('hidden')) {
    root.classList.add('above-bar');
    root.style.bottom = bar.offsetHeight + 'px';
  }
  document.body.appendChild(root);
  Sheet.open(root);
  const close = async () => { await Sheet.close(root); root.remove(); };
  root._close = close;
  root.addEventListener('click', e => { if (e.target === root) setTimeout(() => root.remove(), 300); });
  return { root, card: root.firstElementChild, close };
}

// ================= Library =================
const Library = {
  filter: 'all',            // 'all' | 'f:<folder>' | 't:<tag>'
  showHidden: false,
  books: [],
  selecting: false,
  selected: new Set(),

  // ---------- data helpers ----------
  async update(ids, fn, rerender = true) {
    for (const id of ids) {
      const m = await DB.getMeta(id);
      if (m) { fn(m); await DB.putMeta(m); }
    }
    if (rerender) await this.render();
  },
  // Empty folders made from the shelf are remembered here; a book's own folder name is never touched
  // Folders created before any book is in them. Kept in the database (prefs 'folders') so they
  // are synced and backed up; older versions kept them in localStorage and are moved over once.
  _extra: [],
  async loadExtraFolders() {
    let list = await DB.getPref('folders');
    if (!Array.isArray(list)) {
      try { list = JSON.parse(localStorage.getItem('folio-folders') || '[]'); } catch { list = []; }
      await DB.setPref('folders', list.filter(x => x && typeof x === 'string'));
      localStorage.removeItem('folio-folders');
    }
    this._extra = list.filter(x => x && typeof x === 'string');
  },
  extraFolders() { return [...this._extra]; },
  saveExtraFolders(list) { this._extra = [...new Set(list)]; DB.setPref('folders', this._extra); },
  folders() { return [...new Set([...this.books.map(b => b.folder).filter(Boolean), ...this.extraFolders()])].sort((a, b) => a.localeCompare(b, 'zh')); },
  async createFolder() {
    const f = await promptDialog({ title: '新建文件夹', placeholder: '文件夹名称', ok: '创建' });
    if (!f) return null;
    if (!this.folders().includes(f)) this.saveExtraFolders([...this.extraFolders(), f]);
    return f;
  },
  async removeFolder(name) {
    if (this.books.some(b => b.folder === name)) return toast('文件夹里还有书，先把书移出来再删除');
    const ok = await confirmDialog({ title: `删除文件夹「${name}」？`, message: '里面没有书，只会删除这个空文件夹。', ok: '删除', danger: true });
    if (!ok) return;
    this.saveExtraFolders(this.extraFolders().filter(x => x !== name));
    if (this.filter === 'f:' + name) this.filter = 'all';
    await this.render();
  },
  tags() { return [...new Set(this.books.flatMap(b => b.userTags || []))].sort((a, b) => a.localeCompare(b, 'zh')); },

  visible() {
    const f = this.filter;
    return this.books
      .filter(b => !!b.hidden === this.showHidden)
      .filter(b => f === 'all' || (f.startsWith('f:') ? b.folder === f.slice(2) : (b.userTags || []).includes(f.slice(2))))
      .sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
  },

  // ---------- rendering ----------
  async render() {
    await balancePalettes();                 // books without a colour yet get one (saved with the book)
    await fixAuthors();                      // one spelling for anonymous works (see importer.js)
    await this.loadExtraFolders();
    this.books = await DB.allMeta();
    const folders = this.folders(), tags = this.tags();
    if (this.filter !== 'all' && !(this.filter.startsWith('f:') ? folders.includes(this.filter.slice(2)) : tags.includes(this.filter.slice(2)))) this.filter = 'all';
    const list = this.visible();

    // Sub-header: count and today's reading time
    const today = (await DB.allDaily()).filter(r => r.date === new Date().toLocaleDateString('sv')).reduce((n, r) => n + r.ms, 0);
    document.getElementById('shelf-count').innerHTML = this.books.length
      ? `${this.showHidden ? '隐藏的书 · ' : ''}共 ${list.length} 本${today ? ` · 今日已读 ${fmtDur(today, true)}` : ''}` : '';
    document.getElementById('btn-select').classList.toggle('hidden', !list.length);

    // Filter chips: all · folders. Tags are not shown on the shelf; they stay on the book card
    // (long-press) and in the data, and the 't:' filter in visible() is kept for later versions.
    const chips = document.getElementById('chips');
    const chip = (key, label, icon = '') => `<button data-filter="${esc(key)}" class="${this.filter === key ? 'on' : ''}">${icon}${esc(label)}</button>`;
    chips.innerHTML = this.showHidden
      ? `<button class="on back-hidden" data-filter="__unhide">${ICON.show}退出隐藏书架</button>`
        + chip('all', '全部') + folders.map(f => chip('f:' + f, f, ICON.folder)).join('')
      : `<button class="chip-new" data-newfolder="1">＋ 新建文件夹</button>`
        + (folders.length ? chip('all', '全部') + folders.map(f => chip('f:' + f, f, ICON.folder)).join('') : '');

    // Continue reading: the book opened most recently (not one already finished)
    const cont = document.getElementById('continue');
    let last = !this.showHidden && !this.selecting && this.books
      .filter(b => b.lastReadAt && !b.hidden && statusOf(b) !== 'done')
      .sort((a, b) => b.lastReadAt - a.lastReadAt)[0];
    cont.classList.toggle('hidden', !last);
    if (last) {
      if (last.t2s) last = { ...last, title: toSimplified(last.title) };
      const pct = last.progress?.pct || 0, ch = (last.progress?.ch || 0) + 1;
      cont.dataset.id = last.id;
      cont.innerHTML = `${jacket(last, 'mini')}
        <div class="ct"><div class="ct-k">继续阅读</div><div class="ct-t">${esc(bookName(last.title))}</div>
        <div class="ct-s">读到第 ${ch} 章 · ${pct < 1 ? pct.toFixed(1) : Math.floor(pct)}%</div></div>
        <button class="ct-go">继续 →</button>`;
      fitTitles(cont);
    }

    const grid = document.getElementById('grid'), mode = shelfMode();
    SHELF_MODES.forEach(m => grid.classList.toggle('mode-' + m.key, m.key === mode));
    this.renderModeBtn();
    requestAnimationFrame(() => { fitShelf(); fitTitles(grid); });
    if (!this.books.length || (!list.length && this.filter === 'all' && !this.showHidden)) {
      grid.innerHTML = `
        <div class="empty">
          <div class="empty-art"><span></span><span></span><span></span></div>
          <p class="empty-title">书架还是空的</p>
          <p class="empty-sub">导入第一本书，开始阅读</p>
          <label for="picker" class="empty-btn">＋ 导入书籍</label>
          <p class="empty-hint">支持 EPUB、HTML、TXT、PDF、ZIP · 可一次选多本</p>
        </div>`;
      return;
    }
    if (!list.length) { grid.innerHTML = `<div class="empty small"><p class="empty-sub">这里还没有书</p></div>`; return; }
    grid.innerHTML = list.map((b, i) => {
      if (b.t2s) b = { ...b, title: toSimplified(b.title) };     // traditional books shown in simplified
      const st = statusOf(b), pct = b.progress?.pct || 0;
      const sub = st === 'done' ? (b.reads ? `读完 ${b.reads} 遍` : '读完') : st === 'reading' ? Math.max(1, Math.round(pct)) + '%' : '未读';
      return `
        <div class="card${this.selected.has(b.id) ? ' picked' : ''}${mode === 'wall' ? wallClass(i) : ''}" data-id="${esc(b.id)}">
          <div class="card-cover">
            ${jacket(b)}
            ${b.pinned ? `<span class="pin-badge">${ICON.pin}</span>` : ''}
            ${b.newChapters ? `<span class="new-badge">新 +${b.newChapters} 章</span>` : ''}
            <span class="pick"></span>
          </div>
          <div class="card-info">
            <div class="t">${esc(bookName(b.title))}</div>
            <div class="s">${b.rating ? `<span class="stars">${'★'.repeat(starCount(b.rating))}</span>` : ''}${esc(sub)}</div>
            <div class="progress"><i style="width:${st === 'done' ? 100 : pct}%"></i></div>
            ${mode === 'shelf' ? '' : cardExtra(b, i, st, pct)}
          </div>
        </div>`;
    }).join('');
    fitTitles(grid);
    this.updateSelectBar();
  },

  // ---------- gestures on the grid ----------
  bind() {
    const grid = document.getElementById('grid');
    let timer = null, hint = null, pressing = null, pressedAt = 0, x0 = 0, y0 = 0;
    const unpress = () => { clearTimeout(timer); clearTimeout(hint); pressing?.classList.remove('pressing'); pressing = null; };
    grid.addEventListener('touchstart', e => {
      const card = e.target.closest('.card');
      if (!card || this.selecting) return;
      unpress();
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      hint = setTimeout(() => { pressing = card; card.classList.add('pressing'); }, 130);     // the book sinks slightly while you hold
      timer = setTimeout(() => { pressedAt = Date.now(); this.openMenu(card.dataset.id); }, 440);
    }, { passive: true });
    grid.addEventListener('touchmove', e => {
      if (Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 8) unpress();
    }, { passive: true });
    grid.addEventListener('touchend', unpress, { passive: true });
    grid.addEventListener('touchcancel', unpress, { passive: true });
    // A held finger must never start iOS text selection (blue handles) on the shelf or the card
    document.addEventListener('selectstart', e => {
      const el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
      if (el?.closest('#grid, #chips, .bookcard-wrap, .sheet-modal.fixed, #select-bar, #select-top') && !el.closest('input, textarea')) e.preventDefault();
    });
    grid.addEventListener('contextmenu', e => {                 // right-click = long-press on desktop
      const card = e.target.closest('.card');
      if (card && !this.selecting) { e.preventDefault(); this.openMenu(card.dataset.id); }
    });
    grid.addEventListener('click', e => {
      const card = e.target.closest('.card');
      if (!card) return;
      if (Date.now() - pressedAt < 700) return;                // the click that ends a long-press
      if (this.selecting) return this.toggle(card);
      openBook(card.dataset.id);
    });

    // Chips: tap to filter; the first one makes a new folder. Press and hold an empty folder to delete it.
    const chips = document.getElementById('chips');
    let chipTimer = null, chipHeld = 0;
    const holdChip = e => {
      const b = e.target.closest('[data-filter^="f:"]');
      if (!b) return;
      chipTimer = setTimeout(() => { chipHeld = Date.now(); navigator.vibrate?.(8); this.removeFolder(b.dataset.filter.slice(2)); }, 600);
    };
    chips.addEventListener('touchstart', holdChip, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(t => chips.addEventListener(t, () => clearTimeout(chipTimer), { passive: true }));
    chips.addEventListener('contextmenu', e => { const b = e.target.closest('[data-filter^="f:"]'); if (b) { e.preventDefault(); this.removeFolder(b.dataset.filter.slice(2)); } });
    chips.onclick = async e => {
      if (Date.now() - chipHeld < 700) return;
      if (e.target.closest('[data-newfolder]')) {
        const f = await this.createFolder();
        if (f) { await this.render(); toast(`已新建「${f}」`); chips.querySelector(`[data-filter="${CSS.escape('f:' + f)}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }
        return;
      }
      const b = e.target.closest('[data-filter]');
      if (!b) return;
      if (b.dataset.filter === '__unhide') { this.showHidden = false; this.filter = 'all'; }
      else this.filter = b.dataset.filter;
      this.render();
    };
    document.getElementById('btn-select').onclick = () => this.enterSelect();
    document.getElementById('btn-mode').onclick = e => { e.stopPropagation(); this.openModeMenu(); };
    this.bindSelectBar();
  },

  // ================= Long-press: the book's catalog card =================
  // Instead of a list menu, long-pressing pulls the book a little off the shelf and
  // slides up its "catalog card": rating and reading status are edited right on the
  // card, and the other actions sit in an ink-stamp grid. Swipe down or tap outside to put it back.
  async openMenu(id) {
    const b = await DB.getMeta(id);
    const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (!b || !card || document.querySelector('.bookcard-wrap')) return;
    navigator.vibrate?.(8);
    const st = statusOf(b);
    const facts = [
      b.readMs ? `已读 ${fmtDur(b.readMs, true)}` : '',
      estimateMs(b) > 0 ? `预计 ${fmtDur(estimateMs(b), true)}` : '',
      b.words ? (b.words >= 10000 ? (b.words / 10000).toFixed(1) + ' 万字' : b.words + ' 字') : '',
    ].filter(Boolean);
    const place = [b.folder ? `${ICON.folder}<span>${esc(b.folder)}</span>` : '', ...(b.userTags || []).slice(0, 3).map(t => `<span>#${esc(t)}</span>`)].filter(Boolean);
    const stamp = (act, icon, label, on) => `<button class="bc-stamp${on ? ' on' : ''}" data-act="${act}"><i>${icon}</i><span>${label}</span></button>`;

    const root = document.createElement('div');
    root.className = 'bookcard-wrap';
    root.innerHTML = `
      <div class="bookcard">
        <div class="bc-punch"></div>
        <div class="bc-head">
          ${jacket(b, 'bc-jacket')}
          <div class="bc-meta">
            <div class="bc-title">${esc(bookName(b.title))}</div>
            <div class="bc-author">${esc(b.authors.join('、') || '佚名')}</div>
            <div class="bc-stars" aria-label="评分">${[1, 2, 3, 4, 5].map(n => `<button data-rate="${n}" class="${n <= starCount(b.rating) ? 'on' : ''}">★</button>`).join('')}</div>
          </div>
        </div>
        ${readsRow(b)}
        ${systemTags(b).length ? `<div class="bc-sys" title="系统标签：按字数、连载状态和阅读记录自动生成">${systemTags(b).map(t => `<span>${t}</span>`).join('')}</div>` : ''}
        ${facts.length || place.length ? `<div class="bc-facts">${facts.map(f => `<span>${f}</span>`).join('')}${place.length ? `<div class="bc-place">${place.join('')}</div>` : ''}</div>` : ''}
        <div class="bc-seg">
          <i class="bc-seg-ind"></i>
          ${['unread', 'reading', 'done'].map(s => `<button data-st="${s}" class="${s === st ? 'on' : ''}">${STATUS_NAMES[s]}</button>`).join('')}
        </div>
        <div class="bc-grid">
          ${stamp('rename', ICON.rename, '重命名')}
          ${stamp('move', ICON.folder, '文件夹', !!b.folder)}
          ${stamp('tags', ICON.tag, '标签', !!b.userTags?.length)}
          ${stamp('pin', ICON.pin, b.pinned ? '已置顶' : '置顶', !!b.pinned)}
          ${stamp('cover', ICON.image, '封面', !!b.cover)}
          ${stamp('share', ICON.share, '导出')}
          ${stamp('stats', ICON.chart, '统计')}
          ${stamp('hide', b.hidden ? ICON.show : ICON.hide, b.hidden ? '取消隐藏' : '隐藏', !!b.hidden)}
        </div>
        <div class="bc-cover hidden">
          <button data-act="cover-set">从相册选择</button>
          ${b.cover ? '<button data-act="cover-clear">恢复默认封面</button>' : ''}
        </div>
        <button class="bc-delete" data-act="delete">删除这本书</button>
      </div>`;
    document.body.appendChild(root);
    getSelection()?.removeAllRanges();
    const sheet = root.querySelector('.bookcard');

    // The status pill slides under the chosen segment
    const seg = root.querySelector('.bc-seg'), ind = seg.querySelector('.bc-seg-ind');
    const moveInd = (animate = true) => {
      const on = seg.querySelector('.on');
      ind.style.transition = animate ? '' : 'none';
      ind.style.transform = `translateX(${on.offsetLeft - 3}px)`;
      ind.style.width = on.offsetWidth + 'px';
    };
    moveInd(false);

    // Pull the book a little off the shelf while its card is open
    const cov = card.querySelector('.cover');
    cov.style.transition = 'transform .35s cubic-bezier(.34,1.4,.64,1), box-shadow .35s';
    cov.style.transform = 'translateY(-8px) rotate(-1.5deg)';
    cov.style.boxShadow = '0 18px 30px -12px rgba(0,0,0,.45)';
    card.classList.remove('pressing');

    root.animate([{ backgroundColor: 'rgba(30,20,10,0)' }, { backgroundColor: 'rgba(30,20,10,.32)' }], { duration: 280, fill: 'forwards' });
    sheet.animate([{ transform: 'translateY(105%) rotate(-2.5deg)' }, { transform: 'translateY(-6px) rotate(.4deg)', offset: .72 }, { transform: 'none' }],
      { duration: 520, easing: 'cubic-bezier(.32,.72,0,1)' });

    const openedAt = Date.now();
    const close = async (from = 0) => {
      if (root._closing) return;
      root._closing = true;
      cov.style.transform = ''; cov.style.boxShadow = '';
      await Promise.all([
        root.animate([{ backgroundColor: 'rgba(30,20,10,.32)' }, { backgroundColor: 'rgba(30,20,10,0)' }], { duration: 240, fill: 'forwards' }).finished,
        sheet.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(105%) rotate(2deg)' }], { duration: 260, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).finished,
      ]);
      setTimeout(() => { cov.style.transition = ''; }, 400);
      root.remove();
      this.render();
      // Marked 读完 on the card but left without rating: ask once more
      if (root._markedDone && !b.rating) { const m = await DB.getMeta(id); if (m && !m.rating) askRating(m); }
    };
    root.addEventListener('click', e => { if (e.target === root && Date.now() - openedAt > 450) close(); });
    root.addEventListener('contextmenu', e => { e.preventDefault(); if (e.target === root) close(); });

    // Swipe the card down to put the book back
    let y0 = null, dy = 0;
    sheet.addEventListener('touchstart', e => { y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
    sheet.addEventListener('touchmove', e => {
      if (y0 === null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      if (dy) { e.preventDefault(); sheet.style.transform = `translateY(${dy}px)`; }
    }, { passive: false });
    sheet.addEventListener('touchend', () => {
      if (y0 === null) return;
      y0 = null; sheet.style.transform = '';
      if (dy > 80) close(dy);
      else if (dy) sheet.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.32,.72,0,1)' });
    });

    sheet.addEventListener('click', async e => {
      if (Date.now() - openedAt < 450) return;              // the click that ends the long-press
      const rate = e.target.closest('[data-rate]');
      if (rate) {                                           // tap a star: adds a rating, the card shows the average
        const n = +rate.dataset.rate;
        sheet.querySelector('.bc-rate-hint')?.remove();
        sheet.querySelectorAll('[data-rate]').forEach((x, i) => x.classList.toggle('on', i < n));
        rate.animate([{ transform: 'scale(1.45) rotate(-12deg)' }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.34,1.56,.64,1)' });
        await this.update([id], m => { b.rating = rateBook(m, n); b.ratings = m.ratings; }, false);
        sheet.querySelectorAll('[data-rate]').forEach((x, i) => x.classList.toggle('on', i < starCount(b.rating)));
        return;
      }
      const sb = e.target.closest('[data-st]');
      if (sb) {
        seg.querySelectorAll('[data-st]').forEach(x => x.classList.toggle('on', x === sb));
        moveInd();
        let after;
        await this.update([id], m => { applyStatus(m, sb.dataset.st); after = m; }, false);
        root._markedDone = sb.dataset.st === 'done';
        if (sb.dataset.st === 'done' && !after.rating) {            // finished: nudge the stars on the card
          const q = sheet.querySelector('.bc-rate-hint') || Object.assign(document.createElement('div'), { className: 'bc-rate-hint', textContent: '读完了，给它打个分吧 ↑' });
          sheet.querySelector('.bc-meta').appendChild(q);
          sheet.querySelectorAll('[data-rate]').forEach((s, i) => s.animate([{ transform: 'none' }, { transform: 'translateY(-5px) scale(1.25)' }, { transform: 'none' }], { duration: 450, delay: i * 70 }));
        }
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'cover') {
        const row = sheet.querySelector('.bc-cover');
        row.classList.toggle('hidden');
        if (!row.classList.contains('hidden')) row.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 220 });
        return;
      }
      if (act === 'cover-set') { close(); return this.pickCover([id]); }   // the photo picker must open inside the tap
      await close();
      this.run(act, [id]);
    });
  },

  // ================= Actions (shared by the menu and the select toolbar) =================
  async run(act, ids) {
    const one = ids.length === 1 ? await DB.getMeta(ids[0]) : null;
    switch (act) {
      case 'rename': {
        const t = await promptDialog({ title: '重命名', value: bookName(one.title), ok: '保存' });
        // The pairing in the stored title stays with the book when only the name is changed
        const keepCP = bookCP(one.title);
        if (t) await this.update(ids, m => { m.title = keepCP && !bookCP(t) ? `【${keepCP}】${t}` : t; m.renamed = true; });
        break;
      }
      case 'move': return this.pickFolder(ids);
      case 'tags': return this.pickTags(ids);
      case 'pin': {
        const metas = await Promise.all(ids.map(id => DB.getMeta(id)));
        const pin = !metas.every(m => m.pinned);
        await this.update(ids, m => { if (pin) m.pinned = Date.now(); else delete m.pinned; });
        toast(pin ? '已置顶' : '已取消置顶');
        break;
      }
      case 'rate': return this.pickRating(ids, one?.rating || 0);
      case 'cover-clear':
        await this.update(ids, m => { delete m.cover; delete m.coverColor; });
        toast('已恢复默认封面');
        break;
      case 'share': return this.share(ids[0]);
      case 'stats': return StatsPage.open(ids[0]);
      case 'st-unread': case 'st-reading': case 'st-done': {
        const s = act.slice(3), unrated = [];
        await this.update(ids, m => { applyStatus(m, s); if (s === 'done' && !m.rating) unrated.push(m); });
        toast('已标记为' + STATUS_NAMES[s]);
        if (unrated.length === 1) setTimeout(() => askRating(unrated[0]), 500);
        break;
      }
      case 'hide': {
        const metas = await Promise.all(ids.map(id => DB.getMeta(id)));
        const hide = !metas.every(m => m.hidden);
        await this.update(ids, m => { m.hidden = hide; });
        toast(hide ? `已隐藏 ${ids.length} 本` : '已取消隐藏');
        break;
      }
      case 'delete': {
        const ok = await confirmDialog({
          title: ids.length > 1 ? `删除 ${ids.length} 本书？` : `删除《${bookName(one.title)}》？`,
          message: '书籍、阅读进度、书签和笔记都会被删除，无法恢复。', ok: '删除', danger: true });
        if (!ok) return false;
        for (const id of ids) await DB.remove(id);
        await this.render();
        toast('已删除');
        break;
      }
    }
    return true;
  },

  // ---------- pickers ----------
  pickCover(ids) {
    const input = document.getElementById('cover-picker');
    input.onchange = async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      const result = await CoverEditor.open(file);
      if (!result) return;
      await this.update(ids, m => { m.cover = result.image; m.coverColor = result.color; });
      toast(ids.length > 1 ? `已更新 ${ids.length} 本书的封面` : '封面已更新');
      this.exitSelect();
    };
    input.click();
  },

  async pickFolder(ids) {
    const metas = await Promise.all(ids.map(id => DB.getMeta(id)));
    const cur = metas.every(m => m.folder === metas[0].folder) ? metas[0].folder : undefined;
    const count = f => this.books.filter(b => b.folder === f).length;
    const rows = this.folders().map(f => `<button class="pk-row${cur === f ? ' on' : ''}" data-f="${esc(f)}">${ICON.folder}<span>${esc(f)}</span><small>${count(f)}</small></button>`).join('');
    // "New folder" is the first row, so it can never end up below the fold or behind the toolbar
    const s = quickSheet(`
      <div class="pk-title">移动到文件夹<small>已选 ${ids.length} 本</small></div>
      <div class="pk-foot"><button class="pk-row add" data-new="1">＋ 新建文件夹</button></div>
      <div class="pk-list sheet-scroll">
        ${rows || '<div class="pk-empty">还没有文件夹，先新建一个</div>'}
        ${metas.some(m => m.folder) ? `<button class="pk-row muted" data-f="">移出文件夹</button>` : ''}
      </div>`, 'pk-folders');
    s.card.onclick = async e => {
      const row = e.target.closest('.pk-row');
      if (!row) return;
      let f = row.dataset.f;
      if (row.dataset.new) {                       // the sheet stays open under the name dialog; cancel returns to it
        f = await this.createFolder();
        if (!f) return;
      }
      // A folder the selection leaves behind stays on the shelf even if it is now empty
      const left = [...new Set(metas.map(m => m.folder).filter(x => x && x !== f))];
      if (left.length) this.saveExtraFolders([...this.extraFolders(), ...left]);
      await s.close();
      await this.update(ids, m => { if (f) m.folder = f; else delete m.folder; });
      toast(f ? `已移到「${f}」` : '已移出文件夹');
      this.exitSelect();                           // straight back to the shelf
    };
  },

  // Tags: your own tags are what the shelf filters by. The book's own pairing and
  // characters are offered underneath as one-tap suggestions.
  async pickTags(ids) {
    const metas = await Promise.all(ids.map(id => DB.getMeta(id)));
    const all = [...new Set([...this.tags(), ...metas.flatMap(m => m.userTags || [])])];
    const state = t => { const n = metas.filter(m => (m.userTags || []).includes(t)).length; return n === metas.length ? 'on' : n ? 'some' : ''; };
    const suggestions = [...new Set(metas.flatMap(m => [...metaGroup(m, /relationship|pairing|\bcp\b/i).slice(0, 2), ...metaGroup(m, /character/i).slice(0, 4)]))]
      .filter(t => !all.includes(t)).slice(0, 10);
    const s = quickSheet(`
      <div class="pk-title">标签<small>${ids.length > 1 ? `${ids.length} 本书` : esc(bookName(metas[0].title))}</small></div>
      <div class="tag-cloud">
        ${all.map(t => `<button class="tag-chip ${state(t)}" data-t="${esc(t)}">#${esc(t)}</button>`).join('')}
        <button class="tag-chip add" data-new="1">＋ 新标签</button>
      </div>
      ${suggestions.length ? `<div class="pk-sub">从作品信息添加</div><div class="tag-cloud">${suggestions.map(t => `<button class="tag-chip ghost" data-t="${esc(t)}">＋ ${esc(t)}</button>`).join('')}</div>` : ''}
      <button class="pk-done">完成</button>`);
    s.card.onclick = async e => {
      if (e.target.closest('.pk-done')) { await s.close(); this.exitSelect(); return this.render(); }
      const chip = e.target.closest('.tag-chip');
      if (!chip) return;
      let t = chip.dataset.t;
      if (chip.dataset.new) { t = await promptDialog({ title: '新标签', placeholder: '比如：甜文、待重读', ok: '添加' }); if (!t) return; }
      const on = chip.classList.contains('on') && !chip.dataset.new && !chip.classList.contains('ghost');
      for (const m of metas) {
        const set = new Set(m.userTags || []);
        on ? set.delete(t) : set.add(t);
        m.userTags = [...set];
        await DB.putMeta(m);
      }
      // Update the chip in place
      if (chip.dataset.new || chip.classList.contains('ghost')) {
        const c = Object.assign(document.createElement('button'), { className: 'tag-chip on', textContent: '#' + t });
        c.dataset.t = t;
        s.card.querySelector('.tag-cloud').insertBefore(c, s.card.querySelector('.tag-chip.add'));
        if (chip.classList.contains('ghost')) chip.remove();
      } else {
        chip.classList.toggle('on', !on);
        chip.classList.remove('some');
      }
    };
  },

  pickRating(ids, current) {
    const s = quickSheet(`
      <div class="pk-title">评分</div>
      <div class="rate-row">${[1, 2, 3, 4, 5].map(n => `<button data-n="${n}" class="${n <= current ? 'on' : ''}">★</button>`).join('')}</div>`);
    const stars = [...s.card.querySelectorAll('.rate-row button')];
    s.card.onclick = async e => {
      const b = e.target.closest('[data-n]');
      if (!b) return;
      const n = +b.dataset.n;
      stars.forEach((x, i) => x.classList.toggle('on', i < n));
      b.animate?.([{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.34,1.56,.64,1)' });
      await this.update(ids, m => { rateBook(m, n); });
      setTimeout(() => { s.close(); this.exitSelect(); }, 280);
    };
  },

  async share(id) {
    const meta = await DB.getMeta(id), content = await DB.getContent(id);
    toast('正在生成 EPUB…');
    const blob = await Epub.build(meta, content.chapters);
    const name = meta.title.replace(/[\\/:*?"<>|]/g, '_') + '.epub';
    const file = new File([blob], name, { type: 'application/epub+zip' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch { /* cancelled */ }
    } else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  },

  // ================= Multi-select mode =================
  // ---------- display mode switch ----------
  renderModeBtn() {
    const btn = document.getElementById('btn-mode'), m = SHELF_MODES.find(x => x.key === shelfMode());
    btn.innerHTML = `${m.icon}<span>${m.name}</span>`;
    btn.classList.toggle('hidden', !this.books.length);
  },
  openModeMenu() {
    document.querySelector('.mode-menu')?.remove();
    const btn = document.getElementById('btn-mode'), r = btn.getBoundingClientRect(), cur = shelfMode();
    const menu = document.createElement('div');
    menu.className = 'mode-menu';
    menu.innerHTML = SHELF_MODES.map(m => `<button data-mode="${m.key}" class="${m.key === cur ? 'on' : ''}">${m.icon}<span>${m.name}</span></button>`).join('');
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
    document.body.appendChild(menu);
    menu.animate([{ opacity: 0, transform: 'translateY(-4px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    const close = () => { menu.remove(); removeEventListener('pointerdown', outside, true); };
    const outside = e => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); };
    setTimeout(() => addEventListener('pointerdown', outside, true));
    menu.onclick = e => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      close();
      if (b.dataset.mode === cur) return;
      try { localStorage.setItem(MODE_KEY, b.dataset.mode); } catch {}
      document.getElementById('shelf').scrollTop = 0; scrollTo(0, 0);
      this.render();
    };
  },

  enterSelect() {
    this.selecting = true;
    this.selected.clear();
    document.getElementById('shelf').classList.add('selecting');
    const bar = document.getElementById('select-bar'), top = document.getElementById('select-top');
    [bar, top].forEach(el => el.classList.remove('hidden'));
    top.animate([{ transform: 'translateY(-100%)' }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.32,.72,0,1)' });
    bar.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.32,.72,0,1)' });
    this.updateSelectBar();
  },
  async exitSelect() {
    if (!this.selecting) return;
    document.querySelectorAll('.sheet-modal.fixed').forEach(r => r._close?.());
    this.selecting = false;
    this.selected.clear();
    document.querySelectorAll('.card.picked').forEach(c => c.classList.remove('picked'));
    document.getElementById('shelf').classList.remove('selecting');
    const bar = document.getElementById('select-bar'), top = document.getElementById('select-top');
    await Promise.all([
      top.animate([{ transform: 'none' }, { transform: 'translateY(-100%)' }], { duration: 220, fill: 'forwards' }).finished,
      bar.animate([{ transform: 'none' }, { transform: 'translateY(100%)' }], { duration: 220, fill: 'forwards' }).finished,
    ]);
    [bar, top].forEach(el => { el.classList.add('hidden'); el.getAnimations().forEach(a => a.cancel()); });
  },
  toggle(card) {
    const id = card.dataset.id;
    this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
    card.classList.toggle('picked', this.selected.has(id));
    if (this.selected.has(id)) card.querySelector('.pick').animate([{ transform: 'translateY(-60%)' }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    this.updateSelectBar();
  },
  updateSelectBar() {
    if (!this.selecting) return;
    const n = this.selected.size, total = this.visible().length;
    document.querySelector('#select-top .st-count').textContent = n ? `已选 ${n} 本` : '选择书籍';
    document.querySelector('#select-top [data-sa]').textContent = n === total && total ? '全不选' : '全选';
    document.querySelectorAll('#select-bar button').forEach(b => { b.disabled = !n; });
    const hideBtn = document.querySelector('#select-bar [data-act="hide"]');
    hideBtn.innerHTML = `${this.showHidden ? ICON.show : ICON.hide}<span>${this.showHidden ? '取消隐藏' : '隐藏'}</span>`;
  },

  bindSelectBar() {
    const top = document.getElementById('select-top'), bar = document.getElementById('select-bar');
    top.querySelector('[data-close]').onclick = () => this.exitSelect();
    top.querySelector('[data-sa]').onclick = () => {
      const ids = this.visible().map(b => b.id);
      if (this.selected.size === ids.length) this.selected.clear(); else ids.forEach(id => this.selected.add(id));
      document.querySelectorAll('.card').forEach(c => c.classList.toggle('picked', this.selected.has(c.dataset.id)));
      this.updateSelectBar();
    };
    bar.querySelectorAll('button').forEach(b => { b.innerHTML = `${ICON[b.dataset.icon]}<span>${b.dataset.label}</span>`; });
    bar.onclick = async e => {
      const btn = e.target.closest('button');
      if (!btn || btn.disabled) return;
      const ids = [...this.selected], act = btn.dataset.act;
      if (act === 'cover') return this.popover(btn, [['cover-set', '修改封面'], ['cover-clear', '清除封面']], ids);
      if (act === 'more') return this.popover(btn, [['status-menu', '修改阅读状态', true], ['delete', '删除', false, 'danger']], ids);
      const done = await this.run(act, ids);
      if (['pin', 'hide'].includes(act) && done !== false) this.exitSelect();
    };
  },

  // A small menu that pops up above a toolbar button
  popover(anchor, items, ids, below = false) {
    document.querySelector('.popover-wrap')?.remove();
    const wrap = document.createElement('div');
    wrap.className = 'popover-wrap';
    const render = (list, title) => `
      ${title ? `<button class="po-item po-head" data-back="1">${esc(title)}<span>${ICON.down}</span></button>` : ''}
      ${list.map(([act, label, sub, cls]) => `<button class="po-item ${cls || ''}" data-act="${act}">${label}${sub ? `<span>${ICON.right}</span>` : ''}</button>`).join('')}`;
    wrap.innerHTML = `<div class="popover">${render(items)}</div>`;
    document.body.appendChild(wrap);
    const pop = wrap.firstElementChild, r = anchor.getBoundingClientRect();
    const place = () => {
      const w = pop.offsetWidth, h = pop.offsetHeight;
      pop.style.left = Math.max(10, Math.min(innerWidth - w - 10, r.left + r.width / 2 - w / 2)) + 'px';
      pop.style.top = (below ? r.bottom + 8 : r.top - h - 10) + 'px';
      pop.style.transformOrigin = `${r.left + r.width / 2 - parseFloat(pop.style.left)}px ${below ? 0 : h}px`;
    };
    place();
    pop.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 300, easing: 'cubic-bezier(.32,1.25,.6,1)' });
    const close = async () => {
      await pop.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.7)' }], { duration: 160, fill: 'forwards' }).finished;
      wrap.remove();
    };
    wrap.onclick = async e => {
      if (e.target === wrap) return close();
      if (e.target.closest('[data-back]')) { pop.innerHTML = render(items); place(); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'status-menu') {
        pop.innerHTML = render([['st-done', '读完'], ['st-reading', '在读'], ['st-unread', '未读']], '修改阅读状态');
        place();
        pop.animate([{ opacity: .4 }, { opacity: 1 }], { duration: 180 });
        return;
      }
      if (act === 'cover-set') { close(); return this.pickCover(ids); }
      if (act === 'imp-file') { close(); return document.getElementById('picker').click(); }   // must stay inside the tap
      if (act === 'imp-paste') { close(); return importFromClipboard(); }
      if (act === 'imp-folder') { close(); return Downloads.collect(); }   // inside the tap: the folder permission may need asking
      await close();
      const done = await this.run(act, ids);
      if (done !== false) this.exitSelect();
    };
  },
};
