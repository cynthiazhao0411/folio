// library.js — The bookshelf: jackets, sorting & filters, the long-press context menu,
// multi-select mode with its toolbar, and the small dialogs/pickers they use.
//
// Per-book fields managed here (all on the book's meta record):
//   pinned (timestamp) · folder (name) · userTags [] · rating 0–5 · status 'unread'|'reading'|'done'
//   trashedAt (timestamp): in the trash (回收站); everything else about the book is kept as it was
//   hidden (bool, no longer used: every book shows on the shelf) · renamed (bool, so a re-import keeps the custom title)

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
// ---------- searching the shelf (书目搜索) ----------
// Simplified and traditional match each other, and case and full-/half-width don't matter
// (Ａｂｃ = abc). Looked in: title, author, CP, characters, your tags and the book's own tags.
const searchKey = s => toSimplified(String(s || '').normalize('NFKC')).toLowerCase().replace(/\s+/g, ' ').trim();
function matchBook(b, q) {
  if (!b._sk) Object.defineProperty(b, '_sk', { value: searchKey([
    b.title, bookName(b.title), ...(b.authors || []), b.cp, ...(b.titleTags || []), ...(b.userTags || []),
    ...Object.values(b.tags || {}).flat(),
  ].filter(Boolean).join('\n')), enumerable: false });
  return searchKey(q).split(' ').every(w => b._sk.includes(w));
}
// ---------- filters (筛选) ----------
// Conditions stack: within one kind any value matches (OR), across kinds all must match (AND).
//   cat 作品分类 · cp · ch 角色 · tag (your tags) · end 完结/连载 · len 短篇/中篇/长篇 ·
//   read 未读/在读/读完 · rate 'none' | minimum stars · folder (id, its sub-folders included)
// A combination can be saved as 我的筛选 (prefs 'savedFilters': synced and backed up).
const GROUP_RE = { cat: /^fan|作品|原作|series/i, cp: /relationship|pairing|配对|\bcp\b/i, ch: /character|角色|人物/i };
const lenOf = b => !b.words ? '' : b.words < 30000 ? '短篇' : b.words < 100000 ? '中篇' : '长篇';
const filterCount = f => !f ? 0 : ['cat', 'cp', 'ch', 'tag', 'end', 'len', 'read'].reduce((n, k) => n + (f[k]?.length ? 1 : 0), 0) + (f.rate ? 1 : 0) + (f.folder ? 1 : 0);
function bookValues(b, k) {
  if (k === 'cp') return [...new Set([...metaGroup(b, GROUP_RE.cp), ...(b.cp ? [b.cp] : [])])];
  if (k === 'cat' || k === 'ch') return metaGroup(b, GROUP_RE[k]);
  if (k === 'tag') return b.userTags || [];
  return [];
}
function passFilter(b, f, under) {
  const any = (k, vals) => !f[k]?.length || f[k].some(v => vals.includes(v));
  if (!any('cat', bookValues(b, 'cat')) || !any('cp', bookValues(b, 'cp')) || !any('ch', bookValues(b, 'ch')) || !any('tag', bookValues(b, 'tag'))) return false;
  if (f.end?.length && !f.end.some(v => systemTags(b).includes(v))) return false;
  if (f.len?.length && !f.len.includes(lenOf(b))) return false;
  if (f.read?.length && !f.read.includes(statusOf(b))) return false;
  if (f.rate === 'none' ? b.rating : f.rate && (b.rating || 0) < f.rate) return false;
  if (f.folder && !under.has(b.folderId)) return false;
  return true;
}
const metaGroup = (b, re) => { const k = Object.keys(b.tags || {}).find(k => re.test(k)); return k ? b.tags[k].filter(Boolean) : []; };
function coverSubtitle(b) {
  return metaGroup(b, /relationship|pairing|配对|\bcp\b/i)[0] || b.authors.join('、') || '';
}
// The pairing taken from the 【】 in the title: shown under the jacket on the cover page only
const coverCP = b => b.cp || bookCP(b.title);

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
addEventListener('resize', () => { fitShelf(); const g = document.getElementById('grid'); if (g) { layoutWall(g); fitTitles(g); } });
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
const ICON_SORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3.5 16.5 7 20l3.5-3.5M17 20V4M13.5 7.5 17 4l3.5 3.5"/></svg>';
function shelfMode() {
  let m; try { m = localStorage.getItem(MODE_KEY); } catch {}
  return SHELF_MODES.some(x => x.key === m) ? m : 'shelf';
}

