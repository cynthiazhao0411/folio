// ui.js — Motion helpers: bottom sheets and the book open/close transition.
// Everything animates transform/opacity only, via the Web Animations API.

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE_SHEET = 'cubic-bezier(.32,.72,0,1)';     // iOS-style sheet curve
const EASE_BOOK = 'cubic-bezier(.45,.05,.2,1)';

function anim(el, frames, opts) {
  if (reduceMotion) opts = { ...opts, duration: 1, delay: 0 };
  return el.animate(frames, { fill: 'forwards', ...opts }).finished;
}

// ================= Book titles =================
// One rule for every book title. A title like "【亚内】Some Work" carries the pairing in its first
// full-width bracket pair: the pairing is shown on the cover page only, every other place shows the
// cleaned name. The stored title is never changed, so the raw text (and the pairing) always stays in
// the data. No brackets, empty brackets, or a title that is only a bracket: nothing is extracted and
// the title is returned as it is. Further bracket pairs are not touched, so nothing is lost silently.
function parseBookTitle(raw) {
  const s = String(raw ?? '');
  const m = s.match(/【([^【】]*)】/);
  const cp = m ? m[1].trim() : '';
  if (!m || !cp) return { name: s, cp: '', raw: s };
  const end = m.index + m[0].length;
  const sep = /\s/.test(s[m.index - 1] || '') || /\s/.test(s[end] || '') ? ' ' : '';
  const name = (s.slice(0, m.index).trimEnd() + sep + s.slice(end).trimStart()).trim();
  return name ? { name, cp, raw: s } : { name: s, cp: '', raw: s };
}
// Titles keep no brackets at either end: every 【…】 [...] (...) {...} （…） ［…］ ｛…｝ 〔…〕 〖…〗 in front of or
// after the name goes, together with what is inside, e.g. "【完结】曼哈顿娇妻(凯孙)" → "曼哈顿娇妻". What was
// taken off is returned: `tags` (all of it) and `cp`, the pairing (the first part that is not a status
// such as 完结 or 连载). A title that is nothing but brackets is left as it is.
const TITLE_STATUS = /^(已?完结|完本|全文完|连载中?|更新中?|已更|番外|正文完|HE|BE|OE|短篇|中篇|长篇|完|新|[上中下全]|[0-9一二三四五六七八九十]+)$/i;
function cleanTitle(raw) {
  const s0 = String(raw ?? '').trim(), tags = [];
  const O = '【\\[(（{［｛〔〖', C = '】\\])）}］｝〕〗';
  const head = new RegExp(`^[${O}]([^${O}${C}]*)[${C}]\\s*`), tail = new RegExp(`\\s*[${O}]([^${O}${C}]*)[${C}]$`);
  let s = s0, m;
  for (let k = 0; k < 8; k++) {
    if ((m = s.match(head)) && m[0].length < s.length) { tags.push(m[1].trim()); s = s.slice(m[0].length).trim(); continue; }
    if ((m = s.match(tail)) && m.index > 0) { tags.push(m[1].trim()); s = s.slice(0, m.index).trim(); continue; }
    break;
  }
  if (!s) return { title: s0, tags: [], cp: '' };
  const named = tags.filter(Boolean);
  return { title: s, tags: named, cp: named.find(t => !TITLE_STATUS.test(t)) || '' };
}
// Applies cleanTitle to a book record (the import and the one-time pass over the shelf use it):
// the name only in `title`; what came off in `titleTags`, the pairing in `cp` (kept if already set)
function cleanBookTitle(m) {
  const c = cleanTitle(m.title);
  if (c.title === m.title) return false;
  m.title = c.title;
  if (c.cp && !m.cp) m.cp = c.cp;
  m.titleTags = [...new Set([...(m.titleTags || []), ...c.tags])];
  return true;
}
const bookName = raw => parseBookTitle(raw).name;
const bookCP = raw => parseBookTitle(raw).cp;

