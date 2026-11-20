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
  coverHTML: null,           // set by app.js: renders a small cover for the TOC sheet
  titlePageHTML: null,       // set by app.js: returns { cover, info } — the two front pages before chapter 1
  views: [], top: 0,         // the two sheets; `top` is the visible one
  layoutId: 0,               // bumped on resize/font change to invalidate layouts
  el: {},

  init() {
    const $ = id => document.getElementById(id);
    this.el = { reader: $('reader'), stack: $('stack'), shadow: $('curl-shadow'),
                title: $('book-title'), toc: $('toc-panel'), note: $('note-panel'),
                selLayer: $('sel-layer'), selMenu: $('sel-menu'), noteEditor: $('note-editor'), btnBookmark: $('btn-bookmark'),
                pull: $('pull-ind') };
    this.views = [...this.el.stack.querySelectorAll('.view')].map(v => ({
      el: v, inner: v.querySelector('.view-inner'), flow: v.querySelector('.flow'),
      header: v.querySelector('.header'), footer: v.querySelector('.footer'),
      titlePage: v.querySelector('.title-page'),
      ch: -1, layout: -1, pages: 1,
    }));
    this.bindGestures();
    this.bindScrub();

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
    this.wordCount = book.chapters.reduce((n, c) => n + c.html.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s/g, '').length, 0);

    this.t2s = book.t2s ?? isTraditional(book);       // traditional books show as simplified by default
    this.el.title.textContent = this.t2s ? toSimplified(bookName(book.title)) : bookName(book.title);
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
    // Chapter 1 starts with two empty pages reserved for the front matter (cover, then
    // book info); those are drawn on top of the empty pages so they can fill the screen.
    const front = ch === 0 && this.titlePageHTML;
    if (front) {
      const fp = this.titlePageHTML(this.book, this.wordCount);
      v.titlePage.innerHTML = `<div class="fp fp-cover">${fp.cover}</div><div class="fp fp-info">${fp.info}</div>`;
      fitTitles(v.titlePage);
    }
    // The End: an extra page after the last chapter, built from the current text every time,
    // so it is always the very last page however often the book is updated
    const last = ch === this.book.chapters.length - 1 && this.titlePageHTML;
    if (last) {
      if (!v.endPage) {
        v.endPage = document.createElement('div');
        v.endPage.className = 'end-page';
        v.titlePage.after(v.endPage);
      }
      v.endPage.innerHTML = this.titlePageHTML(this.book, this.wordCount).end;
    }
    v.hasEnd = !!last;
    const T = s => this.t2s ? toSimplified(s) : s;
    v.flow.innerHTML =
      (front ? '<div class="cover-spacer"></div><div class="cover-spacer"></div>' : '') +
      `<h2 class="ch-title">${T(c.title)}</h2>` +
      this.authorNote(ch, 'start', T(c.notes)) +
      `<div class="ch-body">${T(clean(c.html))}</div>` +
      this.authorNote(ch, 'end', T(c.endNotes)) +
      (last ? '<div class="end-spacer"></div>' : '');
    this.decorate(v, ch);                                   // highlights (annotations.js)
    v.pages = Math.max(1, Math.round((v.flow.scrollWidth + pad * 2) / W));
    v.ch = ch; v.layout = this.layoutId;
    return v.pages;
  },

  // The author's notes sit in the text as a quiet box. Short ones show in full; long ones
  // show their first lines and open with a tap (the page layout is redone around them).
  NOTE_LONG: 280,
  openNotes: new Set(),
  authorNote(ch, which, html) {
    if (!html || !html.replace(/<[^>]+>/g, '').trim()) return '';
    const key = this.book.id + '|' + ch + '|' + which;
    const long = html.replace(/<[^>]+>/g, '').length > this.NOTE_LONG, open = !long || this.openNotes.has(key);
    return `<aside class="an an-${which}${open ? '' : ' folded'}" data-key="${key}">
      <div class="an-k">${which === 'end' ? '作者的话 · 章末' : '作者的话'}</div>
      <div class="an-b">${clean(html)}</div>
      ${long ? `<button class="an-more">${open ? '收起' : '展开全部'}</button>` : ''}
    </aside>`;
  },
  toggleNote(key) {
    this.openNotes.has(key) ? this.openNotes.delete(key) : this.openNotes.add(key);
    // Re-lay out this chapter and stay on the page where the note starts
    const v = this.views[this.top];
    v.layout = -1;
    this.views[1 - this.top].layout = -1;
    if (this.backV) this.backV.layout = -1;
    this.ensure(v, this.ch);
    const box = v.flow.querySelector(`.an[data-key="${CSS.escape(key)}"]`);
    const page = box ? Math.floor((box.offsetLeft + 1) / this.W()) : this.page;
    this.commit(this.show(v, this.ch, page));
  },

  // Show chapter `ch`, page `page` (or 'last') on sheet `v`
  show(v, ch, page) {
    const pages = this.ensure(v, ch);
    page = page === 'last' ? pages - 1 : Math.max(0, Math.min(page, pages - 1));
    v.flow.style.transform = `translate3d(${-page * this.W()}px,0,0)`;
    const c = this.book.chapters[ch];
    v.header.innerHTML = `<span>${this.t2s ? toSimplified(c.title) : c.title}</span>`;
    const pct = (this.offsets[ch] + c.html.length * (page + 1) / pages) / this.total * 100;
    v.footer.innerHTML = `<span>第 ${ch + 1} 章 · ${page + 1} / ${pages}</span><span>全书 ${pct < 1 ? pct.toFixed(1) : Math.floor(pct)}%</span>`;
    v.el.classList.toggle('on-front', this.isCover(ch, page));
    v.el.classList.toggle('on-info', this.isCover(ch, page) && page === 1);
    v.el.classList.toggle('on-end', this.isEnd(v, ch, page));
    this.updateRibbon(v, ch, page);
    return { ch, page, pages, pct };
  },

  isCover(ch, page) { return ch === 0 && page < 2 && !!this.titlePageHTML; },   // cover or info page
  isEnd(v, ch, page) { return !!v?.hasEnd && ch === this.book.chapters.length - 1 && page === v.pages - 1; },
  // Pages that are not text: no bookmarks, no selection
  isSpecial(ch, page) { return this.isCover(ch, page) || this.isEnd(this.views[this.top], ch, page); },
  // The range of text pages in a chapter (front pages and The End excluded)
  textRange(v, ch) {
    const first = ch === 0 && this.titlePageHTML ? 2 : 0;
    const last = v.pages - 1 - (v.hasEnd ? 1 : 0);
    return [Math.min(first, last), Math.max(first, last)];
  },

  // Record the current position and notify app.js
  commit(s) {
    this.ch = s.ch; this.page = s.page; this.pages = s.pages; this.pct = s.pct;
    this.syncBookmarkBtn();
    // Standalone mode: tint the status bar to match the full-bleed info page
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      const top = this.views[this.top];
      const ip = s.ch === 0 && s.page === 1 ? top.titlePage.querySelector('.ip')
               : this.isEnd(top, s.ch, s.page) ? top.endPage?.querySelector('.ip') : null;
      meta.content = ip ? getComputedStyle(ip).getPropertyValue('--c').trim()
                        : getComputedStyle(document.body).getPropertyValue('--bg').trim();
    }
    this.onProgress?.({ ch: s.ch, frac: s.page / s.pages, pct: s.pct });
    this.updateScrub();
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
      v.el.style.transform = v.inner.style.transform = v.el.style.clipPath = '';
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

  turn(dir, y) {
    if (this.sel) this.clearSel();
    if (this.busy || !this.canStep(dir)) return;
    if (this.turnMode === 'curl') this.finishCurl(this.beginCurl(dir, y), true, true);
    else this.slide(dir);
  },
  next(y) { this.turn(+1, y); },
  prev(y) { this.turn(-1, y); },

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

  // Jump to the start of a chapter's text. Chapter 1 begins after the two front pages.
  goChapter(ch) {
    const first = ch === 0 && this.titlePageHTML ? 2 : 0;
    this.commit(this.show(this.views[this.top], ch, first));
  },

  // ================= Page curl =================
  // Geometry (page W × H, spine at x = 0): C is the point of the free edge that is lifted (a
  // corner, or a point in the middle of the edge) and P is where it is now. The fold is the
  // perpendicular bisector of C–P. The part of the page on C's side of the fold is lifted,
  // turned over, and lies reflected across the fold, showing the back of the paper: the same
  // page mirrored, faintly through the paper (a third sheet, backV). The page underneath shows
  // where the lifted part was, with a shadow along the fold.
  //   forward:  the current page turns away, P goes from C to C mirrored over the spine (-W)
  //   backward: the previous page lies turned over and comes back, P goes from -W to C
  // Everything moves by transforms and clip paths only: the text itself is never repainted.
  curlSheet() {
    if (this.backV) return this.backV;
    const el = this.views[0].el.cloneNode(true);
    el.classList.add('curl-sheet');
    el.querySelector('.flow').innerHTML = ''; el.querySelector('.title-page').innerHTML = '';
    el.querySelector('.end-page')?.remove();
    el.insertAdjacentHTML('beforeend', '<div class="curl-paper"></div><div class="curl-sheen"></div>');
    this.el.stack.appendChild(el);
    this.backV = { el, inner: el.querySelector('.view-inner'), flow: el.querySelector('.flow'), header: el.querySelector('.header'),
      footer: el.querySelector('.footer'), titlePage: el.querySelector('.title-page'), sheen: el.querySelector('.curl-sheen'),
      ch: -1, layout: -1, pages: 1 };
    return this.backV;
  },

  // dir: +1 forward, -1 backward. y: height of the point that is lifted (taps and drags start
  // where the finger is); near the top or bottom the corner itself is lifted.
  beginCurl(dir, y) {
    this.busy = true;
    const W = this.W(), H = this.el.stack.clientHeight;
    const oldV = this.views[this.top], newV = this.views[1 - this.top];
    const [ch, page] = this.target(dir);
    const dest = this.show(newV, ch, page);          // prepare the destination page on the hidden sheet
    const moving = dir > 0 ? oldV : newV, fixed = dir > 0 ? newV : oldV;
    const back = this.curlSheet();
    this.show(back, dir > 0 ? this.ch : dest.ch, dir > 0 ? this.page : dest.page);    // the back of the turning page
    fixed.el.style.zIndex = 1; this.el.shadow.style.zIndex = 2; moving.el.style.zIndex = 3; back.el.style.zIndex = 4;
    this.el.shadow.style.display = 'block';
    y = y ?? H * .62;
    const cy = y < H * .22 ? 0 : y > H * .78 ? H : Math.max(H * .1, Math.min(H * .9, y));
    const c = { dir, W, H, dest, oldV, newV, moving, back, cy, rest: [W, cy], away: [-W, cy] };
    c.p = dir > 0 ? [...c.rest] : [...c.away];
    this.drawCurl(c, c.p);
    return c;
  },

  // The lifted point can't tear the paper from the spine: it stays within reach of the spine
  constrain(c, [x, y]) {
    const { W, H, cy } = c;
    const fit = (ax, ay, R) => { const dx = x - ax, dy = y - ay, d = Math.hypot(dx, dy); if (d > R) { x = ax + dx * R / d; y = ay + dy * R / d; } };
    fit(0, cy, W);
    if (cy === 0 || cy === H) fit(0, H - cy, Math.hypot(W, H));
    return [Math.min(x, W), y];
  },

  drawCurl(c, p) {
    const [px, py] = c.p = this.constrain(c, p);
    const { W, H, cy, moving, back } = c;
    const nx = W - px, ny = cy - py, len = Math.hypot(nx, ny);
    if (len < .5) {                                   // flat
      moving.el.style.clipPath = ''; back.el.style.visibility = ''; this.el.shadow.style.opacity = 0;
      return;
    }
    const ux = nx / len, uy = ny / len, mx = (W + px) / 2, my = (cy + py) / 2;
    // The page rectangle cut by the fold: `kept` lies flat, `flap` is lifted
    const side = (x, y) => (x - mx) * ux + (y - my) * uy;
    const corners = [[0, 0], [W, 0], [W, H], [0, H]], kept = [], flap = [];
    let depth = 0;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4], sa = side(...a), sb = side(...b);
      (sa > 0 ? flap : kept).push(a);
      if (sa > 0) depth = Math.max(depth, sa);
      if ((sa > 0) !== (sb > 0)) {
        const t = sa / (sa - sb), q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        kept.push(q); flap.push(q);
      }
    }
    const poly = pts => pts.length ? `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',')})` : 'polygon(0 0)';
    moving.el.style.clipPath = poly(kept);
    // The back: the same page reflected across the fold, cut to the lifted part
    const k = 2 * (mx * ux + my * uy);
    back.el.style.visibility = 'visible';
    back.el.style.transform = `matrix(${1 - 2 * ux * ux},${-2 * ux * uy},${-2 * ux * uy},${1 - 2 * uy * uy},${k * ux},${k * uy})`;
    back.el.style.clipPath = poly(flap);
    // Curvature of the paper on the back, and the shadow it casts along the fold
    const ang = Math.atan2(uy, ux) * 180 / Math.PI;
    back.sheen.style.transform = `translate3d(${mx}px,${my}px,0) rotate(${ang}deg) translateY(-50%) scaleX(${Math.max(1, depth) / 100})`;
    const lift = Math.min(1, len / (W * .35));
    this.el.shadow.style.opacity = .35 + .65 * lift;
    this.el.shadow.style.transform = `translate3d(${mx}px,${my}px,0) rotate(${ang}deg) translateY(-50%) scaleX(${(14 + Math.min(70, depth * .28)) / 100})`;
  },

  // Let go: finish the turn (complete) or lay the page back. `fromTap` turns a resting page in
  // one movement that lifts the point a little on the way, like a hand flipping a page.
  finishCurl(c, complete, fromTap = false, velocity = 0) {
    const from = [...c.p];
    const to = (c.dir > 0) === complete ? c.away : c.rest;
    const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const speed = Math.max(Math.abs(velocity), 1.6);                 // px per ms
    const dur = fromTap ? 560 : Math.max(170, Math.min(480, dist / speed));
    const ease = fromTap
      ? t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
      : t => 1 - Math.pow(1 - t, 3);
    const arc = fromTap ? (c.cy === c.H ? -1 : c.cy === 0 ? 1 : 0) * c.H * .1 : 0;
    const t0 = performance.now();
    const tick = now => {
      const t = Math.min(1, (now - t0) / dur), e = ease(t);
      this.drawCurl(c, [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e + arc * Math.sin(Math.PI * t)]);
      if (t < 1) return requestAnimationFrame(tick);
      c.back.el.style.visibility = ''; this.el.shadow.style.display = 'none';
      c.back.el.style.clipPath = c.moving.el.style.clipPath = '';
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
    let x0 = 0, y0 = 0, drag = null, moved = false, decided = false, press = null, pulling = false;

    // A drag turning a page: the lifted point follows the finger (or mouse) from where it went
    // down; turning back starts from the page lying turned over, so it moves twice as fast.
    // Drawing waits for the next animation frame; the last 100 ms give the speed at release.
    let raf = 0, track = [];
    const startCurl = (dir, x, y) => {
      if (this.turnMode !== 'curl' || this.busy || !this.canStep(dir)) return null;
      const top = this.el.stack.getBoundingClientRect().top;
      const c = this.beginCurl(dir, y - top);
      c.start = [x, y]; c.base = [...c.p]; c.kx = dir > 0 ? 1 : 2;
      track = [[performance.now(), x]];
      return c;
    };
    const moveCurl = (c, x, y) => {
      c.want = [c.base[0] + (x - c.start[0]) * c.kx, c.base[1] + (y - c.start[1])];
      const now = performance.now();
      track.push([now, x]);
      while (track.length > 2 && now - track[0][0] > 100) track.shift();
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (c.want && this.busy) this.drawCurl(c, c.want); });
    };
    const endCurl = c => {
      cancelAnimationFrame(raf); raf = 0;
      if (c.want) this.drawCurl(c, c.want);
      const [t0, x0] = track[0], [t1, x1] = track[track.length - 1];
      const vx = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;                 // px per ms, + = rightwards
      const W = c.W, px = c.p[0];
      const complete = c.dir > 0 ? vx < -.25 || (vx < .25 && px < W * .62)
                                 : vx > .25 || (vx > -.25 && px > -W * .35);
      this.finishCurl(c, complete, false, vx * c.kx);
    };

    let grab = null;          // a drag that started next to a selection handle moves that end
    area.addEventListener('touchstart', e => {
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      moved = decided = pulling = false; drag = null;
      clearTimeout(press);
      grab = e.touches.length === 1 ? this.nearHandle(x0, y0) : null;
      if (grab) { this.dragging = grab; this.hideSelMenu(); return; }
      // Long press (450 ms without moving) starts a text selection
      if (e.touches.length === 1 && !this.busy && !this.sel) press = setTimeout(() => {
        if (moved || drag) return;
        if (this.beginSelect(x0, y0)) { this.selecting = true; moved = true; this.closeMenu(); }
      }, 450);
    }, { passive: true });
    // ---- Mouse (desktop testing) ----
    // Drag to select text, or hold still for 450 ms to select the phrase under the pointer.
    // Browsers also fire compatibility mouse events after a touch, so those are ignored.
    let lastTouch = 0, mdown = null, mpress = null, medge = null, mdrag = null;
    const startMouseSelect = () => {
      if (!mdown || !this.beginSelect(mdown.x, mdown.y)) return false;
      this.selecting = true; moved = true; this.closeMenu();
      return true;
    };
    area.addEventListener('mousedown', e => {
      if (Date.now() - lastTouch < 800 || e.button !== 0) return;
      moved = false;
      if (this.sel || this.busy) return;                   // the click that follows clears the selection
      // In the page margins, outside the text, a drag turns the page as it does with a finger
      const pad = parseFloat(this.views[this.top].flow.style.getPropertyValue('--pad')) || 24;
      const ex = e.clientX - this.el.stack.getBoundingClientRect().left, W = this.W();
      if (this.turnMode === 'curl' && (ex < pad + 12 || ex > W - pad - 12)) { medge = { x: e.clientX, y: e.clientY, dir: ex > W / 2 ? 1 : -1 }; return; }
      mdown = { x: e.clientX, y: e.clientY };
      mpress = setTimeout(startMouseSelect, 450);
    });
    window.addEventListener('mousemove', e => {
      if (medge) {
        if (!mdrag && Math.abs(e.clientX - medge.x) > 6) { mdrag = startCurl(medge.dir, medge.x, medge.y); if (!mdrag) medge = null; else moved = true; }
        if (mdrag) moveCurl(mdrag, e.clientX, e.clientY);
        return;
      }
      if (!mdown) return;
      if (this.selecting) return this.extendSelect(e.clientX, e.clientY);
      if (Math.hypot(e.clientX - mdown.x, e.clientY - mdown.y) > 6) {
        clearTimeout(mpress);
        if (startMouseSelect()) this.extendSelect(e.clientX, e.clientY);
        else mdown = null;
      }
    });
    window.addEventListener('mouseup', () => {
      if (medge) { medge = null; if (mdrag) { endCurl(mdrag); mdrag = null; } return; }
      clearTimeout(mpress);
      if (!mdown) return;
      mdown = null;
      if (this.selecting) { this.selecting = false; this._selEnded = Date.now(); this.showSelMenu(); }
    });

    area.addEventListener('touchmove', e => {
      e.preventDefault();                                  // prevent scrolling and rubber-banding
      if (grab) { moved = true; return this.moveEnd(grab, e.touches[0].clientX, e.touches[0].clientY); }
      if (this.selecting) return this.extendSelect(e.touches[0].clientX, e.touches[0].clientY);
      const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (pulling) return this.pullMove(dy);
      if (!decided && Math.hypot(dx, dy) > 10) {
        decided = true;
        clearTimeout(press);
        if (this.sel) { moved = true; return this.clearSel(); }   // swiping dismisses a selection
        if (Math.abs(dx) < Math.abs(dy)) {
          // Pulling the page down adds (or removes) a bookmark
          if (dy > 0 && !this.busy && !this.isSpecial(this.ch, this.page)) {
            moved = pulling = true;
            this.closeMenu();
            this.pullStart();
          }
          return;
        }
        moved = true;
        this.closeMenu();
        drag = startCurl(dx < 0 ? 1 : -1, x0, y0);
      }
      if (drag) moveCurl(drag, e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    area.addEventListener('touchend', e => {
      clearTimeout(press);
      lastTouch = Date.now();
      if (grab) { grab = null; return this.endMove(); }
      if (this.selecting) { this.selecting = false; this._selEnded = Date.now(); return this.showSelMenu(); }
      const dx = e.changedTouches[0].clientX - x0;
      if (pulling) { pulling = false; return this.pullEnd(); }
      if (drag) {
        endCurl(drag);
        drag = null;
      } else if (moved && this.turnMode !== 'curl' && Math.abs(dx) > 30) {
        dx < 0 ? this.next() : this.prev();
      }
    });

    area.addEventListener('click', e => {
      if (moved || Date.now() - (this._selEnded || 0) < 300) return;
      if (this.sel) return this.clearSel();                // tap anywhere dismisses the selection menu
      // Tapping the bookmark ribbon (with a generous margin around it) removes the bookmark
      const top = this.views[this.top];
      if (top.el.classList.contains('bookmarked')) {
        const r = top.el.querySelector('.ribbon').getBoundingClientRect();
        if (e.clientX > r.left - 20 && e.clientX < r.right + 20 && e.clientY < r.bottom + 20) return this.toggleBookmark();
      }
      const mark = e.target.closest('mark.hl');
      if (mark) return this.editMark(mark.dataset.id);
      if (e.target.closest('.ip-start')) return this.next();      // "start the story" on the info page
      const an = e.target.closest('.an');
      if (an && (e.target.closest('.an-more') || an.classList.contains('folded'))) return this.toggleNote(an.dataset.key);
      if (e.target.closest('a')) return;
      if (this.el.reader.classList.contains('menu-open')) return this.closeMenu();
      const x = e.clientX / innerWidth, y = e.clientY - this.el.stack.getBoundingClientRect().top;
      if (x < 0.32) this.prev(y);
      else if (x > 0.68) this.next(y);
      else this.el.reader.classList.add('menu-open');
    });

    document.addEventListener('keydown', e => {
      if (!this.book || this.el.reader.classList.contains('hidden')) return;
      if (e.key === 'ArrowRight') this.next();
      if (e.key === 'ArrowLeft') this.prev();
    });
  },

  closeMenu() {
    this.el.reader.classList.remove('menu-open');
  },

  // ================= Chapter scrubber =================
  // The bar covers the current chapter only: drag to any page of it. Chapters are changed
  // with the 上一章 / 下一章 buttons; pages still turn with taps and swipes.
  bindScrub() {
    const scrub = document.getElementById('scrub'), tip = scrub.querySelector('.scrub-tip');
    const at = x => { const r = scrub.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)); };
    const pageAt = f => {
      const [a, b] = this.textRange(this.views[this.top], this.ch);
      return a + Math.round(f * (b - a));
    };
    let dragging = false;
    const move = x => {
      const f = at(x), [a, b] = this.textRange(this.views[this.top], this.ch), p = pageAt(f);
      this.drawScrub(b > a ? (p - a) / (b - a) * 100 : 100);
      tip.textContent = `第 ${p - a + 1} / ${b - a + 1} 页`;
      tip.style.left = (f * 100) + '%';
    };
    scrub.addEventListener('pointerdown', e => {
      dragging = true;
      scrub.setPointerCapture(e.pointerId);
      scrub.classList.add('dragging');
      move(e.clientX);
    });
    scrub.addEventListener('pointermove', e => { if (dragging) move(e.clientX); });
    const up = e => {
      if (!dragging) return;
      dragging = false;
      scrub.classList.remove('dragging');
      if (this.sel) this.clearSel();
      this.commit(this.show(this.views[this.top], this.ch, pageAt(at(e.clientX))));
    };
    scrub.addEventListener('pointerup', up);
    scrub.addEventListener('pointercancel', up);
    document.getElementById('btn-prev-ch').onclick = () => this.stepChapter(-1);
    document.getElementById('btn-next-ch').onclick = () => this.stepChapter(1);
  },
  // Previous / next chapter; after the last chapter comes The End
  stepChapter(d) {
    if (this.sel) this.clearSel();
    const n = this.book.chapters.length, ch = this.ch + d;
    if (ch < 0) return toast('已经是第一章');
    if (ch >= n) {
      const v = this.views[this.top];
      if (this.isEnd(v, this.ch, this.page)) return toast('已经是最后一页');
      return this.commit(this.show(v, this.ch, 'last'));
    }
    this.goChapter(ch);
  },
  drawScrub(pct) {
    document.getElementById('scrub')?.style.setProperty('--p', Math.max(0, Math.min(100, pct)) + '%');
  },
  updateScrub() {
    const scrub = document.getElementById('scrub');
    if (!scrub || scrub.classList.contains('dragging')) return;
    const [a, b] = this.textRange(this.views[this.top], this.ch);
    this.drawScrub(b > a ? (Math.min(Math.max(this.page, a), b) - a) / (b - a) * 100 : 100);
    document.getElementById('btn-prev-ch').disabled = this.ch === 0;
    document.getElementById('btn-next-ch').disabled = this.isEnd(this.views[this.top], this.ch, this.page);
  },
  // Last text page of this chapter, or The End of the book
  jumpEnd(book) {
    if (this.sel) this.clearSel();
    const v = this.views[this.top];
    if (book) return this.commit(this.show(v, this.book.chapters.length - 1, 'last'));
    this.ensure(v, this.ch);
    this.commit(this.show(v, this.ch, this.textRange(v, this.ch)[1]));
  },

  // Traditional → Simplified display (lib/t2s.js); the stored text never changes
  setT2S(on) {
    this.t2s = !!on;
    this.layoutId++;
    const v = this.views[this.top], frac = this.page / this.pages, pages = this.ensure(v, this.ch);
    this.commit(this.show(v, this.ch, Math.round(frac * pages)));
    this.el.title.textContent = this.t2s ? toSimplified(bookName(this.book.title)) : bookName(this.book.title);
  },

  // ================= Table of contents =================
  // Bottom sheet with book info and three tabs: contents, bookmarks, notes
  showToc(tab = 'toc') {
    const b = this.book, modal = this.el.toc;
    const pct = (this.pct || 0).toFixed(1);
    const words = this.wordCount >= 10000 ? (this.wordCount / 10000).toFixed(2) + ' 万字' : this.wordCount + ' 字';
    const marks = this.annots.filter(a => a.type === 'mark').sort((x, y) => x.ch - y.ch || x.start - y.start);
    const bms = this.annots.filter(a => a.type === 'bookmark').sort((x, y) => x.ch - y.ch || x.start - y.start);
    const date = ts => fmtTime(ts);
    const chName = i => escapeHtml(b.chapters[i]?.title || '');
    const empty = (icon, text) => `<div class="list-empty"><div class="le-icon">${icon}</div>${text}</div>`;

    const tocList = b.chapters.map((c, i) => `<a href="#" data-ch="${i}" class="${i === this.ch ? 'current' : ''}">
      <span>${c.title}</span><small>${i + 1}</small></a>`).join('');
    const bmList = bms.length ? bms.map(a => `
      <div class="li" data-ch="${a.ch}" data-off="${a.start}">
        <div class="li-top"><span>${chName(a.ch)}</span><span>${date(a.createdAt)}</span></div>
        <div class="li-text">${escapeHtml(a.text)}…</div>
        <button class="li-del" data-del="${a.id}" aria-label="删除">删除</button>
      </div>`).join('') : empty('🔖', '还没有书签<br><small>阅读时点顶部的书签按钮添加</small>');
    const noteList = marks.length ? marks.map(a => `
      <div class="li" data-ch="${a.ch}" data-off="${a.start}" data-id="${a.id}">
        <div class="li-top"><span>${chName(a.ch)}</span><span>${date(a.updatedAt || a.createdAt)}</span></div>
        <div class="li-quote c-${a.color}">${escapeHtml(a.text)}</div>
        ${a.note ? `<div class="li-note">${escapeHtml(a.note)}</div>` : ''}
        <button class="li-del" data-del="${a.id}" aria-label="删除">删除</button>
      </div>`).join('') : empty('✎', '还没有划线或笔记<br><small>阅读时长按文字即可选择</small>');

    modal.innerHTML = `
      <div class="sheet-card tall">
        <div class="sheet-grip"></div>
        <div class="sheet-head">
          <button class="sheet-x" aria-label="关闭">
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="sheet-tabs">
            <button data-tab="toc">目录</button>
            <button data-tab="bm">书签${bms.length ? `<sup>${bms.length}</sup>` : ''}</button>
            <button data-tab="notes">笔记${marks.length ? `<sup>${marks.length}</sup>` : ''}</button>
          </div>
          <span class="sheet-x-space"></span>
        </div>
        <div class="toc-book">
          ${this.coverHTML ? this.coverHTML(b) : ''}
          <div class="toc-book-info">
            <div class="tb-title">${bookName(b.title)}</div>
            <div class="tb-author">${b.authors.join('、')}</div>
            <div class="tb-meta">${pct}% · ${b.chapters.length} 章 · ${words}</div>
            ${(() => { const m = this.metaInfo?.(); if (!m?.readMs) return '';
              return `<div class="tb-meta">已读 ${fmtDur(m.readMs, true)}${m.reads ? ` · 读完 ${m.reads} 遍` : ''}</div>`; })()}
          </div>
        </div>
        <div class="sheet-scroll toc-list" data-pane="toc">${tocList}</div>
        <div class="sheet-scroll note-list hidden" data-pane="bm">${bmList}</div>
        <div class="sheet-scroll note-list hidden" data-pane="notes">${noteList}</div>
      </div>`;
    this.closeMenu();
    Sheet.open(modal);

    const setTab = t => {
      modal.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === t));
      modal.querySelectorAll('[data-pane]').forEach(x => x.classList.toggle('hidden', x.dataset.pane !== t));
    };
    setTab(tab);
    const list = modal.querySelector('.toc-list'), cur = list.querySelector('.current');
    if (cur && tab === 'toc') list.scrollTop = cur.offsetTop - list.clientHeight / 2 + cur.offsetHeight / 2;

    modal.querySelector('.sheet-x').onclick = () => Sheet.close(modal);
    modal.querySelector('.sheet-tabs').onclick = e => {
      const t = e.target.closest('[data-tab]');
      if (!t) return;
      setTab(t.dataset.tab);
      if (t.dataset.tab === 'toc' && cur) list.scrollTop = cur.offsetTop - list.clientHeight / 2 + cur.offsetHeight / 2;
    };
    modal.querySelectorAll('[data-pane]').forEach(pane => pane.onclick = e => {
      const del = e.target.closest('[data-del]');
      if (del) {
        const item = del.closest('.li');
        this.removeAnnot(del.dataset.del);
        item.animate([{ opacity: 1, height: item.offsetHeight + 'px' }, { opacity: 0, height: '0px', paddingTop: 0, paddingBottom: 0 }],
          { duration: 220, easing: 'ease-in' }).finished.then(() => item.remove());
        return;
      }
      const a = e.target.closest('[data-ch]');
      if (!a) return;
      e.preventDefault();
      if (a.dataset.off !== undefined) this.goTo(+a.dataset.ch, +a.dataset.off, a.dataset.id);
      else this.goChapter(+a.dataset.ch);
      Sheet.close(modal);
    });
  },
};

// Strip inline styles, alignment and empty paragraphs so the reader's typography applies
// ---------- Traditional → Simplified ----------
let T2S = null;
function t2sTable() {
  if (!T2S) { T2S = new Map(); for (let i = 0; i < T2S_PAIRS.length; i += 2) T2S.set(T2S_PAIRS[i], T2S_PAIRS[i + 1]); }
  return T2S;
}
function toSimplified(s) {
  if (!s) return s;
  t2sTable();
  return s.replace(/[\u3400-\u9fff\uf900-\ufaff]/g, c => T2S.get(c) || c);
}
// A book counts as traditional when a noticeable share of its characters have a simplified form
function isTraditional(book) {
  t2sTable();
  const sample = book.chapters.slice(0, 3).map(c => c.html.replace(/<[^>]+>/g, '')).join('').slice(0, 20000);
  const han = sample.match(/[\u3400-\u9fff]/g) || [];
  if (han.length < 50) return false;
  return han.filter(c => T2S.has(c)).length / han.length > .04;
}

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