// Shelf order. Pinned books always come first; within them and the rest the chosen order applies.
// Each order has a natural direction (newest first, A to Z, highest first, ...); tapping the chosen
// order again reverses it. Books without a value (no rating, no length) stay last either way.
// Like the display mode, the choice is this device's view preference (localStorage).
const SORTS = [
  { key: 'recent', name: '最近阅读', val: b => b.lastReadAt || b.addedAt || 0, desc: true },
  { key: 'added', name: '最近添加', val: b => b.addedAt || 0, desc: true },
  { key: 'title', name: '书名', val: b => bookName(b.title || ''), text: true },
  { key: 'author', name: '作者', val: b => (b.authors || [])[0] || '', text: true },
  { key: 'rating', name: '评分', val: b => b.rating || null, desc: true },
  { key: 'progress', name: '阅读进度', val: b => statusOf(b) === 'done' ? 101 : b.progress?.pct || 0, desc: true },
  { key: 'words', name: '字数', val: b => b.words || null, desc: true },
];
const SORT_KEY = 'folio-shelf-sort';
const collator = new Intl.Collator('zh-Hans-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });
function shelfSort() {
  let s; try { s = JSON.parse(localStorage.getItem(SORT_KEY)); } catch {}
  const def = SORTS.find(x => x.key === s?.key) || SORTS[0];
  return { def, rev: !!s?.rev && def === SORTS.find(x => x.key === s?.key) };
}
function sortBooks(list) {
  const { def, rev } = shelfSort(), dir = (def.desc ? -1 : 1) * (rev ? -1 : 1);
  const recent = SORTS[0].val;
  return list.map(b => ({ b, v: def.val(b) })).sort((x, y) => {
    const p = (y.b.pinned || 0) - (x.b.pinned || 0);
    if (p) return p;
    const nx = x.v === null || x.v === '', ny = y.v === null || y.v === '';
    if (nx !== ny) return nx ? 1 : -1;                       // missing values last, whatever the direction
    const c = nx ? 0 : def.text ? collator.compare(x.v, y.v) : x.v - y.v;
    return c * dir || recent(y.b) - recent(x.b) || collator.compare(bookName(x.b.title || ''), bookName(y.b.title || ''));
  }).map(x => x.b);
}

// Cover wall (封面墙): books displayed on ledges, like a private collection on picture rails.
// Each jacket's height follows the book's length (短篇 shorter, 长篇 tallest), so the variety on the
// wall comes from the books themselves. Books keep the shelf's order, left to right; each ledge is
// justified to the full width, and the last ledge is balanced against the one before it, so no
// ledge ends in a gap and no book is left on its own. Captions hang under the ledge like museum
// labels; a plate wide enough also shows the summary and tags. Only a shelf too small to fill one
// ledge (one or two books) is shown centred, at the largest size.
// How the shelf is arranged (this device): every book ('all', folders as chips above), or by folder
// ('folders': folders shown as tiles among the books, tap one to go in)
const GROUP_KEY = 'folio-shelf-group';
const shelfGroup = () => { try { return localStorage.getItem(GROUP_KEY) === 'folders' ? 'folders' : 'all'; } catch { return 'all'; } };
const WALL_REL = b => { const w = b?.words || 0; return !w ? .9 : w < 30000 ? .8 : w < 100000 ? .9 : 1; };
const JACKET = 2 / 3;                                     // jacket width : height
function wallMetrics(width) {
  return width < 600 ? { H: 300, max: 345, min: 200, gap: 16, most: 3 }
    : width < 1000 ? { H: 300, max: 345, min: 215, gap: 26, most: 5 } : { H: 330, max: 380, min: 240, gap: 34, most: 8 };
}
// Split the books (in order) into ledges so that every ledge, the last one included, comes as close
// as possible to the ideal height: dynamic programming over where each ledge ends. A ledge's height
// is what makes its jackets fill the width exactly; ledges that would have to stand taller than
// `max` are only accepted when nothing else can work (a shelf of one or two books), and are centred.
function planWall(rels, W) {
  const m = wallMetrics(W), n = rels.length, pre = [0];
  for (const r of rels) pre.push(pre.at(-1) + r * JACKET);
  const height = (a, b) => (W - m.gap * (b - a - 1)) / (pre[b] - pre[a]);       // books a..b-1
  const cost = (a, b) => { const h = height(a, b); return (h > m.max ? 1e6 + (h - m.max) * 100 : h < m.min ? 1e5 + (m.min - h) * 100 : 0) + ((h - m.H) / m.H) ** 2; };
  const best = [0], from = [0];
  for (let b = 1; b <= n; b++) {
    best[b] = Infinity;
    for (let a = Math.max(0, b - m.most); a < b; a++) { const c = best[a] + cost(a, b); if (c < best[b]) { best[b] = c; from[b] = a; } }
  }
  const rows = [];
  for (let b = n; b > 0; b = from[b]) rows.unshift([from[b], b]);
  return rows.map(([a, b]) => { const h = height(a, b); return { items: Array.from({ length: b - a }, (_, k) => a + k), h: Math.min(h, m.max), centred: h > m.max + .5 }; });
}
function layoutWall(grid) {
  if (!grid?.classList.contains('mode-wall')) return;
  const cards = [...grid.querySelectorAll('.card')];
  if (!cards.length) return;
  const W = grid.clientWidth, m = wallMetrics(W);
  const rels = cards.map(c => +c.dataset.rel || .9);
  grid.style.setProperty('--wgap', m.gap + 'px');
  for (const { items, h, centred } of planWall(rels, W)) {
    const widths = items.map(k => rels[k] * JACKET * h), used = widths.reduce((s, w) => s + w, 0) + m.gap * (items.length - 1);
    items.forEach((k, j) => {
      const c = cards[k], w = widths[j], ch = rels[k] * h;
      c.classList.toggle('w-first', j === 0);
      c.classList.toggle('w-last', j === items.length - 1);
      c.classList.toggle('w-roomy', w >= 150);
      c.style.width = w + 'px';
      c.style.marginLeft = j === 0 && centred ? (W - used) / 2 + 'px' : '';
      c.style.setProperty('--ledge', h + 'px');       // all jackets on a ledge stand on the same line
      c.style.setProperty('--jh', ch + 'px');
      c.style.setProperty('--jw', w + 'px');
      c.querySelector('.cover').style.fontSize = (w / 12.5).toFixed(1) + 'px';
    });
  }
}
// The extra lines list and wall modes show (the shelf mode keeps its card as it was)
const plainText = html => (Object.assign(document.createElement('div'), { innerHTML: html }).textContent || '').replace(/\s+/g, ' ').trim();
function cardExtra(b, i, st, pct) {
  const tags = systemTags(b), au = (b.authors || []).join('、');
  const w = b.words ? (b.words >= 10000 ? (b.words / 10000).toFixed(1).replace(/\.0$/, '') + ' 万字' : b.words + ' 字') : '';
  return `<div class="x">
      <div class="x-no">No. ${String(i + 1).padStart(2, '0')}</div>
      ${au ? `<div class="x-au">${esc(au)}</div>` : ''}
      ${b.summary ? `<div class="x-sum">${esc(plainText(b.summary).slice(0, 220))}</div>` : ''}
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
  else if (/完结|完本|全文完/.test([b.title, ...(b.titleTags || [])].join(' '))) out.push('完结');
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
// safe: the cancel button is the prominent one (on the right) and the action only a faint one
function dialog({ title, message = '', input = null, ok = '确定', danger = false, safe = false, cancel = '取消' }) {
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
          ${safe ? `<button data-r="1" class="faint">${esc(ok)}</button><button data-r="0" class="strong">${esc(cancel)}</button>` : `
          ${ok === '好' && input === null ? '' : `<button data-r="0">${esc(cancel)}</button>`}
          <button data-r="1" class="${danger ? 'danger' : 'strong'}">${esc(ok)}</button>`}
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
  filter: 'all',            // 'all' | 'f:<folder id>' | 't:<tag>'
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
  // ---------- folders ----------
  // Folders form a tree, kept in prefs 'folderTree' as [{ id, name, parent, order }] (parent null =
  // top level), so they are synced and backed up with everything else. A book points to its folder
  // by m.folderId; the folder's name is still written to m.folder as before, so older versions (and
  // old backups) keep working. Folders from before the tree (a book's folder name, or an empty
  // folder in prefs 'folders') become top-level folders with the id 'n:<name>': the same id on every
  // device, so two devices that upgrade separately still agree after a sync. The repair only adds.
  _tree: [],
  async loadTree() {
    const raw = await DB.getPref('folderTree');
    const tree = Array.isArray(raw) ? raw.filter(f => f && f.id && typeof f.name === 'string').map(f => ({ ...f })) : [];
    let changed = !Array.isArray(raw);
    const byId = new Map(tree.map(f => [f.id, f]));
    const add = (name, id = 'n:' + name) => {
      if (!byId.has(id)) { const f = { id, name, parent: null, order: tree.length }; tree.push(f); byId.set(id, f); changed = true; }
      return byId.get(id);
    };
    // A parent that no longer exists, or a loop, puts the folder back at the top level
    for (const f of tree) {
      const seen = new Set([f.id]);
      for (let p = f.parent; p; p = byId.get(p)?.parent) {
        if (!byId.has(p) || seen.has(p)) { f.parent = null; changed = true; break; }
        seen.add(p);
      }
      if (f.parent === undefined) f.parent = null;
    }
    // Empty folders from before the tree (older versions kept them in localStorage first)
    let extra = await DB.getPref('folders');
    if (!Array.isArray(extra)) {
      try { extra = JSON.parse(localStorage.getItem('folio-folders') || '[]'); } catch { extra = []; }
      localStorage.removeItem('folio-folders');
    }
    for (const n of extra) if (n && typeof n === 'string' && !tree.some(f => f.name === n)) add(n);
    // Books: m.folder (the name) is what older versions write, so it decides. A folderId that is
    // missing or names another folder is found again by name (an older version moved the book).
    const fix = [];
    for (const b of this.books) {
      const f = b.folderId && byId.get(b.folderId);
      if (!b.folder) { if (b.folderId) { delete b.folderId; fix.push(b); } continue; }
      if (f && f.name === b.folder) continue;
      if (b.folderId && !f) { add(b.folder, b.folderId); continue; }    // its folder record was lost: bring it back
      const same = tree.filter(x => x.name === b.folder);
      b.folderId = (same.find(x => !x.parent) || same[0] || add(b.folder)).id;
      fix.push(b);
    }
    this._tree = tree;
    if (changed) await this.saveTree();
    for (const b of fix) await DB.putMeta(b);
  },
  async saveTree() {
    await DB.setPref('folderTree', this._tree);
    await DB.setPref('folders', [...new Set(this._tree.map(f => f.name))]);   // for older versions
  },
  folder(id) { return this._tree.find(f => f.id === id); },
  children(pid = null) {
    return this._tree.filter(f => (f.parent || null) === pid)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name, 'zh'));
  },
  path(id) { const out = []; for (let f = this.folder(id); f; f = this.folder(f.parent)) out.unshift(f); return out; },
  under(id) {                                            // the folder and everything inside it
    const out = new Set([id]);
    for (let grew = true; grew;) { grew = false; for (const f of this._tree) if (out.has(f.parent) && !out.has(f.id)) { out.add(f.id); grew = true; } }
    return out;
  },
  countIn(id) { const ids = this.under(id); return this.books.filter(b => ids.has(b.folderId)).length; },
  // Tree rows for pickers: every folder, indented by depth
  treeRows(skip = new Set()) {
    const rows = [];
    const walk = (pid, depth) => { for (const f of this.children(pid)) { if (skip.has(f.id)) continue; rows.push({ f, depth }); walk(f.id, depth + 1); } };
    walk(null, 0);
    return rows;
  },
  currentFolder() { return this.filter.startsWith('f:') ? this.filter.slice(2) : null; },
  async createFolder(parent = this.currentFolder()) {
    const p = parent && this.folder(parent);
    const name = (await promptDialog({ title: p ? `在「${p.name}」里新建文件夹` : '新建文件夹', placeholder: '文件夹名称', ok: '创建', max: 40 }))?.trim();
    if (!name) return null;
    const dup = this.children(p ? p.id : null).find(f => f.name === name);
    if (dup) return dup.id;
    const sib = this.children(p ? p.id : null);
    const f = { id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, parent: p ? p.id : null,
      order: sib.length ? Math.max(...sib.map(x => x.order ?? 0)) + 1 : 0 };
    this._tree.push(f);
    await this.saveTree();
    return f.id;
  },
  async renameFolder(id) {
    const f = this.folder(id);
    if (!f) return;
    const name = (await promptDialog({ title: '文件夹改名', value: f.name, placeholder: '文件夹名称', ok: '改名', max: 40 }))?.trim();
    if (!name || name === f.name) return;
    f.name = name;
    await this.saveTree();
    await this.update(this.books.filter(b => b.folderId === id).map(b => b.id), m => { m.folder = name; }, false);
    toast(`已改名为「${name}」`);
    await this.render();
  },
  // Deleting a folder never deletes books: its books and folders move up one level
  async removeFolder(id) {
    const f = this.folder(id);
    if (!f) return;
    const books = this.books.filter(b => b.folderId === id), subs = this.children(id);
    const up = f.parent ? this.folder(f.parent) : null;
    const where = up ? `「${up.name}」` : '书架最外层';
    const ok = await confirmDialog({ title: `删除文件夹「${f.name}」？`,
      message: books.length || subs.length
        ? `里面的${books.length ? ` ${books.length} 本书` : ''}${books.length && subs.length ? '和' : ''}${subs.length ? ` ${subs.length} 个文件夹` : ''}会移到${where}，书不会被删除。`
        : '这是一个空文件夹。', ok: '删除', danger: true });
    if (!ok) return;
    for (const s of subs) s.parent = f.parent || null;
    this._tree = this._tree.filter(x => x.id !== id);
    await this.saveTree();
    await this.update(books.map(b => b.id), m => { if (up) { m.folderId = up.id; m.folder = up.name; } else { delete m.folderId; delete m.folder; } }, false);
    if (this.filter === 'f:' + id) this.filter = up ? 'f:' + up.id : 'all';
    await this.render();
  },
  // Move a folder into another one (null = top level), optionally just before a sibling
  async moveFolder(id, parent, before = null) {
    const f = this.folder(id);
    if (!f || (parent && this.under(id).has(parent))) { toast('不能放进它自己里面'); return false; }
    f.parent = parent || null;
    const sib = this.children(f.parent).filter(x => x.id !== id);
    const at = before ? sib.findIndex(x => x.id === before) : -1;
    sib.splice(at < 0 ? sib.length : at, 0, f);
    sib.forEach((x, i) => { x.order = i; });
    await this.saveTree();
    await this.render();
    return true;
  },
  async moveBooks(ids, fid) {
    const f = fid && this.folder(fid);
    await this.update(ids, m => { if (f) { m.folderId = f.id; m.folder = f.name; } else { delete m.folderId; delete m.folder; } });
    toast(f ? `已移到「${f.name}」` : '已移出文件夹');
  },
  // The folder's own menu: long-press (or right-click) a folder chip
  folderMenu(id) {
    const f = this.folder(id);
    if (!f) return;
    navigator.vibrate?.(8);
    const sib = this.children(f.parent), i = sib.findIndex(x => x.id === id);
    const s = quickSheet(`
      <div class="pk-title">${ICON.folder} ${esc(f.name)}<small>${this.countIn(id)} 本</small></div>
      <div class="pk-list">
        <button class="pk-row" data-a="sub">＋ 在里面新建文件夹</button>
        <button class="pk-row" data-a="rename">改名</button>
        <button class="pk-row" data-a="move">移到别的文件夹…</button>
        ${i > 0 ? '<button class="pk-row" data-a="left">往前排</button>' : ''}
        ${i < sib.length - 1 ? '<button class="pk-row" data-a="right">往后排</button>' : ''}
        <button class="pk-row muted" data-a="del">删除文件夹（书不会删除）</button>
      </div>`, 'pk-folders');
    s.card.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      await s.close();
      if (a === 'sub') { const nid = await this.createFolder(id); if (nid) { this.filter = 'f:' + id; await this.render(); } }
      else if (a === 'rename') this.renameFolder(id);
      else if (a === 'del') this.removeFolder(id);
      else if (a === 'left') this.moveFolder(id, f.parent, sib[i - 1].id);
      else if (a === 'right') this.moveFolder(id, f.parent, sib[i + 2]?.id || null);
      else if (a === 'move') this.pickFolderFor(id);
    };
    return s;
  },
  pickFolderFor(id) {
    const f = this.folder(id);
    const rows = this.treeRows(this.under(id)).map(({ f: x, depth }) =>
      `<button class="pk-row${f.parent === x.id ? ' on' : ''}" data-f="${esc(x.id)}" style="padding-left:${1 + depth * 1.1}em">${ICON.folder}<span>${esc(x.name)}</span></button>`).join('');
    const s = quickSheet(`
      <div class="pk-title">把「${esc(f.name)}」移到</div>
      <div class="pk-list sheet-scroll">
        <button class="pk-row${f.parent ? '' : ' on'}" data-f="">书架最外层</button>
        ${rows}
      </div>`, 'pk-folders');
    s.card.onclick = async e => {
      const row = e.target.closest('.pk-row');
      if (!row) return;
      await s.close();
      if (await this.moveFolder(id, row.dataset.f || null)) toast('已移动');
    };
  },
  // Your own tags: those on books, plus tags made in 标签管理 that no book has yet (prefs 'extraTags')
  _extraTags: [],
  tags() { return [...new Set([...this.books.flatMap(b => b.userTags || []), ...this._extraTags])].sort((a, b) => a.localeCompare(b, 'zh')); },

  visible() {
    const f = this.filter;
    const loose = shelfGroup() === 'folders';             // by folder: the top level shows only books in no folder
    if (this.query) return sortBooks(this.books.filter(b => matchBook(b, this.query)));   // searching: the whole shelf
    if (filterCount(this.flt)) {                                       // filtering: the whole shelf, flat
      const under = this.flt.folder ? this.under(this.flt.folder) : null;
      return sortBooks(this.books.filter(b => passFilter(b, this.flt, under)));
    }
    const list = this.books
      .filter(b => f === 'all' ? !loose || !b.folderId || !this.folder(b.folderId)
        : f === 'new' ? b.isNew
        : f.startsWith('f:') ? b.folderId === f.slice(2) : (b.userTags || []).includes(f.slice(2)));
    return sortBooks(list);
  },

  // ---------- rendering ----------
  async render() {
    await balancePalettes();                 // books without a colour yet get one (saved with the book)
    await fixAuthors();                      // one spelling for anonymous works (see importer.js)
    this.books = (await DB.allMeta()).filter(b => !b.trashedAt);        // the trash is shown only in 回收站
    { const x = await DB.getPref('savedFilters'); this._savedFilters = Array.isArray(x) ? x : []; }
    if (this.flt?.folder && !this._tree.length) await this.loadTree();
    { const x = await DB.getPref('extraTags'); this._extraTags = Array.isArray(x) ? x : []; }
    await this.loadTree();
    const tags = this.tags();
    if (this.filter === 'new' && !this.books.some(b => b.isNew)) this.filter = 'all';
    if (this.filter !== 'all' && this.filter !== 'new' && !(this.filter.startsWith('f:') ? this.folder(this.filter.slice(2)) : tags.includes(this.filter.slice(2)))) this.filter = 'all';
    const cur = this.currentFolder();
    const list = this.visible();

    // Sub-header: count and today's reading time
    const today = (await DB.allDaily()).filter(r => r.date === new Date().toLocaleDateString('sv')).reduce((n, r) => n + r.ms, 0);
    document.getElementById('shelf-count').innerHTML = this.books.length
      ? this.query ? `<span>找到 ${list.length} 本</span>` : filterCount(this.flt) ? `<span>筛选出 ${list.length} 本</span>` : `<span>共 ${shelfGroup() === 'folders' && (this.filter === 'all' || cur) ? (cur ? this.countIn(cur) : this.books.length) : list.length} 本</span>${today ? `<span class="sc-today"><i> · </i>今日已读 ${fmtDur(today, true)}</span>` : ''}` : '';
    document.getElementById('btn-select').classList.toggle('hidden', !list.length);

    // Filter chips: all · folders. Tags are not shown on the shelf; they stay on the book card
    // (long-press) and in the data, and the 't:' filter in visible() is kept for later versions.
    const chips = document.getElementById('chips');
    const chip = (key, label, icon = '') => `<button data-filter="${esc(key)}" class="${this.filter === key ? 'on' : ''}">${icon}${esc(label)}</button>`;
    // At the top: new folder · 全部 · the top-level folders. Inside a folder: back · new folder
    // inside · this folder · its folders. Each folder shows how many books are in it (all levels).
    const fchip = f => `<button data-filter="f:${esc(f.id)}" data-fid="${esc(f.id)}" class="${this.filter === 'f:' + f.id ? 'on' : ''}">${ICON.folder}${esc(f.name)}<small class="chip-n">${this.countIn(f.id)}</small></button>`;
    const byFolder = shelfGroup() === 'folders';      // by folder: folders are tiles in the grid, not chips
    if (this.query) {
      chips.innerHTML = '';
    } else if (filterCount(this.flt)) {
      const saved = this._savedFilters.find(x => JSON.stringify(x.f) === JSON.stringify(this.flt));
      chips.innerHTML = `<button class="chip-back" data-clearfilter="1">✕ 清除筛选</button><button class="crumb on" data-openfilter="1">${saved ? esc(saved.name) : `筛选 · ${filterCount(this.flt)} 项`}</button>`;
    } else if (this.filter === 'new') {
      chips.innerHTML = `<button class="chip-back" data-filter="all" data-up="">‹ 全部</button><i class="crumb-sep">›</i><button class="crumb on" data-filter="new">新书</button>`;
    } else if (cur) {
      // Breadcrumbs, like a file explorer: ‹ 全部 › 亚内 › 个 — every level is a pill; tap one to jump there
      chips.innerHTML = `<button class="chip-back" data-filter="all" data-up="">‹ 全部</button>`
        + this.path(cur).map(x => `<i class="crumb-sep">›</i><button data-filter="f:${esc(x.id)}" data-fid="${esc(x.id)}" class="crumb${x.id === cur ? ' on' : ''}">${esc(x.name)}</button>`).join('')
        + `<button class="chip-new" data-newfolder="1">＋ 新建文件夹</button>` + (byFolder ? '' : this.children(cur).map(fchip).join(''));
    } else if (byFolder) {
      chips.innerHTML = `<button class="chip-new" data-newfolder="1">＋ 新建文件夹</button>`;
    } else {
      const top = this.children(null);
      chips.innerHTML = `<button class="chip-new" data-newfolder="1">＋ 新建文件夹</button>`
        + (top.length ? chip('all', '全部') + top.map(fchip).join('') : '');
    }

    // Continue reading: the book opened most recently (not one already finished)
    // Newly collected books not opened yet: a slim banner leads straight to them (× hides it until
    // the next new book arrives); each of them also wears a 新书 mark until it is first opened
    const fresh = this.books.filter(b => b.isNew).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const nb = document.getElementById('new-arrivals'), key = fresh.map(b => b.id).join();
    let gone = ''; try { gone = localStorage.getItem('folio-new-dismissed') || ''; } catch {}
    const showNew = fresh.length && !this.selecting && this.filter !== 'new' && gone !== key;
    nb.classList.toggle('hidden', !showNew);
    if (showNew) {
      nb.innerHTML = `<button class="na-go"><span class="na-dot"></span><span class="na-text">${fresh.length > 1 ? `新收到 ${fresh.length} 本书` : `新收到《${esc(bookName(fresh[0].title))}》`}</span><span class="na-sub">${fresh.length > 1 ? esc(fresh.slice(0, 3).map(b => bookName(b.title)).join('、')) + (fresh.length > 3 ? ' 等' : '') : '还没打开'}</span><span class="na-arrow">${fresh.length > 1 ? '看看 ›' : '打开 ›'}</span></button><button class="na-x" aria-label="不再提示">×</button>`;
      nb.querySelector('.na-go').onclick = () => fresh.length > 1 ? this.go('new') : openBook(fresh[0].id, null, true);
      nb.querySelector('.na-x').onclick = () => { try { localStorage.setItem('folio-new-dismissed', key); } catch {} nb.classList.add('hidden'); };
    }
    const cont = document.getElementById('continue');
    let last = !this.selecting && this.books
      .filter(b => b.lastReadAt && statusOf(b) !== 'done')
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
    // By folder: this level's folders come first, as tiles (a 2×2 of covers from everything inside)
    const tiles = byFolder && !this.query && !filterCount(this.flt) && (this.filter === 'all' || cur) ? this.children(cur).map(f => {
      const ids = this.under(f.id), n = this.countIn(f.id), subs = this.children(f.id).length;
      const covers = sortBooks(this.books.filter(b => ids.has(b.folderId))).slice(0, 4);
      return `
        <div class="card folder-card" data-fid="${esc(f.id)}"${mode === 'wall' ? ' data-rel=".9"' : ''}>
          <div class="card-cover"><div class="cover fold-box"><div class="fold-grid">${covers.map(b => jacket(b, 'fold-j')).join('')}</div><span class="fold-n">${n} 本</span>${this.books.some(b => b.isNew && ids.has(b.folderId)) ? '<span class="fold-new">新</span>' : ''}</div></div>
          <div class="card-info"><div class="t">${esc(f.name)}</div><div class="s">${subs ? `${subs} 个文件夹 · ` : ''}${n} 本</div></div>
        </div>`;
    }).join('') : '';
    if (this.query && this.searchMode !== 'books' && this.books.length) return this.renderFind(grid);
    if (!this.books.length || (!list.length && !tiles && this.filter === 'all')) {
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
    if (!list.length && this.query) { grid.innerHTML = `<div class="empty small"><p class="empty-sub">没有找到「${esc(this.query)}」</p></div>`; return; }
    if (!list.length && !tiles) { grid.innerHTML = `<div class="empty small"><p class="empty-sub">${cur && this.children(cur).length ? '书都在上面的文件夹里' : '这里还没有书'}</p></div>`; return; }
    grid.innerHTML = tiles + list.map((b, i) => {
      if (b.t2s) b = { ...b, title: toSimplified(b.title) };     // traditional books shown in simplified
      const st = statusOf(b), pct = b.progress?.pct || 0;
      const sub = st === 'done' ? (b.reads ? `读完 ${b.reads} 遍` : '读完') : st === 'reading' ? Math.max(1, Math.round(pct)) + '%' : '未读';
      return `
        <div class="card${this.selected.has(b.id) ? ' picked' : ''}" data-id="${esc(b.id)}"${mode === 'wall' ? ` data-rel="${WALL_REL(b)}"` : ''}>
          <div class="card-cover">
            ${jacket(b)}
            ${b.pinned ? `<span class="pin-badge">${ICON.pin}</span>` : ''}
            ${b.newChapters ? `<span class="new-badge">新 +${b.newChapters} 章</span>` : b.isNew ? '<span class="new-badge fresh">新书</span>' : ''}
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
    if (mode === 'wall') layoutWall(grid);
    fitTitles(grid);
    this.updateSelectBar();
  },

  // ---------- moving between folders ----------
  // Going into a folder pushes the new level in from the right while the old one slides a little
  // to the left and fades (the way iOS navigates); going back reverses it; tags and 全部 cross-fade.
  // Uses View Transitions where the browser has them (Safari 18, Chrome), a plain slide otherwise.
  async go(filter) {
    const depth = f => f.startsWith('f:') ? this.path(f.slice(2)).length : 0;
    const dir = depth(filter) > depth(this.filter) ? 'in' : depth(filter) < depth(this.filter) ? 'out' : 'fade';
    const swap = async () => {
      this.filter = filter;
      scrollTo(0, 0); document.getElementById('shelf').scrollTop = 0;
      await this.render();
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return swap();
    const root = document.documentElement;
    if (document.startViewTransition) {
      root.dataset.nav = dir;
      try { await document.startViewTransition(swap).finished; } catch {}
      delete root.dataset.nav;
      return;
    }
    await swap();
    const x = dir === 'in' ? 40 : dir === 'out' ? -40 : 0;
    ['grid', 'chips'].forEach(id => document.getElementById(id).animate(
      [{ transform: `translateX(${x}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 380, easing: 'cubic-bezier(.32,.72,0,1)' }));
  },

  // ---------- gestures on the grid ----------
  bind() {
    const grid = document.getElementById('grid');
    // Touch: press and hold a book or folder → its menu comes up right away (the catalog card, or the
    // folder's menu). Keep holding and move the finger → the menu goes away and the book lifts off
    // to be dropped on a folder (a selected book in select mode carries the whole selection; in
    // select mode the hold shows no menu). Moving before the hold = scrolling.
    let timer = null, hint = null, pressing = null, pressedAt = 0, x0 = 0, y0 = 0, armed = null;
    const unpress = () => { clearTimeout(timer); clearTimeout(hint); pressing?.classList.remove('pressing'); pressing = null; };
    const ghostAt = (g, x, y) => { g.style.transform = `translate(${x - 30}px, ${y - 64}px)`; };
    grid.addEventListener('touchstart', e => {
      const card = e.target.closest('.card');
      if (!card || e.touches.length > 1) return;
      unpress(); armed = null;
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      hint = setTimeout(() => { pressing = card; card.classList.add('pressing'); }, 130);     // the book sinks slightly while you hold
      timer = setTimeout(() => {
        navigator.vibrate?.(8);
        const id = card.dataset.id, fid = card.dataset.fid;
        armed = { card, what: fid ? { folder: fid } : { books: this.selecting && this.selected.has(id) ? [...this.selected] : [id] } };
        pressedAt = Date.now();
        if (!this.selecting) armed.menu = fid ? this.folderMenu(fid) : (this.openMenu(id), 'card');
      }, 440);
    }, { passive: true });
    grid.addEventListener('touchmove', e => {
      const t = e.touches[0];
      if (!armed) { if (Math.hypot(t.clientX - x0, t.clientY - y0) > 8) unpress(); return; }
      e.preventDefault();                                       // held: the finger now drags, never scrolls
      if (!armed.ghost) {
        if (Math.hypot(t.clientX - x0, t.clientY - y0) < 14) return;
        unpress();
        if (armed.menu === 'card') document.querySelector('.bookcard-wrap')?._close?.();   // the menu goes, the drag begins
        else armed.menu?.close?.();
        const g = armed.ghost = document.createElement('div');
        g.className = 'drag-ghost';
        g.innerHTML = armed.what.folder ? `${ICON.folder}<span>${esc(this.folder(armed.what.folder)?.name || '')}</span>`
          : `${ICON.folder}<span>${armed.what.books.length > 1 ? armed.what.books.length + ' 本' : esc(bookName(this.books.find(b => b.id === armed.what.books[0])?.title || ''))}</span>`;
        document.body.appendChild(g);
        armed.card.classList.add('dragging');
      }
      ghostAt(armed.ghost, t.clientX, t.clientY);
      if (t.clientY < 110) scrollBy(0, -16);
      else if (t.clientY > innerHeight - 90) scrollBy(0, 16);
      const el = this._dnd.target(t.clientX, t.clientY);
      this._dnd.mark(el && el !== armed.card ? el : null);
    }, { passive: false });
    const release = e => {
      unpress();
      const a = armed; armed = null;
      if (!a) return;
      pressedAt = Date.now();                                   // swallow the click that follows
      if (!a.ghost) return;                                     // held and let go: the menu is already up
      a.ghost.remove(); a.card.classList.remove('dragging');
      const t = e.changedTouches?.[0], el = t && e.type === 'touchend' ? this._dnd.target(t.clientX, t.clientY) : null;
      this._dnd.mark(null);
      if (el && el !== a.card) this._dnd.drop(el, a.what, t.clientX);
    };
    grid.addEventListener('touchend', release);
    grid.addEventListener('touchcancel', release);
    // A held finger must never start iOS text selection (blue handles) on the shelf or the card
    document.addEventListener('selectstart', e => {
      const el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
      if (el?.closest('#grid, #chips, .bookcard-wrap, .sheet-modal.fixed, #select-bar, #select-top') && !el.closest('input, textarea')) e.preventDefault();
    });
    grid.addEventListener('contextmenu', e => {                 // right-click = long-press on desktop
      const card = e.target.closest('.card');
      if (card && !this.selecting) { e.preventDefault(); card.dataset.fid ? this.folderMenu(card.dataset.fid) : this.openMenu(card.dataset.id); }
    });
    grid.addEventListener('click', e => {
      const card = e.target.closest('.card');
      if (!card) return;
      if (Date.now() - pressedAt < 700) return;                // the click that ends a long-press
      if (Date.now() - (this._dragEnded || 0) < 600) return;   // the click that ends a drag
      if (card.dataset.fid) return this.go('f:' + card.dataset.fid);   // a folder tile: go in (also while selecting)
      if (this.selecting) return this.toggle(card);
      openBook(card.dataset.id);
    });

    // Chips: tap a folder to go into it, the back chip to go up a level; ＋ makes a folder in the
    // current one. Press and hold (or right-click) a folder for its menu: rename, move, delete.
    const chips = document.getElementById('chips');
    let chipTimer = null, chipHeld = 0;
    const holdChip = e => {
      const b = e.target.closest('[data-fid]');
      if (!b) return;
      chipTimer = setTimeout(() => { chipHeld = Date.now(); this.folderMenu(b.dataset.fid); }, 600);
    };
    chips.addEventListener('touchstart', holdChip, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(t => chips.addEventListener(t, () => clearTimeout(chipTimer), { passive: true }));
    chips.addEventListener('contextmenu', e => { const b = e.target.closest('[data-fid]'); if (b) { e.preventDefault(); this.folderMenu(b.dataset.fid); } });
    chips.onclick = async e => {
      if (Date.now() - chipHeld < 700) return;
      if (e.target.closest('[data-newfolder]')) {
        const id = await this.createFolder();
        if (id) { await this.render(); toast(`已新建「${this.folder(id)?.name}」`); chips.querySelector(`[data-fid="${CSS.escape(id)}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); }
        return;
      }
      if (e.target.closest('[data-clearfilter]')) { this.flt = null; return this.render(); }
      if (e.target.closest('[data-openfilter]')) return this.openFilter();
      const b = e.target.closest('[data-filter]');
      if (!b || b.dataset.filter === this.filter) return;
      this.go(b.dataset.filter);
    };
    this.bindDrag(grid, chips);
    // Search: the 🔍 at the top right opens a box over the shelf; typing filters the whole shelf
    const sbar = document.getElementById('search-bar'), sin = document.getElementById('search-input');
    let st = 0;
    document.getElementById('btn-search').onclick = () => { sbar.classList.remove('hidden'); sin.focus(); };
    const hints = { books: '书名、作者、CP、角色、标签', text: '在所有书的正文里搜索', notes: '搜索高亮、批注和书签备注' };
    sin.oninput = () => { clearTimeout(st); st = setTimeout(() => { this.query = sin.value.trim(); this.render(); }, this.searchMode === 'books' ? 120 : 350); };
    sbar.querySelector('.search-modes').onclick = e => {
      const b = e.target.closest('[data-mode]');
      if (!b || b.dataset.mode === this.searchMode) return;
      this.searchMode = b.dataset.mode;
      sbar.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('on', x === b));
      sin.placeholder = hints[this.searchMode];
      this.render(); sin.focus();
    };
    document.getElementById('search-cancel').onclick = () => { sin.value = ''; this.query = ''; sbar.classList.add('hidden'); this.render(); };
    sin.onkeydown = e => { if (e.key === 'Escape') document.getElementById('search-cancel').click(); if (e.key === 'Enter') sin.blur(); };
    document.getElementById('btn-select').onclick = () => this.enterSelect();
    document.getElementById('btn-mode').onclick = e => { e.stopPropagation(); this.openModeMenu(); };
    document.getElementById('btn-sort').onclick = e => { e.stopPropagation(); this.openSortMenu(); };
    document.getElementById('btn-filter').onclick = e => { e.stopPropagation(); this.openFilter(); };
    this.bindSelectBar();
  },

  // ================= Drag to organise =================
  // Mouse: drag a book (or the selected books) onto a folder chip to move them in, or onto the back
  // chip / 全部 to move them up a level or out. Drag a folder chip onto another folder to put it
  // inside, or onto the left part of one to place it just before it. Touch: in select mode, hold a
  // selected book for a moment and drag the selection onto a chip (the shelf scrolls up near the top).
  // The long-press card, tap-to-open and tap-to-select work as before; on touch, folders are
  // reordered and moved from their own menu (long-press a folder).
  bindDrag(grid, chips) {
    const target = (x, y) => document.elementFromPoint(x, y)?.closest('#chips [data-fid], #chips .chip-back, #chips [data-filter="all"], #grid .folder-card') || null;
    let marked = null;
    const mark = el => { if (marked === el) return; marked?.classList.remove('drop-on'); marked = el; el?.classList.add('drop-on'); };
    const drop = async (el, what, x) => {
      const fid = el.dataset.fid || (el.classList.contains('chip-back') ? (el.dataset.up || null) : null);
      if (what.books) { await this.moveBooks(what.books, fid); if (this.selecting) this.exitSelect(); return; }
      if (!what.folder || el.dataset.fid === what.folder) return;
      const r = el.getBoundingClientRect(), t = el.dataset.fid && this.folder(el.dataset.fid);
      if (t && x < r.left + r.width * 0.3 && !el.classList.contains('on')) await this.moveFolder(what.folder, t.parent || null, t.id);
      else if (await this.moveFolder(what.folder, fid)) toast(fid ? `已放进「${this.folder(fid)?.name}」` : '已移到最外层');
    };
    // ---- mouse (HTML drag and drop); draggable is set only for a mouse, so touch long-press is untouched
    document.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse') return;
      const el = e.target.closest?.('#grid .card, #chips [data-fid]');
      if (el) el.draggable = true;
    }, true);
    let drag = null;
    grid.addEventListener('dragstart', e => {
      const card = e.target.closest('.card');
      if (!card) return;
      if (card.dataset.fid) { drag = { folder: card.dataset.fid }; e.dataTransfer.setData('text/plain', ' '); return; }
      const id = card.dataset.id;
      drag = { books: this.selecting && this.selected.has(id) ? [...this.selected] : [id] };
      e.dataTransfer.setData('text/plain', ' '); e.dataTransfer.effectAllowed = 'move';
    });
    chips.addEventListener('dragstart', e => {
      const b = e.target.closest('[data-fid]');
      if (!b) return;
      drag = { folder: b.dataset.fid };
      e.dataTransfer.setData('text/plain', ' '); e.dataTransfer.effectAllowed = 'move';
    });
    document.addEventListener('dragend', () => { drag = null; mark(null); });
    grid.addEventListener('dragover', e => { if (!drag) return; const t = target(e.clientX, e.clientY); mark(t); if (t) e.preventDefault(); });
    grid.addEventListener('drop', e => {
      const t = target(e.clientX, e.clientY), w = drag;
      if (!t) return;
      e.preventDefault(); drag = null; mark(null);
      if (w) drop(t, w, e.clientX);
    });
    chips.addEventListener('dragover', e => { if (!drag) return; const t = target(e.clientX, e.clientY); mark(t); if (t) e.preventDefault(); });
    chips.addEventListener('dragleave', e => { if (!chips.contains(e.relatedTarget)) mark(null); });
    chips.addEventListener('drop', e => {
      e.preventDefault();
      const t = target(e.clientX, e.clientY), w = drag;
      drag = null; mark(null);
      if (t && w) drop(t, w, e.clientX);
    });
    this._dnd = { target, mark, drop };
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
    // A drag that starts from the hold puts the card back without redrawing the shelf: the finger's
    // touch belongs to the book element, which must stay in place for the drag to go on
    root._close = () => close(0, true);
    const close = async (from = 0, quiet = false) => {
      if (root._closing) return;
      root._closing = true;
      cov.style.transform = ''; cov.style.boxShadow = '';
      await Promise.all([
        root.animate([{ backgroundColor: 'rgba(30,20,10,.32)' }, { backgroundColor: 'rgba(30,20,10,0)' }], { duration: 240, fill: 'forwards' }).finished,
        sheet.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(105%) rotate(2deg)' }], { duration: 260, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }).finished,
      ]);
      setTimeout(() => { cov.style.transition = ''; }, 400);
      root.remove();
      if (!quiet) this.render();
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
        // Brackets at either end come off here too; a pairing typed in them becomes the book's pairing
        if (t) await this.update(ids, m => { const c = cleanTitle(t); m.title = c.title; if (c.cp) m.cp = c.cp; m.renamed = true; });
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
      case 'delete': {
        // Deleting puts the book in the trash: nothing is removed until it is deleted there for good
        const ok = await confirmDialog({
          title: ids.length > 1 ? `删除 ${ids.length} 本书？` : `删除《${bookName(one.title)}》？`,
          message: '会移到回收站，30 天内可以在「更多 → 回收站」恢复，阅读进度、书签、笔记和评分都会保留。', ok: '删除', danger: true });
        if (!ok) return false;
        const at = Date.now();
        await this.update(ids, m => { m.trashedAt = at; });
        toast(ids.length > 1 ? `已移到回收站（${ids.length} 本）` : '已移到回收站');
        break;
      }
    }
    return true;
  },

  // ---------- the filter panel (筛选) ----------
  // A sheet made for the phone: 我的筛选 on top, then each kind of condition as chips (values that
  // exist on the shelf, most used first, with counts). The button at the bottom shows how many books
  // the current choice leaves; it applies the filter. 存为我的筛选 keeps the combination.
  flt: null,
  _savedFilters: [],
  openFilter() {
    let f = JSON.parse(JSON.stringify(this.flt || {}));
    const books = this.books;
    const tally = k => {
      const m = new Map();
      for (const b of books) for (const v of bookValues(b, k)) m.set(v, (m.get(v) || 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'));
    };
    const groups = [
      ['read', '阅读状态', [['unread', '未读'], ['reading', '在读'], ['done', '读完']]],
      ['end', '完结 / 连载', [['完结', '完结'], ['连载', '连载']]],
      ['len', '篇幅', [['短篇', '短篇'], ['中篇', '中篇'], ['长篇', '长篇']]],
      ['cat', '作品分类', tally('cat')], ['cp', 'CP', tally('cp')], ['ch', '角色', tally('ch')], ['tag', '我的标签', tally('tag')],
    ];
    const s = quickSheet(`<div class="pk-title">筛选<small class="fl-n"></small></div><div class="sheet-scroll fl-body"></div>
      <div class="fl-foot"><button class="fl-clear">清除</button><button class="fl-save">存为我的筛选</button><button class="fl-go"></button></div>`, 'fl-sheet');
    const body = s.card.querySelector('.fl-body');
    const count = () => { const under = f.folder ? this.under(f.folder) : null; return books.filter(b => passFilter(b, f, under)).length; };
    const chip = (k, v, label, n) => `<button class="fl-chip${(f[k] || []).includes(v) ? ' on' : ''}" data-k="${k}" data-v="${esc(v)}">${esc(label)}${n !== undefined ? `<small>${n}</small>` : ''}</button>`;
    const draw = () => {
      const open = new Set([...body.querySelectorAll('.fl-more.open')].map(x => x.dataset.k));
      body.innerHTML = (this._savedFilters.length ? `<div class="fl-sec"><div class="fl-h">我的筛选</div><div class="fl-chips">${this._savedFilters.map(x =>
          `<span class="fl-saved${JSON.stringify(x.f) === JSON.stringify(f) ? ' on' : ''}" data-sid="${esc(x.id)}"><button data-use="${esc(x.id)}">${esc(x.name)}</button><button class="fl-x" data-drop="${esc(x.id)}" aria-label="删除">×</button></span>`).join('')}</div></div>` : '')
        + groups.map(([k, title, vals]) => {
            if (!vals.length) return '';
            const many = vals.length > 12 && !open.has(k);
            const shown = many ? vals.slice(0, 12).concat(vals.slice(12).filter(([v]) => (f[k] || []).includes(v))) : vals;
            return `<div class="fl-sec"><div class="fl-h">${title}</div><div class="fl-chips">${shown.map(([v, n]) => typeof n === 'number' ? chip(k, v, v, n) : chip(k, v, n)).join('')}
              ${many ? `<button class="fl-more" data-k="${k}">更多 ${vals.length - 12} 个</button>` : open.has(k) ? `<button class="fl-more open" data-k="${k}" hidden></button>` : ''}</div></div>`;
          }).join('')
        + `<div class="fl-sec"><div class="fl-h">评分</div><div class="fl-chips">${[['', '不限'], ['3', '3 星以上'], ['4', '4 星以上'], ['5', '5 星'], ['none', '未评分']].map(([v, l]) =>
            `<button class="fl-chip${String(f.rate || '') === v ? ' on' : ''}" data-rate="${v}">${l}</button>`).join('')}</div></div>`
        + `<div class="fl-sec"><div class="fl-h">文件夹<small>（含里面的文件夹）</small></div><div class="fl-chips">${[`<button class="fl-chip${f.folder ? '' : ' on'}" data-folder="">不限</button>`,
            ...this.treeRows().map(({ f: x, depth }) => `<button class="fl-chip${f.folder === x.id ? ' on' : ''}" data-folder="${esc(x.id)}">${'· '.repeat(depth)}${esc(x.name)}</button>`)].join('')}</div></div>`;
      const n = count(), k = filterCount(f);
      s.card.querySelector('.fl-n').textContent = k ? `${k} 项条件` : '';
      s.card.querySelector('.fl-go').textContent = k ? `显示 ${n} 本` : '显示全部';
      s.card.querySelector('.fl-save').disabled = !k;
    };
    draw();
    s.card.onclick = async e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.classList.contains('fl-chip') && t.dataset.k) {
        const arr = f[t.dataset.k] = f[t.dataset.k] || [];
        const i = arr.indexOf(t.dataset.v);
        i >= 0 ? arr.splice(i, 1) : arr.push(t.dataset.v);
        if (!arr.length) delete f[t.dataset.k];
      } else if (t.dataset.rate !== undefined) { if (t.dataset.rate) f.rate = t.dataset.rate === 'none' ? 'none' : +t.dataset.rate; else delete f.rate; }
      else if (t.dataset.folder !== undefined) { if (t.dataset.folder) f.folder = t.dataset.folder; else delete f.folder; }
      else if (t.classList.contains('fl-more')) { t.classList.add('open'); body.querySelectorAll(`.fl-more[data-k="${t.dataset.k}"]`).forEach(x => x.classList.add('open')); }
      else if (t.dataset.use) f = JSON.parse(JSON.stringify(this._savedFilters.find(x => x.id === t.dataset.use).f));
      else if (t.dataset.drop) {
        const x = this._savedFilters.find(y => y.id === t.dataset.drop);
        if (!(await confirmDialog({ title: `删除我的筛选「${x.name}」？`, message: '只是删掉这个保存的组合，书不受影响。', ok: '删除', danger: true }))) return;
        this._savedFilters = this._savedFilters.filter(y => y !== x);
        await DB.setPref('savedFilters', this._savedFilters);
      }
      else if (t.classList.contains('fl-clear')) f = {};
      else if (t.classList.contains('fl-save')) {
        const name = (await promptDialog({ title: '存为我的筛选', placeholder: '比如：没读完的长篇', ok: '保存', max: 20 }))?.trim();
        if (!name) return;
        this._savedFilters = [...this._savedFilters.filter(y => y.name !== name), { id: 's' + Date.now().toString(36), name, f: JSON.parse(JSON.stringify(f)) }];
        await DB.setPref('savedFilters', this._savedFilters);
        toast(`已保存「${name}」`);
      }
      else if (t.classList.contains('fl-go')) {
        this.flt = filterCount(f) ? f : null;
        await s.close();
        scrollTo(0, 0);
        return this.render();
      }
      draw();
    };
  },

  // ---------- searching text across the shelf (搜索 → 正文 / 摘录) ----------
  // 正文: every book's chapters, most recently read first; results appear as they are found and
  // a newer query stops the old one. 摘录: highlights, their notes and bookmark notes.
  // Tap a result: the book opens on that spot and the words light up.
  searchMode: 'books',
  async renderFind(grid) {
    const q = this.query, token = this._findToken = (this._findToken || 0) + 1;
    const count = document.getElementById('shelf-count');
    const item = (b, ch, off, len, text, extra = '') => `<a href="#" class="fr" data-id="${esc(b.id)}" data-ch="${ch}" data-off="${off}" data-len="${len}"${extra}>
      <div class="fr-top"><span>${esc(bookName(b.title))}</span><small>${esc(b.chTitles?.[ch] || `第 ${ch + 1} 章`)}</small></div><div class="fr-text">${text}</div></a>`;
    grid.innerHTML = '<div class="find-list"></div>';
    const box = grid.firstElementChild;
    grid.onclick = null;
    box.onclick = async e => {
      const a = e.target.closest('.fr');
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      await openBook(a.dataset.id);
      Reader.goTo(+a.dataset.ch, +a.dataset.off, a.dataset.mark || undefined);
      if (!a.dataset.mark) Reader.flashFind(+a.dataset.off, +a.dataset.len);
    };
    const byId = new Map(this.books.map(b => [b.id, b]));
    if (this.searchMode === 'notes') {
      const k = normText(q);
      const notes = (await DB.allNotes()).filter(n => byId.has(n.bookId) && normText(`${n.text || ''}\n${n.note || ''}`).includes(k))
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
      if (token !== this._findToken) return;
      count.innerHTML = `<span>找到 ${notes.length} 条摘录</span>`;
      box.innerHTML = notes.length ? notes.slice(0, 300).map(n => {
        const b = byId.get(n.bookId), t = n.text || '', i = normText(t).indexOf(k);
        const quote = i >= 0 ? findSnippet(t, i, q.length, 30, 60) : esc(t.slice(0, 80));
        const note = n.note ? `<div class="fr-note">${normText(n.note).includes(k) ? findSnippet(n.note, normText(n.note).indexOf(k), q.length, 30, 60) : esc(n.note)}</div>` : '';
        return item(b, n.ch, n.start || 0, 0, `<span class="fr-kind">${n.type === 'bookmark' ? '书签' : '高亮'}</span>${quote}${note}`, ` data-mark="${esc(n.type === 'mark' ? n.id : '')}"`);
      }).join('') : `<div class="empty small"><p class="empty-sub">没有找到「${esc(q)}」</p></div>`;
      return;
    }
    // 正文
    const books = [...this.books].sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
    let hits = 0, done = 0;
    const MAX = 300, PER_BOOK = 20;
    count.innerHTML = `<span>正在搜索…</span>`;
    for (const b of books) {
      if (token !== this._findToken) return;
      const c = await DB.getContent(b.id);
      if (token !== this._findToken) return;
      done++;
      let html = '', n = 0;
      for (let ch = 0; c && ch < c.chapters.length && n < PER_BOOK; ch++) {
        const t = chapterPlain(c.chapters[ch].html);
        for (const off of findAll(t, q, PER_BOOK - n)) {
          b.chTitles = b.chTitles || c.chapters.map(x => x.title);
          html += item(b, ch, off, q.length, findSnippet(t, off, q.length)); n++;
        }
      }
      if (html) { box.insertAdjacentHTML('beforeend', html); hits += n; }
      if (done % 10 === 0 || done === books.length) {
        count.innerHTML = `<span>${done < books.length ? `正在搜索 ${done} / ${books.length} 本 · ` : ''}找到 ${hits}${hits >= MAX ? '+' : ''} 处</span>`;
        await new Promise(r => setTimeout(r));                   // let the page breathe between books
      }
      if (hits >= MAX) break;
    }
    if (token !== this._findToken) return;
    count.innerHTML = `<span>找到 ${hits}${hits >= MAX ? '+' : ''} 处${hits >= MAX ? '（只列前面的）' : ''}</span>`;
    if (!hits) box.innerHTML = `<div class="empty small"><p class="empty-sub">没有找到「${esc(q)}」</p></div>`;
  },

  // ---------- tag management (更多 → 标签管理) ----------
  // Your own tags with how many books carry each: new, rename, merge into another, delete (only
  // takes the tag off the books). System tags are worked out from the books and only listed.
  async saveExtraTags(list) { this._extraTags = [...new Set(list)]; await DB.setPref('extraTags', this._extraTags); },
  async retag(from, to) {                              // to = null: delete; an existing tag: merge
    const ids = this.books.filter(b => (b.userTags || []).includes(from)).map(b => b.id);
    await this.update(ids, m => {
      const set = new Set((m.userTags || []).filter(t => t !== from));
      if (to) set.add(to);
      m.userTags = [...set];
    }, false);
    await this.saveExtraTags(this._extraTags.filter(t => t !== from).concat(to && !this._extraTags.includes(to) && !ids.length ? [to] : []));
    if (this.filter === 't:' + from) this.filter = to ? 't:' + to : 'all';
    await this.render();
    return ids.length;
  },
  openTags() {
    const count = t => this.books.filter(b => (b.userTags || []).includes(t)).length;
    const sys = new Map();
    for (const b of this.books) for (const t of systemTags(b)) sys.set(t, (sys.get(t) || 0) + 1);
    const order = ['短篇', '中篇', '长篇', '完结', '连载', '重读'];
    const tags = this.tags();
    const s = quickSheet(`
      <div class="pk-title">标签管理<small>${tags.length} 个标签</small></div>
      <div class="pk-foot"><button class="pk-row add" data-a="new">＋ 新建标签</button></div>
      <div class="pk-list sheet-scroll tm-list">
        ${tags.map(t => `<div class="tm-row" data-t="${esc(t)}"><span class="tm-name">#${esc(t)}</span><small>${count(t)} 本</small>
          <button data-a="rename">改名</button><button data-a="merge">合并</button><button data-a="del" class="tm-del">删除</button></div>`).join('')
          || '<div class="pk-empty">还没有自己的标签。在书上长按 → 标签，或在这里新建。</div>'}
        <div class="pk-sub">系统标签（自动生成，只读）</div>
        <div class="tag-cloud tm-sys">${order.filter(t => sys.has(t)).map(t => `<span class="tag-chip sys">${t}<small>${sys.get(t)}</small></span>`).join('') || '<span class="pk-empty">暂无</span>'}</div>
      </div>`, 'pk-folders tm-sheet');
    s.card.onclick = async e => {
      const btn = e.target.closest('[data-a]');
      if (!btn) return;
      const a = btn.dataset.a, t = btn.closest('[data-t]')?.dataset.t;
      if (a === 'new') {
        const n = (await promptDialog({ title: '新建标签', placeholder: '比如：甜文、待重读', ok: '创建', max: 30 }))?.trim().replace(/^#/, '');
        if (!n) return;
        if (!this.tags().includes(n)) await this.saveExtraTags([...this._extraTags, n]);
        await s.close(); this.openTags(); return;
      }
      if (a === 'rename') {
        const n = (await promptDialog({ title: `给「${t}」改名`, value: t, placeholder: '新名字', ok: '改名', max: 30 }))?.trim().replace(/^#/, '');
        if (!n || n === t) return;
        if (this.tags().includes(n) && !(await confirmDialog({ title: `已经有「${n}」了`, message: `把「${t}」合并进「${n}」？两个标签的书都会变成「${n}」。`, ok: '合并' }))) return;
        await this.retag(t, n);
        toast(`已改名为「${n}」`);
      } else if (a === 'merge') {
        const others = this.tags().filter(x => x !== t);
        if (!others.length) return toast('没有别的标签可以合并');
        const p = quickSheet(`<div class="pk-title">把「${esc(t)}」合并进<small>${count(t)} 本书会改用所选标签</small></div>
          <div class="pk-list sheet-scroll">${others.map(x => `<button class="pk-row" data-to="${esc(x)}">#${esc(x)}<small>${count(x)} 本</small></button>`).join('')}</div>`, 'pk-folders');
        const to = await new Promise(res => { p.card.onclick = ev => { const r = ev.target.closest('[data-to]'); if (r) { p.close(); res(r.dataset.to); } }; p.onclose = () => res(null); });
        if (!to) return;
        await this.retag(t, to);
        toast(`已合并进「${to}」`);
      } else if (a === 'del') {
        const n = count(t);
        if (!(await confirmDialog({ title: `删除标签「${t}」？`, message: n ? `只会从 ${n} 本书上去掉这个标签，书不受影响。` : '没有书用这个标签。', ok: '删除', danger: true }))) return;
        await this.retag(t, null);
        toast('已删除标签');
      }
      await s.close(); this.openTags();
    };
  },

  // ---------- trash (更多 → 回收站) ----------
  // A deleted book only carries trashedAt; restore takes it off. Delete for good (one, or 全部清空)
  // really removes the book, its text and its notes, and the next sync removes it on the other
  // device too. After 30 days a book in the trash is deleted for good (purgeTrash, at start).
  TRASH_DAYS: 30,
  async purgeTrash() {
    const limit = Date.now() - this.TRASH_DAYS * 864e5;
    for (const m of await DB.allMeta()) if (m.trashedAt && m.trashedAt < limit) await DB.remove(m.id);
  },
  async openTrash() {
    const list = (await DB.allMeta()).filter(m => m.trashedAt).sort((a, b) => b.trashedAt - a.trashedAt);
    const left = m => Math.max(1, Math.ceil((m.trashedAt + this.TRASH_DAYS * 864e5 - Date.now()) / 864e5));
    const s = quickSheet(`
      <div class="pk-title">回收站<small>${list.length ? `${list.length} 本 · ${this.TRASH_DAYS} 天后自动彻底删除` : '空的'}</small></div>
      <div class="pk-list sheet-scroll tr-list">
        ${list.map(m => `<div class="tr-row" data-id="${esc(m.id)}">${jacket(m, 'tr-j')}
          <div class="tr-info"><div class="tr-t">${esc(bookName(m.title))}</div><small>${new Date(m.trashedAt).toLocaleDateString('zh-CN')} 删除 · ${left(m)} 天后彻底删除</small></div>
          <button data-a="restore">恢复</button><button data-a="purge" class="tm-del">彻底删除</button></div>`).join('')
          || '<div class="pk-empty">删除的书会先放在这里，30 天内都能恢复。</div>'}
      </div>
      ${list.length ? '<div class="pk-foot"><button class="pk-row muted" data-a="empty">清空回收站</button></div>' : ''}`, 'pk-folders tr-sheet');
    s.card.onclick = async e => {
      const btn = e.target.closest('[data-a]');
      if (!btn) return;
      const a = btn.dataset.a, id = btn.closest('[data-id]')?.dataset.id, m = list.find(x => x.id === id);
      if (a === 'restore') {
        await this.update([id], x => { delete x.trashedAt; });
        toast(`已恢复《${bookName(m.title)}》`);
      } else if (a === 'purge') {
        if (!(await confirmDialog({ title: `彻底删除《${bookName(m.title)}》？`, message: '书、阅读进度、书签、笔记和评分都会被删除，另一台设备同步后也会删除，无法恢复。', ok: '彻底删除', danger: true }))) return;
        await DB.remove(id);
        toast('已彻底删除');
      } else if (a === 'empty') {
        if (!(await confirmDialog({ title: `清空回收站？`, message: `${list.length} 本书会被彻底删除，另一台设备同步后也会删除，无法恢复。`, ok: '清空', danger: true }))) return;
        for (const x of list) await DB.remove(x.id);
        toast('回收站已清空');
      }
      await s.close();
      await this.render();
      if (a !== 'empty') this.openTrash();
    };
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

  // Move books to any folder at any level (indented tree); ＋ makes a new folder in the one being browsed
  async pickFolder(ids) {
    const metas = await Promise.all(ids.map(id => DB.getMeta(id)));
    const cur = metas.every(m => m.folderId === metas[0].folderId) ? metas[0].folderId : undefined;
    const rows = this.treeRows().map(({ f, depth }) => `<button class="pk-row${cur === f.id ? ' on' : ''}" data-f="${esc(f.id)}" style="padding-left:${1 + depth * 1.1}em">${ICON.folder}<span>${esc(f.name)}</span><small>${this.countIn(f.id)}</small></button>`).join('');
    // "New folder" is the first row, so it can never end up below the fold or behind the toolbar
    const s = quickSheet(`
      <div class="pk-title">移动到文件夹<small>已选 ${ids.length} 本</small></div>
      <div class="pk-foot"><button class="pk-row add" data-new="1">＋ 新建文件夹</button></div>
      <div class="pk-list sheet-scroll">
        ${rows || '<div class="pk-empty">还没有文件夹，先新建一个</div>'}
        ${metas.some(m => m.folderId) ? `<button class="pk-row muted" data-f="">移出文件夹</button>` : ''}
      </div>`, 'pk-folders');
    s.card.onclick = async e => {
      const row = e.target.closest('.pk-row');
      if (!row) return;
      let f = row.dataset.f;
      if (row.dataset.new) {                       // the sheet stays open under the name dialog; cancel returns to it
        f = await this.createFolder();
        if (!f) return;
      }
      await s.close();
      await this.moveBooks(ids, f || null);        // a folder left empty stays (folders are their own records)
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
    const sb = document.getElementById('btn-sort'), { def, rev } = shelfSort();
    const arrow = (def.desc ? !rev : rev) ? '↓' : '↑';
    sb.innerHTML = `${ICON_SORT}<span>${def.name}</span><b>${arrow}</b>`;
    sb.setAttribute('aria-label', `排序：${def.name}`);
    sb.classList.toggle('hidden', !this.books.length);
    const fb = document.getElementById('btn-filter'), fn = filterCount(this.flt);
    fb.classList.toggle('hidden', !this.books.length);
    fb.classList.toggle('on', !!fn);
    fb.querySelector('.filter-n').textContent = fn || '';
  },
  openSortMenu() {
    const cur = shelfSort();
    this.popMenu(document.getElementById('btn-sort'), SORTS.map(s => {
      const on = s === cur.def, down = s.desc ? !(on && cur.rev) : on && cur.rev;
      return `<button data-sort="${s.key}" class="${on ? 'on' : ''}"><span>${s.name}</span>${on ? `<b>${down ? '↓' : '↑'}</b>` : ''}</button>`;
    }).join('') + '<p class="menu-note">置顶的书始终在最前 · 再点一次当前排序可反向</p>', b => {
      const key = b.dataset.sort; if (!key) return;
      const rev = key === cur.def.key ? !cur.rev : false;
      try { localStorage.setItem(SORT_KEY, JSON.stringify({ key, rev })); } catch {}
      this.render();
    });
  },
  // A small menu under a header button; `pick` gets the tapped item
  popMenu(btn, html, pick) {
    document.querySelector('.mode-menu')?.remove();
    const r = btn.getBoundingClientRect(), menu = document.createElement('div');
    menu.className = 'mode-menu';
    menu.innerHTML = html;
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
    document.body.appendChild(menu);
    menu.animate([{ opacity: 0, transform: 'translateY(-4px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    const close = () => { menu.remove(); removeEventListener('pointerdown', outside, true); };
    const outside = e => { if (!menu.contains(e.target) && !btn.contains(e.target)) close(); };
    setTimeout(() => addEventListener('pointerdown', outside, true));
    menu.onclick = e => { const b = e.target.closest('button'); if (!b) return; close(); pick(b); };
  },
  openModeMenu() {
    const cur = shelfMode();
    const grp = shelfGroup();
    this.popMenu(document.getElementById('btn-mode'), SHELF_MODES.map(m => `<button data-mode="${m.key}" class="${m.key === cur ? 'on' : ''}">${m.icon}<span>${m.name}</span></button>`).join('')
      + `<div class="mm-sep"></div>`
      + [['all', '全部书', SHELF_MODES[0].icon], ['folders', '按文件夹', ICON.folder]].map(([k, n, ic]) => `<button data-group="${k}" class="${k === grp ? 'on' : ''}">${ic}<span>${n}</span></button>`).join(''), b => {
      if (b.dataset.group) {
        if (b.dataset.group === grp) return;
        try { localStorage.setItem(GROUP_KEY, b.dataset.group); } catch {}
        this.filter = 'all';
      } else {
        if (b.dataset.mode === cur) return;
        try { localStorage.setItem(MODE_KEY, b.dataset.mode); } catch {}
      }
      document.getElementById('shelf').scrollTop = 0; scrollTo(0, 0);
      this.render();
    });
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
      if (act === 'pin' && done !== false) this.exitSelect();
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