// ================= Bottom sheets =================
// Markup: <div class="sheet-modal hidden"><div class="sheet-card">…</div></div>
// Tap the backdrop or drag the card down to dismiss.
const Sheet = {
  open(modal) {
    const card = modal.querySelector('.sheet-card');
    modal.classList.remove('hidden');
    modal.getAnimations().forEach(a => a.cancel());
    card.getAnimations().forEach(a => a.cancel());
    anim(modal, [{ backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: 'rgba(0,0,0,.32)' }], { duration: 300 });
    anim(card, [{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 420, easing: EASE_SHEET });
    if (!modal._bound) this.bind(modal, card);
  },

  async close(modal, from = 0) {
    if (modal.classList.contains('hidden') || modal._closing) return;
    modal._closing = true;
    const card = modal.querySelector('.sheet-card');
    await Promise.all([
      anim(modal, [{ backgroundColor: 'rgba(0,0,0,.32)' }, { backgroundColor: 'rgba(0,0,0,0)' }], { duration: 260 }),
      anim(card, [{ transform: `translateY(${from}px)` }, { transform: 'translateY(100%)' }], { duration: 280, easing: 'cubic-bezier(.4,0,1,1)' }),
    ]);
    modal.classList.add('hidden');
    modal._closing = false;
  },

  bind(modal, card) {
    modal._bound = true;
    modal.addEventListener('click', e => { if (e.target === modal) this.close(modal); });
    // Drag down from the grip/header area (or anywhere when the list is scrolled to the top)
    let y0 = null, dy = 0, scroller = null;
    card.addEventListener('touchstart', e => {
      scroller = card.querySelector('.sheet-scroll');
      const onHead = !scroller || !scroller.contains(e.target) || scroller.scrollTop <= 0;
      y0 = onHead ? e.touches[0].clientY : null; dy = 0;
    }, { passive: true });
    card.addEventListener('touchmove', e => {
      if (y0 === null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      if (dy > 0) {
        if (e.cancelable) e.preventDefault();
        card.getAnimations().forEach(a => a.cancel());
        card.style.transform = `translateY(${dy}px)`;
      }
    }, { passive: false });
    card.addEventListener('touchend', () => {
      if (y0 === null || !dy) return;
      y0 = null;
      const from = dy;
      card.style.transform = '';
      if (from > 90) this.close(modal, from);
      else anim(card, [{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], { duration: 300, easing: EASE_SHEET });
    });
  },
};

// ================= Book open / close =================
// A copy of the cover flies from its place on the shelf to the screen while a blank
// "page" grows behind it; the cover then swings open around its spine and the reader fades in.
const BookAnim = {
  layer(cover) {
    const r = cover.getBoundingClientRect();
    const W = innerWidth, H = innerHeight;
    const layer = document.createElement('div');
    layer.className = 'book-anim';
    const paper = document.createElement('div');
    paper.className = 'ba-paper';
    Object.assign(paper.style, { width: W + 'px', height: H + 'px' });
    const front = cover.cloneNode(true);
    front.classList.add('ba-cover');
    Object.assign(front.style, { width: r.width + 'px', height: r.height + 'px' });
    const shade = document.createElement('div');
    shade.className = 'ba-shade';
    front.appendChild(shade);
    layer.append(paper, front);
    document.body.appendChild(layer);

    const s = W / r.width;                         // cover ends as wide as the screen
    const endY = (H - r.height * s) / 2;
    return {
      layer, paper, front, shade,
      paperSmall: `translate(${r.left}px,${r.top}px) scale(${r.width / W},${r.height / H})`,
      coverSmall: `translate(${r.left}px,${r.top}px) scale(1) rotateY(0deg)`,
      coverMid: `translate(${r.left * .45}px,${r.top + (endY - r.top) * .55}px) scale(${1 + (s - 1) * .55}) rotateY(-18deg)`,
      coverOpen: `translate(0px,${endY}px) scale(${s}) rotateY(-105deg)`,
      radius: getComputedStyle(cover).borderRadius,
    };
  },

  async open(cover, reader) {
    const L = this.layer(cover);
    cover.style.visibility = 'hidden';
    reader.style.opacity = '0';
    const D = 680;
    await Promise.all([
      anim(L.paper, [{ transform: L.paperSmall, borderRadius: '10px' }, { transform: 'none', borderRadius: '0px' }],
        { duration: D * .8, easing: EASE_BOOK }),
      anim(L.front, [{ transform: L.coverSmall }, { transform: L.coverMid, offset: .45 }, { transform: L.coverOpen }],
        { duration: D, easing: EASE_BOOK }),
      anim(L.shade, [{ opacity: 0 }, { opacity: .45 }], { duration: D, easing: 'ease-in' }),
      anim(reader, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: D * .7 }),
    ]);
    reader.getAnimations().forEach(a => a.cancel());
    reader.style.opacity = '';
    L.layer.remove();
    cover.style.visibility = '';
  },

  async close(cover, reader) {
    const L = this.layer(cover);
    cover.style.visibility = 'hidden';
    L.front.style.transform = L.coverOpen;
    // Keep the animation layer *under* the reader, so the page text fades straight into
    // the blank paper beneath it (same color, no flash). The cover is edge-on at first,
    // so it only becomes visible once the text has mostly faded.
    L.layer.style.zIndex = '40';
    const D = 640;
    await Promise.all([
      anim(reader, [{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: 'ease-out' }),
      anim(L.paper, [{ transform: 'none', borderRadius: '0px' }, { transform: L.paperSmall, borderRadius: '10px' }],
        { duration: D * .85, delay: D * .15, easing: EASE_BOOK }),
      anim(L.front, [{ transform: L.coverOpen }, { transform: L.coverMid, offset: .55 }, { transform: L.coverSmall }],
        { duration: D, easing: EASE_BOOK }),
      anim(L.shade, [{ opacity: .45 }, { opacity: 0 }], { duration: D, easing: 'ease-out' }),
    ]);
    L.layer.remove();
    cover.style.visibility = '';
  },

  // Fallback when there is no cover to fly from (e.g. right after importing)
  fadeIn(el) { el.style.opacity = '0'; return anim(el, [{ opacity: 0, transform: 'scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' }).then(() => { el.getAnimations().forEach(a => a.cancel()); el.style.opacity = ''; }); },
  fadeOut(el) { return anim(el, [{ opacity: 1 }, { opacity: 0 }], { duration: 200 }).then(() => { el.getAnimations().forEach(a => a.cancel()); }); },
};

// ================= Title fitting =================
// Nothing on a cover is ever cut off. Latin titles shrink a little to stay on one line, then
// wrap between words (and shrink further only if a single word is still too wide). Chinese
// titles keep their size and simply continue on the next lines, wrapping between words.
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;
function fitTitle(el) {
  el.style.fontSize = '';
  el.classList.remove('fit-wrap');
  el.classList.add('fit-line');
  if (!el.clientWidth) return;                       // not laid out yet (hidden): fitted again when shown
  const base = parseFloat(getComputedStyle(el).fontSize);
  const text = el.textContent.replace(/\u200b/g, '');
  const cjk = (text.match(CJK_RE) || []).length / Math.max(1, text.length) > .4;
  const floor = cjk ? .88 : .72;                     // how far one line may shrink before wrapping
  const ratio = el.clientWidth / el.scrollWidth;
  if (ratio >= 1) return;
  if (ratio >= floor) { el.style.fontSize = Math.floor(base * ratio * 10) / 10 + 'px'; return; }
  el.classList.remove('fit-line');
  el.classList.add('fit-wrap');                      // wraps between words
  let size = base * (cjk ? .92 : .84);
  el.style.fontSize = size + 'px';
  const cut = () => el.scrollWidth > el.clientWidth + .5 || el.scrollHeight > el.clientHeight + .5;
  for (let i = 0; i < 10 && size > base * .5 && cut(); i++) { size *= .94; el.style.fontSize = size + 'px'; }
}
function fitTitles(root) { root.querySelectorAll('.c-title, .tp-title').forEach(el => fitTitle(el)); }
