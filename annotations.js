// annotations.js — Bookmarks, highlights and notes.
//
// Positions are character offsets into a chapter's plain text (the text of .ch-body),
// so they survive font-size changes and re-layouts. Each record also keeps the quoted
// text, which is used to re-locate it if the book is re-imported with small edits.
//
// Record shape:
//   { id, bookId, type: 'mark' | 'bookmark', ch, start, end, text,
//     color: 'yellow'|'green'|'blue'|'pink', note, createdAt }
// A note is always attached to a highlight, so every annotation looks the same on the page.

const COLORS = ['yellow', 'green', 'blue', 'pink'];
const PUNCT = /[\s，。！？；：、“”‘’「」『』（）()《》【】…—,.!?;:"'[\]]/;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

Object.assign(Reader, {
  annots: [],            // every record for the open book
  store: null,           // { put(rec), del(id) } — provided by app.js
  sel: null,             // active selection: { v, start, end, anchor, rec? }
  selecting: false,      // finger is down and extending a selection

  setAnnots(list) { this.annots = list || []; },

  // ================= Text index =================
  // Flattens the chapter body into one string plus a sorted list of text nodes,
  // so we can convert between (node, offset) and a chapter-wide character offset.
  buildIndex(body) {
    const nodes = [], walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let text = '', n;
    while ((n = walker.nextNode())) { nodes.push({ node: n, start: text.length }); text += n.data; }
    return { nodes, text };
  },

  locate(idx, off) {                       // binary search: chapter offset -> { node, offset }
    let lo = 0, hi = idx.nodes.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (idx.nodes[mid].start <= off) lo = mid; else hi = mid - 1;
    }
    const e = idx.nodes[lo];
    return { node: e.node, offset: Math.max(0, Math.min(off - e.start, e.node.data.length)) };
  },

  rangeOf(v, start, end) {
    const a = this.locate(v.idx, start), b = this.locate(v.idx, end);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  },

  charRect(v, off) {
    const a = this.locate(v.idx, off);
    if (!a || a.offset >= a.node.data.length) return null;
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(a.node, a.offset + 1);
    const rect = r.getClientRects()[0];
    return rect && (rect.width || rect.height) ? rect : null;
  },

  // Which page of the chapter a character lands on (whitespace is skipped)
  pageOf(v, off) {
    const t = v.idx.text;
    while (off < t.length && /\s/.test(t[off])) off++;
    if (off >= t.length) return v.pages - 1;
    const rect = this.charRect(v, off);
    if (!rect) return 0;
    const flowLeft = v.flow.getBoundingClientRect().left;
    return Math.max(0, Math.min(v.pages - 1, Math.floor((rect.left - flowLeft + 1) / this.W())));
  },

  // Smallest offset that sits on page `p` or later
  firstOffsetOnPage(v, p) {
    if (p <= 0) return 0;
    let lo = 0, hi = v.idx.text.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pageOf(v, mid) >= p) hi = mid; else lo = mid + 1;
    }
    return lo;
  },

  // ================= Rendering marks =================
  // Called by ensure() right after a chapter's HTML is placed on a sheet
  decorate(v, ch) {
    const body = v.flow.querySelector('.ch-body');
    let idx = this.buildIndex(body);
    for (const a of this.annots) {
      if (a.ch !== ch || a.type !== 'mark') continue;
      if (idx.text.slice(a.start, a.end) !== a.text) {          // re-locate after a re-import
        const i = idx.text.indexOf(a.text);
        if (i < 0) continue;
        a.start = i; a.end = i + a.text.length;
        this.store?.put(a);
      }
      this.wrap(idx, a);
      idx = this.buildIndex(body);
    }
    v.idx = idx;
  },

  // Wrap a character range in <mark> elements (one per text node it crosses)
  wrap(idx, a) {
    const hit = idx.nodes.filter(e => e.start < a.end && e.start + e.node.data.length > a.start);
    for (const e of hit.reverse()) {
      let n = e.node;
      const len = n.data.length;
      const s = Math.max(a.start, e.start) - e.start, t = Math.min(a.end, e.start + len) - e.start;
      if (!n.data.slice(s, t).trim()) continue;                  // skip whitespace between paragraphs
      if (t < len) n.splitText(t);
      if (s > 0) n = n.splitText(s);
      const m = document.createElement('mark');
      m.className = `hl c-${a.color}${a.note ? ' has-note' : ''}`;
      m.dataset.id = a.id;
      n.parentNode.insertBefore(m, n);
      m.appendChild(n);
    }
  },

  // Re-render the visible sheet in place (same page) after marks change
  refreshMarks() {
    const v = this.views[this.top];
    v.layout = -1;
    this.views[1 - this.top].layout = -1;
    this.commit(this.show(v, this.ch, this.page));
  },

  // ================= Records =================
  addAnnot(rec) {
    rec = { id: uid(), bookId: this.book.id, color: this.lastColor || 'yellow', note: '', createdAt: Date.now(), ...rec };
    this.annots.push(rec);
    this.store?.put(rec);
    if (rec.type === 'mark') this.refreshMarks();
    return rec;
  },
  updateAnnot(rec, changes) {
    Object.assign(rec, changes, { updatedAt: Date.now() });
    this.store?.put(rec);
    if (rec.type === 'mark') this.refreshMarks();
  },
  removeAnnot(id) {
    const i = this.annots.findIndex(a => a.id === id);
    if (i < 0) return;
    const [rec] = this.annots.splice(i, 1);
    this.store?.del(id);
    if (rec.type === 'mark' && rec.ch === this.ch) this.refreshMarks();
    else this.views.forEach(v => { if (v.ch === rec.ch) v.layout = -1; });
  },

  // ================= Bookmarks =================
  pageHasBookmark(v, ch, page) {
    return this.annots.filter(a => a.type === 'bookmark' && a.ch === ch && this.pageOf(v, a.start) === page);
  },
  updateRibbon(v, ch, page) {
    v.el.classList.toggle('bookmarked', !this.isCover(ch, page) && this.pageHasBookmark(v, ch, page).length > 0);
  },
  syncBookmarkBtn() {
    this.el.btnBookmark?.classList.toggle('on', this.views[this.top].el.classList.contains('bookmarked'));
  },
  toggleBookmark(quiet) {
    if (this.isCover(this.ch, this.page)) return toast('封面和作品信息页不能加书签');
    const v = this.views[this.top];
    const existing = this.pageHasBookmark(v, this.ch, this.page);
    if (existing.length) {
      existing.forEach(a => this.removeAnnot(a.id));
      if (!quiet) toast('已移除书签');
    } else {
      const off = this.firstOffsetOnPage(v, this.page);
      const text = v.idx.text.slice(off, off + 80).replace(/\s+/g, ' ').trim();
      this.addAnnot({ type: 'bookmark', ch: this.ch, start: off, end: off, text });
      if (!quiet) toast('已添加书签');
    }
    this.updateRibbon(v, this.ch, this.page);
    this.syncBookmarkBtn();
  },

  // ---- Pull down to bookmark ----
  // The page follows the finger (with growing resistance) and reveals an indicator;
  // past the threshold, releasing toggles the bookmark. The hidden sheet is hidden
  // so only the paper background shows above the page.
  PULL_AT: 64,
  pullStart() {
    const v = this.views[this.top];
    this.views[1 - this.top].el.style.visibility = 'hidden';
    const has = this.pageHasBookmark(v, this.ch, this.page).length > 0;
    const ind = this.el.pull;
    ind.classList.toggle('remove', has);
    ind.classList.remove('armed');
    ind.querySelector('span').textContent = has ? '下拉移除书签' : '下拉添加书签';
    ind.style.opacity = 0;
    ind.classList.add('show');
    this._pull = { v, has, d: 0, armed: false };
  },
  pullMove(dy) {
    const p = this._pull;
    if (!p) return;
    this._pullY = dy;
    if (this._pullRaf) return;
    this._pullRaf = requestAnimationFrame(() => {
      this._pullRaf = 0;
      const y = Math.max(0, this._pullY);
      const d = y < 110 ? y * .62 : 68 + (y - 110) * .22;          // rubber band
      p.d = d;
      p.v.el.style.transform = `translate3d(0,${d}px,0)`;
      const ind = this.el.pull;
      ind.style.opacity = Math.min(1, d / 40);
      ind.style.transform = `translate3d(-50%,${Math.min(d, this.PULL_AT) * .35 - 14}px,0)`;
      const armed = d >= this.PULL_AT;
      if (armed !== p.armed) {
        p.armed = armed;
        ind.classList.toggle('armed', armed);
        ind.querySelector('span').textContent = (armed ? '松开' : '下拉') + (p.has ? '移除书签' : '添加书签');
      }
    });
  },
  async pullEnd() {
    const p = this._pull;
    this._pull = null;
    if (!p) return;
    cancelAnimationFrame(this._pullRaf); this._pullRaf = 0;
    if (p.armed) this.toggleBookmark(true);
    const ind = this.el.pull;
    ind.animate([{ opacity: getComputedStyle(ind).opacity }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
    await p.v.el.animate([{ transform: `translate3d(0,${p.d}px,0)` }, { transform: 'translate3d(0,0,0)' }],
      { duration: 380, easing: 'cubic-bezier(.32,.72,0,1)' }).finished;
    p.v.el.style.transform = '';
    this.views[1 - this.top].el.style.visibility = '';
    ind.classList.remove('show', 'armed');
    ind.getAnimations().forEach(a => a.cancel());
  },

  // Jump to a chapter offset (used by the bookmark/note lists)
  goTo(ch, off, flashId) {
    const v = this.views[this.top];
    this.ensure(v, ch);
    this.commit(this.show(v, ch, this.pageOf(v, off)));
    if (flashId) setTimeout(() => {
      v.flow.querySelectorAll(`mark[data-id="${flashId}"]`).forEach(m => {
        m.classList.remove('flash'); void m.offsetWidth; m.classList.add('flash');
      });
    }, 350);
  },

  // ================= Selection =================
  // Selection is per character (punctuation included). When it starts, the visible page's
  // character boxes are measured once and cached; dragging is then plain arithmetic with
  // no layout reads, and redraws are batched to one per animation frame.
  cachePage(v) {
    const len = v.idx.text.length;
    const a = this.firstOffsetOnPage(v, this.page);
    const b = this.page + 1 < v.pages ? this.firstOffsetOnPage(v, this.page + 1) : len;
    const boxes = new Array(Math.max(0, b - a)).fill(null);
    const r = document.createRange();
    for (const e of v.idx.nodes) {
      const n = e.node, L = n.data.length;
      if (e.start + L <= a || e.start >= b) continue;
      for (let k = Math.max(0, a - e.start); k < L && e.start + k < b; k++) {
        if (/\s/.test(n.data[k])) continue;
        r.setStart(n, k); r.setEnd(n, k + 1);
        const q = r.getClientRects()[0];
        if (q && q.width) boxes[e.start + k - a] = { l: q.left, t: q.top, r: q.right, b: q.bottom };
      }
    }
    this.pc = { v, a, b, boxes, key: this.ch + ':' + this.page + ':' + this.layoutId };
  },
  ensureCache(v) {
    if (!this.pc || this.pc.v !== v || this.pc.key !== this.ch + ':' + this.page + ':' + this.layoutId) this.cachePage(v);
  },

  // Character nearest to a point (prefers the same line)
  hitChar(x, y) {
    const { a, boxes } = this.pc;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const q = boxes[i];
      if (!q) continue;
      const dy = y < q.t ? q.t - y : y > q.b ? y - q.b : 0;
      const dx = x < q.l ? q.l - x : x > q.r ? x - q.r : 0;
      const d = dy * 4 + dx;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    return best < 0 ? -1 : a + best;
  },
  // Caret position (between characters) nearest to a point
  hitBoundary(x, y) {
    const c = this.hitChar(x, y);
    if (c < 0) return -1;
    const q = this.pc.boxes[c - this.pc.a];
    return x > (q.l + q.r) / 2 ? c + 1 : c;
  },

  // Long press / mouse down: select the single character under the pointer
  beginSelect(x, y) {
    const v = this.views[this.top];
    if (!v.idx?.text.length) return false;
    this.ensureCache(v);
    const c = this.hitChar(x, y);
    if (c < 0) return false;
    this.sel = { v, start: c, end: c + 1, anchor: c };
    this.hideSelMenu();
    this.drawSel();
    return true;
  },

  // Dragging: the selection runs from the first character to the pointer
  extendSelect(x, y) {
    this._pt = [x, y];
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      const s = this.sel;
      if (!s) return;
      const b = this.hitBoundary(...this._pt);
      if (b < 0) return;
      if (b > s.anchor) { s.start = s.anchor; s.end = b; }
      else { s.start = b; s.end = s.anchor + 1; }
      this.drawSel();
    });
  },

  // Selection boxes merged into one rectangle per line
  lineRects() {
    const { a, b, boxes } = this.pc, s = this.sel, out = [];
    for (let o = Math.max(s.start, a); o < Math.min(s.end, b); o++) {
      const q = boxes[o - a];
      if (!q) continue;
      const last = out[out.length - 1];
      if (last && Math.abs(last.t - q.t) < 3 && q.l >= last.l - 1) { last.r = Math.max(last.r, q.r); last.b = Math.max(last.b, q.b); }
      else out.push({ ...q });
    }
    return out;
  },

  drawSel() {
    const layer = this.el.selLayer;
    if (!this._selBox) {
      layer.innerHTML = '<div class="sel-rects"></div>' +
        '<div class="sel-handle start" data-h="start"><i></i></div><div class="sel-handle end" data-h="end"><i></i></div>' +
        '<div class="sel-count"></div>';
      this._selBox = layer.firstChild;
      this.bindHandles();
    }
    const lines = this.lineRects(), box = this._selBox;
    while (box.children.length < lines.length) box.appendChild(Object.assign(document.createElement('div'), { className: 'sel-rect' }));
    [...box.children].forEach((d, i) => {
      const q = lines[i];
      if (!q) { d.style.display = 'none'; return; }
      d.style.display = '';
      d.style.transform = `translate(${q.l}px,${q.t}px)`;
      d.style.width = (q.r - q.l) + 'px';
      d.style.height = (q.b - q.t) + 'px';
    });
    // Small "已选 N 字" in the footer area while a selection is active
    const count = this.sel.v.idx.text.slice(this.sel.start, this.sel.end).replace(/\s/g, '').length;
    layer.querySelector('.sel-count').textContent = `已选 ${count} 字`;
    const [hs, he] = layer.querySelectorAll('.sel-handle');
    if (lines.length) {
      const f = lines[0], l = lines[lines.length - 1];
      hs.style.transform = `translate(${f.l - 1}px,${f.t}px)`; hs.style.height = (f.b - f.t) + 'px';
      he.style.transform = `translate(${l.r - 1}px,${l.t}px)`; he.style.height = (l.b - l.t) + 'px';
    }
    layer.classList.add('active');
  },

  // Drag handles to adjust either end (pointer events cover both touch and mouse)
  bindHandles() {
    this.el.selLayer.querySelectorAll('.sel-handle').forEach(h => {
      let dy = 0;
      h.addEventListener('pointerdown', e => {
        if (!this.sel) return;
        e.preventDefault(); e.stopPropagation();
        h.setPointerCapture(e.pointerId);
        const r = h.getBoundingClientRect();
        dy = e.clientY - (r.top + r.height / 2);            // keep the finger's offset from the line
        this.dragging = h.dataset.h;
        this.hideSelMenu();
      });
      h.addEventListener('pointermove', e => {
        if (this.dragging !== h.dataset.h) return;
        this._pt = [e.clientX, e.clientY - dy];
        if (this._raf) return;
        this._raf = requestAnimationFrame(() => {
          this._raf = 0;
          const s = this.sel, b = this.hitBoundary(...this._pt);
          if (!s || b < 0) return;
          if (this.dragging === 'start') s.start = Math.min(b, s.end - 1);
          else s.end = Math.max(b, s.start + 1);
          s.anchor = s.start;
          this.drawSel();
        });
      });
      const up = () => {
        if (this.dragging !== h.dataset.h) return;
        this.dragging = null;
        this._selEnded = Date.now();
        const s = this.sel;
        if (s?.rec && (s.start !== s.rec.start || s.end !== s.rec.end)) {   // resize an existing highlight
          this.updateAnnot(s.rec, { start: s.start, end: s.end, text: s.v.idx.text.slice(s.start, s.end) });
          this.sel.v = this.views[this.top];
        }
        if (this.sel) this.showSelMenu();
      };
      h.addEventListener('pointerup', up);
      h.addEventListener('pointercancel', up);
    });
  },

  clearSel() {
    this.sel = null;
    this.selecting = false;
    this.dragging = null;
    this.el.selLayer.classList.remove('active');
    this.hideSelMenu();
  },

  // Tap on an existing highlight: select it (with handles) and offer edit actions
  editMark(id) {
    const rec = this.annots.find(a => a.id === id);
    if (!rec) return;
    const v = this.views[this.top];
    this.ensureCache(v);
    this.sel = { v, start: rec.start, end: rec.end, anchor: rec.start, rec };
    this.drawSel();
    this.showSelMenu();
  },

  // ================= Selection menu =================
  showSelMenu() {
    const sel = this.sel, rec = sel.rec, menu = this.el.selMenu;
    const lines = this.lineRects();
    if (!lines.length) return this.clearSel();
    const dots = COLORS.map(c =>
      `<button class="dot c-${c}${rec && rec.color === c ? ' on' : ''}" data-act="color" data-color="${c}" aria-label="${c}"></button>`).join('');
    // An existing highlight also shows its note and when it was made / last edited
    const info = rec ? `
      <div class="sm-info">
        ${rec.note ? `<div class="sm-note">${escapeHtml(rec.note)}</div>` : ''}
        <div class="sm-date">${rec.note ? '批注' : '高亮'} · ${fmtTime(rec.updatedAt || rec.createdAt)}</div>
      </div>` : '';
    menu.innerHTML = `${info}
      <div class="sm-bar">
        <div class="sm-row">${dots}</div>
        <div class="sm-sep"></div>
        <button data-act="note">${rec?.note ? '改批注' : '批注'}</button>
        <button data-act="copy">复制</button>
        ${rec ? '<button data-act="del" class="danger">删除</button>' : ''}
      </div>`;
    menu.classList.remove('hidden');

    // Follow the end of the selection: just below its last line (clear of the handle),
    // or just above that line when there is no room below
    const end = lines[lines.length - 1];
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    let y = end.b + 22;
    if (y + mh > innerHeight - 16) y = end.t - mh - 12;
    const x = Math.max(10, Math.min(innerWidth - mw - 10, end.r - mw / 2));
    menu.style.transform = `translate(${x}px,${y}px)`;
    menu.style.transformOrigin = `${end.r - x}px ${y > end.t ? 0 : mh}px`;
    menu.animate([{ opacity: 0, scale: .92 }, { opacity: 1, scale: 1 }], { duration: 160, easing: 'ease-out' });
    // Ignore the click the browser may synthesize from the finger that just lifted
    const shownAt = Date.now();
    menu.onclick = e => { if (Date.now() - shownAt > 350) this.onMenu(e.target.closest('button')); };
  },

  hideSelMenu() { this.el.selMenu.classList.add('hidden'); },

  onMenu(btn) {
    if (!btn) return;
    const sel = this.sel, rec = sel.rec, act = btn.dataset.act;
    const text = sel.v.idx.text.slice(sel.start, sel.end);
    const base = { type: 'mark', ch: this.ch, start: sel.start, end: sel.end, text };
    if (act === 'color') {
      const color = btn.dataset.color;
      this.lastColor = color;                       // the next highlight/note uses the same color
      if (rec) this.updateAnnot(rec, { color });
      else this.addAnnot({ ...base, color });
      this.clearSel();
    } else if (act === 'note') {
      // A note on new text also highlights it (in the last color used)
      this.hideSelMenu();
      this.openNoteEditor(text, rec?.note || '', note => {
        if (rec) this.updateAnnot(rec, { note });
        else this.addAnnot({ ...base, note });
      });
      this.el.selLayer.classList.remove('active');   // hide, but keep the layer's elements (drawSel reuses them)
      this.sel = null;
    } else if (act === 'copy') {
      copyText(text);
      toast('已复制');
      this.clearSel();
    } else if (act === 'del') {
      this.removeAnnot(rec.id);
      this.clearSel();
    }
  },

  // ================= Note editor =================
  openNoteEditor(quote, initial, onSave) {
    const m = this.el.noteEditor;
    m.innerHTML = `
      <div class="ne-card">
        <div class="ne-quote">${escapeHtml(quote)}</div>
        <textarea maxlength="3000" placeholder="写下你的想法…">${escapeHtml(initial)}</textarea>
        <div class="ne-actions"><button data-act="cancel">取消</button><button data-act="save" class="primary">保存</button></div>
      </div>`;
    m.classList.remove('hidden');
    const card = m.querySelector('.ne-card'), ta = m.querySelector('textarea');
    m.animate([{ backgroundColor: 'rgba(0,0,0,0)' }, { backgroundColor: 'rgba(0,0,0,.32)' }], { duration: 220, fill: 'forwards' });
    card.animate([{ opacity: 0, transform: 'translateY(-16px) scale(.97)' }, { opacity: 1, transform: 'none' }],
      { duration: 260, easing: 'cubic-bezier(.32,.72,0,1)' });
    setTimeout(() => ta.focus(), 50);
    const close = async () => {
      ta.blur();
      await card.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px) scale(.98)' }], { duration: 160, fill: 'forwards' }).finished;
      m.classList.add('hidden');
      m.getAnimations().forEach(a => a.cancel());
    };
    m.onclick = e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'save') { onSave(ta.value.trim()); close(); }
      else if (act === 'cancel' || e.target === m) close();
    };
  },
});

// "11月17日 01:05"
function fmtTime(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  legacyCopy(text);
}
function legacyCopy(text) {                // works on plain http, where the Clipboard API is unavailable
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}
