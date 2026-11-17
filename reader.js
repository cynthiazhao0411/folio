// reader.js — Pagination and page turning
//
// Layout: one chapter at a time. The chapter is placed in .flow and split into
//   screen-wide CSS columns; page n = translating .flow left by n screen widths.
//
// Page turning uses two stacked sheets (.view), double-buffer style:
//   forward:  the lower sheet shows the next page, the top sheet curls away, then they swap.
//   backward: the lower sheet shows the previous page and curls in from the left, then they swap.
//   The curl is animated with transforms only (compositor-friendly, no repaint).

const Reader = {
  book: null,
  ch: 0, page: 0, pages: 1,
  turnMode: 'curl',          // 'curl' | 'slide'
  busy: false,               // an animation is in progress
  onProgress: null,          // callback used by app.js to persist progress
  views: [], top: 0,         // the two sheets; `top` is the visible one
  layoutId: 0,               // bumped on resize/font change to invalidate layouts
  el: {},

  init() {
    const $ = id => document.getElementById(id);
    this.el = { reader: $('reader'), stack: $('stack'), back: $('curl-back'), shadow: $('curl-shadow'),
                title: $('book-title'), toc: $('toc-panel'), note: $('note-panel') };
    this.views = [...this.el.stack.querySelectorAll('.view')].map(v => ({
      el: v, inner: v.querySelector('.view-inner'), flow: v.querySelector('.flow'),
      header: v.querySelector('.header'), footer: v.querySelector('.footer'),
      ch: -1, layout: -1, pages: 1,
    }));
    this.bindGestures();

    // Re-layout only when the viewport size actually changes (debounced 200 ms)
    let lastSize = '', timer;
    window.addEventListener('resize', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const size = innerWidth + 'x' + innerHeight;
        if (size !== lastSize && this.book && !this.el.reader.classList.contains('hidden')) this.relayout();
        lastSize = size;
      }, 200);
    });
  },

  open(book, progress) {
    this.book = book;
    // Precompute chapter offsets for the overall progress percentage
    let sum = 0;
    this.offsets = book.chapters.map(c => { const o = sum; sum += c.html.length; return o; });
    this.total = sum;

    this.el.title.textContent = book.title;
    this.el.reader.classList.remove('hidden');
    this.layoutId++;
    const ch = Math.min(progress?.ch || 0, book.chapters.length - 1);
    const v = this.views[this.top];
    const pages = this.ensure(v, ch);
    this.commit(this.show(v, ch, Math.round((progress?.frac || 0) * pages)));
    this.stackOrder();
  },

  W() { return this.el.stack.clientWidth; },

  // Ensure sheet `v` has chapter `ch` laid out (cached); returns its page count
  ensure(v, ch) {
    if (v.ch === ch && v.layout === this.layoutId) return v.pages;
    const c = this.book.chapters[ch];
    const W = this.W();
    const pad = Math.round(Math.max(24, W * 0.075));
    v.flow.style.setProperty('--pad', pad + 'px');
    v.flow.style.columnWidth = (W - pad * 2) + 'px';
    v.flow.innerHTML =
      `<h2 class="ch-title">${c.title}</h2>` +
      (c.notes ? `<div class="note-chip" data-note="start">✎ 作者注</div>` : '') +
      clean(c.html) +
      (c.endNotes ? `<div class="note-chip" data-note="end">✎ 章末作者注</div>` : '');
    v.pages = Math.max(1, Math.round((v.flow.scrollWidth + pad * 2) / W));
    v.ch = ch; v.layout = this.layoutId;
    return v.pages;
  },

  // Show chapter `ch`, page `page` (or 'last') on sheet `v`
  show(v, ch, page) {
    const pages = this.ensure(v, ch);
    page = page === 'last' ? pages - 1 : Math.max(0, Math.min(page, pages - 1));
    v.flow.style.transform = `translate3d(${-page * this.W()}px,0,0)`;
    const c = this.book.chapters[ch];
    v.header.innerHTML = `<span>${c.title}</span>`;
    const pct = (this.offsets[ch] + c.html.length * (page + 1) / pages) / this.total * 100;
    v.footer.innerHTML = `<span>${page + 1} / ${pages}</span><span>${pct.toFixed(1)}%</span>`;
    return { ch, page, pages, pct };
  },

  // Record the current position and notify app.js
  commit(s) {
    this.ch = s.ch; this.page = s.page; this.pages = s.pages;
    this.onProgress?.({ ch: s.ch, frac: s.page / s.pages, pct: s.pct });
    // While idle, pre-layout the chapter the next turn is likely to need on the hidden sheet
    clearTimeout(this._pre);
    this._pre = setTimeout(() => {
      if (this.busy) return;
      const last = this.book.chapters.length - 1;
      const ch = this.page === this.pages - 1 && this.ch < last ? this.ch + 1 : this.ch;
      this.ensure(this.views[1 - this.top], ch);
    }, 150);
  },

  stackOrder() {
    this.views.forEach((v, i) => {
      v.el.style.zIndex = i === this.top ? 2 : 1;
      v.el.style.transform = v.inner.style.transform = '';
    });
  },

  canStep(dir) {
    return dir > 0 ? (this.page < this.pages - 1 || this.ch < this.book.chapters.length - 1)
                   : (this.page > 0 || this.ch > 0);
  },

  target(dir) {
    if (dir > 0) return this.page < this.pages - 1 ? [this.ch, this.page + 1] : [this.ch + 1, 0];
    return this.page > 0 ? [this.ch, this.page - 1] : [this.ch - 1, 'last'];
  },

  turn(dir) {
    if (this.busy || !this.canStep(dir)) return;
    if (this.turnMode === 'curl') this.finishCurl(this.beginCurl(dir), true);
    else this.slide(dir);
  },
  next() { this.turn(+1); },
  prev() { this.turn(-1); },

  // Slide mode: animate within a chapter, jump across chapters
  slide(dir) {
    const v = this.views[this.top];
    const [ch, page] = this.target(dir);
    v.flow.classList.toggle('animate', ch === this.ch);
    this.commit(this.show(v, ch, page));
    setTimeout(() => v.flow.classList.remove('animate'), 300);
  },

  relayout() {
    const frac = this.page / this.pages;
    this.layoutId++;
    const v = this.views[this.top];
    const pages = this.ensure(v, this.ch);
    this.commit(this.show(v, this.ch, Math.round(frac * pages)));
  },

  goChapter(ch) {
    this.commit(this.show(this.views[this.top], ch, 0));
  },

  // ================= Page curl =================
  beginCurl(dir) {
    this.busy = true;
    const W = this.W();
    const oldV = this.views[this.top], newV = this.views[1 - this.top];
    const [ch, page] = this.target(dir);
    const dest = this.show(newV, ch, page);          // prepare the destination page on the hidden sheet
    const moving = dir > 0 ? oldV : newV;            // forward curls the old page away; backward curls the new page in
    const fixed = dir > 0 ? newV : oldV;
    moving.el.style.zIndex = 3; fixed.el.style.zIndex = 1;
    this.el.back.style.display = this.el.shadow.style.display = 'block';
    const c = { dir, W, dest, oldV, newV, moving, edge: dir > 0 ? W : -W };
    this.drawCurl(c, c.edge);
    return c;
  },

  // edge = x-position of the page's free edge: W = flat, -W = fully turned. The fold sits halfway between edge and spine.
  drawCurl(c, edge) {
    const W = c.W, fold = (W + edge) / 2, flap = Math.max(0, fold - edge);
    c.edge = edge;
    // Counter-translate outer and inner: content stays put, only the area left of the fold is visible
    c.moving.el.style.transform = `translate3d(${fold - W}px,0,0)`;
    c.moving.inner.style.transform = `translate3d(${W - fold}px,0,0)`;
    this.el.back.style.transform = `translate3d(${edge}px,0,0) scaleX(${flap / W})`;
    this.el.shadow.style.transform = `translate3d(${fold}px,0,0)`;
    this.el.shadow.style.opacity = Math.min(1, flap / 50);
  },

  finishCurl(c, complete) {
    const start = c.dir > 0 ? c.W : -c.W;
    const from = c.edge, to = complete ? -start : start;
    const dur = 180 + Math.abs(to - from) / (2 * c.W) * 220;
    const t0 = performance.now();
    const tick = now => {
      const t = Math.min(1, (now - t0) / dur);
      this.drawCurl(c, from + (to - from) * (1 - Math.pow(1 - t, 3)));   // ease-out
      if (t < 1) return requestAnimationFrame(tick);
      this.el.back.style.display = this.el.shadow.style.display = 'none';
      if (complete) {
        this.top = this.views.indexOf(c.newV);
        this.commit(c.dest);
      }
      this.stackOrder();
      this.busy = false;
    };
    requestAnimationFrame(tick);
  },

  // ================= Gestures =================
  bindGestures() {
    const area = this.el.stack;
    let x0 = 0, y0 = 0, drag = null, moved = false, decided = false;

    area.addEventListener('touchstart', e => {
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      moved = decided = false; drag = null;
    }, { passive: true });
    area.addEventListener('mousedown', () => { moved = false; });   // desktop mouse clicks

    area.addEventListener('touchmove', e => {
      e.preventDefault();                                  // prevent scrolling and rubber-banding
      const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (!decided && Math.hypot(dx, dy) > 10) {
        decided = true;
        if (Math.abs(dx) < Math.abs(dy)) return;
        moved = true;
        this.closeMenu();
        const dir = dx < 0 ? 1 : -1;
        if (this.turnMode === 'curl' && !this.busy && this.canStep(dir)) drag = this.beginCurl(dir);
      }
      if (drag) {
        const W = drag.W, edge = (drag.dir > 0 ? W : -W) + dx * 2;
        this.drawCurl(drag, Math.max(-W, Math.min(W, edge)));
      }
    }, { passive: false });

    area.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - x0;
      if (drag) {
        this.finishCurl(drag, drag.dir > 0 ? dx < -30 : dx > 30);
        drag = null;
      } else if (moved && this.turnMode !== 'curl' && Math.abs(dx) > 30) {
        dx < 0 ? this.next() : this.prev();
      }
    });

    area.addEventListener('click', e => {
      if (moved) return;
      const chip = e.target.closest('.note-chip');
      if (chip) return this.showNote(chip.dataset.note);
      if (e.target.closest('a')) return;
      if (this.el.reader.classList.contains('menu-open')) return this.closeMenu();
      const x = e.clientX / innerWidth;
      if (x < 0.32) this.prev();
      else if (x > 0.68) this.next();
      else this.el.reader.classList.add('menu-open');
    });

    document.addEventListener('keydown', e => {
      if (!this.book || this.el.reader.classList.contains('hidden')) return;
      if (e.key === 'ArrowRight') this.next();
      if (e.key === 'ArrowLeft') this.prev();
    });
  },

  closeMenu() { this.el.reader.classList.remove('menu-open'); },

  // Author's notes open in a bottom sheet so the page layout never changes
  showNote(which) {
    const c = this.book.chapters[this.ch];
    const p = this.el.note;
    p.innerHTML = `<div class="sheet-card"><div class="sheet-grip"></div>
      <h4>${which === 'end' ? '章末作者注' : '作者注'}</h4>
      <div class="sheet-body">${which === 'end' ? c.endNotes : c.notes}</div></div>`;
    p.classList.remove('hidden');
    p.onclick = e => { if (e.target === p) p.classList.add('hidden'); };
  },

  // ================= Table of contents =================
  showToc() {
    const panel = this.el.toc;
    panel.innerHTML =
      `<div class="panel-head"><button class="panel-close">‹ 返回</button><h3>目录</h3><span></span></div>` +
      this.book.chapters.map((c, i) =>
        `<a href="#" data-i="${i}" class="${i === this.ch ? 'current' : ''}">${c.title}</a>`).join('');
    panel.classList.remove('hidden');
    panel.querySelector('.current')?.scrollIntoView({ block: 'center' });
    panel.onclick = e => {
      if (e.target.closest('.panel-close')) return panel.classList.add('hidden');
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      panel.classList.add('hidden');
      this.closeMenu();
      this.goChapter(+a.dataset.i);
    };
  },
};

// Strip inline styles, alignment and empty paragraphs so the reader's typography applies
function clean(html) {
  const box = document.createElement('div');
  box.innerHTML = html;
  box.querySelectorAll('*').forEach(el => {
    el.removeAttribute('style');
    el.removeAttribute('align');
    for (const a of [...el.attributes]) if (a.name.startsWith('on')) el.removeAttribute(a.name);
  });
  box.querySelectorAll('p').forEach(p => {
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
  });
  return box.innerHTML;
}
