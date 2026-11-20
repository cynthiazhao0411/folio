// stats.js — Reading time, read-through counting, and the statistics page.
//
// Reading time ("effective reading") is counted while a book is open — on any page,
// in the contents/notes sheets, while writing a note, later while listening — except:
//   • 90 s after the last touch / click / key / scroll, the clock stops (idle), and the
//     next interaction starts it again. The first 90 s of stillness still count.
//   • the moment the app is hidden (another app, lock screen, another tab) it stops.
// Idle detection only affects the statistics; reading itself is never interrupted.

const IDLE_MS = 90 * 1000;
// Characters per minute for estimated reading times: a typical silent-reading pace for Chinese,
// between the slow (~300) and fast (~460) adult readers measured in eye-tracking studies
const READ_SPEED = 400;

// ================= Clock =================
const Clock = {
  bookId: null,
  listening: false,              // read-aloud keeps the clock running without touches
  timer: 0, last: 0, lastActivity: 0, pending: 0,
  onFlush: null,                 // (bookId, ms) => Promise, set by app.js

  init() {
    const poke = () => { this.lastActivity = Date.now(); };
    ['touchstart', 'touchmove', 'pointerdown', 'mousemove', 'wheel', 'keydown', 'input', 'scroll']
      .forEach(t => document.addEventListener(t, poke, { capture: true, passive: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.tick(); this.flush(); }   // stop right away
      else { this.last = Date.now(); poke(); }               // coming back counts as activity
    });
    addEventListener('pagehide', () => { this.tick(); this.flush(); });
  },

  start(bookId) {
    this.stop();
    this.bookId = bookId;
    this.last = this.lastActivity = Date.now();
    this.timer = setInterval(() => this.tick(), 1000);
  },

  async stop() {
    if (!this.bookId) return;
    this.tick();
    clearInterval(this.timer);
    await this.flush();
    this.bookId = null;
  },

  tick() {
    const now = Date.now(), dt = Math.min(now - this.last, 2000);   // timers can stall; never count a gap
    this.last = now;
    if (!this.bookId || document.hidden) return;
    if (!this.listening && now - this.lastActivity > IDLE_MS) return;   // idle
    this.pending += dt;
    if (this.pending >= 10000) this.flush();
  },

  async flush() {
    const ms = this.pending, id = this.bookId;
    this.pending = 0;
    if (ms > 0 && id) await this.onFlush?.(id, ms);
  },

  idle() { return !this.listening && Date.now() - this.lastActivity > IDLE_MS; },
};

// ================= Estimated reading time =================
// Characters (punctuation included, spaces and markup not) ÷ READ_SPEED, for every chapter.
// Kept in m.est = { speed, chapters: [ms…], total: ms } so the shelf never needs the text.
function chapterChars(c) {
  return (c?.html || '').replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s/g, '').length;
}
function estimateBook(chapters) {
  const list = chapters.map(c => Math.round(chapterChars(c) / READ_SPEED * 60000));
  return { speed: READ_SPEED, chapters: list, total: list.reduce((a, b) => a + b, 0) };
}
function estimateMs(m) { return m.est?.total ?? (m.words || 0) / READ_SPEED * 60000; }

// ================= Read-throughs =================
// A read-through counts when progress reaches 98% AND the real reading time of this
// read-through reaches 40% of the book's estimated reading time, so jumping to the end
// doesn't count. Reading time is the reading clock's (only while the book is open and in use).
// After it counts, going back to the first 10% starts a new read-through.
// Each finished read-through is kept in m.readThroughs: { n, start, end, ms, opens, est }.
const FINISH_PCT = 98;
function newRun() { return { ms: 0, counted: false, start: null }; }
// The read-through that reading time is added to now (a new one once a finished book is back in its first 10%)
function currentRun(m) {
  if (!m.run || (m.run.counted && (m.progress?.pct || 0) < 10)) m.run = newRun();
  return m.run;
}

function checkFinished(m) {
  const run = currentRun(m), pct = m.progress?.pct || 0;
  const est = estimateMs(m);
  if (!run.counted && pct >= FINISH_PCT && est > 0 && run.ms >= est * .4) {
    run.counted = true;
    m.reads = (m.reads || 0) + 1;
    if (m.status) m.status = 'done';                 // a hand-set status follows the real finish
    const now = Date.now();
    (m.finished || (m.finished = [])).push(now);
    (m.readThroughs || (m.readThroughs = [])).push({ n: m.reads, start: run.start, end: now, ms: Math.round(run.ms), opens: null, est: Math.round(est) });
    return true;
  }
  return false;
}

// How many times the book was opened during a read-through, from the session records:
// openings with reading time, an opening within 2 minutes of the last one (a reload) merged in
async function countOpens(bookId, from, to) {
  const list = (await DB.allSessions()).filter(x => x.bookId === bookId && x.ms > 0 && (x.end || x.start) >= (from || 0) && x.start <= to)
    .sort((a, b) => a.start - b.start);
  let n = 0, lastEnd = -Infinity;
  for (const x of list) { if (x.start - lastEnd > 120000) n++; lastEnd = Math.max(lastEnd, x.end); }
  return { opens: n, first: list[0]?.start ?? null };
}

// ================= Formatting =================
function fmtDur(ms, short) {
  const m = Math.round(ms / 60000);
  if (m < 1) return ms > 0 ? '不到1分钟' : '0分钟';
  if (m < 60) return m + '分钟';
  const h = Math.floor(m / 60), r = m % 60;
  return h + '小时' + (r ? r + (short ? '分' : '分钟') : '');
}
const ymd = d => d.toLocaleDateString('sv');                     // "2026-11-17" in local time
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const startOfWeek = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return addDays(x, -((x.getDay() + 6) % 7)); };

// ================= Statistics page =================
const StatsPage = {
  mode: 'week', offset: 0, data: null,

  // bookId: show one book's statistics instead of the whole library
  async open(bookId) {
    let [daily, metas] = await Promise.all([DB.allDaily(), DB.allMeta()]);
    this.bookId = bookId || null;
    if (bookId) {
      daily = daily.filter(r => r.bookId === bookId);
      metas = metas.filter(m => m.id === bookId);
    }
    const sheet = document.getElementById('stats-sheet');
    sheet.querySelector('.sheet-tabs button').textContent = bookId ? (metas[0] ? bookName(metas[0].title) : '阅读统计') : '阅读统计';
    this.mode = bookId ? 'all' : 'week';
    const byDate = new Map(), byKey = new Map();
    for (const r of daily) {
      byDate.set(r.date, (byDate.get(r.date) || 0) + r.ms);
      byKey.set(r.key, r);
    }
    this.data = { daily, byDate, metas: new Map(metas.map(m => [m.id, m])) };
    this.offset = 0;
    this.render();
    Sheet.open(document.getElementById('stats-sheet'));
  },

  // The period being shown, its chart buckets, and the period before it
  period() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const o = this.offset, W = '一二三四五六日';
    if (this.mode === 'day') {
      const d = addDays(today, o);
      const buckets = [...Array(7)].map((_, i) => { const x = addDays(d, i - 6); return { from: x, to: x, label: '周' + W[(x.getDay() + 6) % 7], tip: `${x.getMonth() + 1}月${x.getDate()}日` }; });
      return { from: d, to: d, prev: [addDays(d, -1), addDays(d, -1)], buckets, focus: 6,
        title: o === 0 ? '今天' : o === -1 ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`, prevName: '前一天' };
    }
    if (this.mode === 'week') {
      const s = addDays(startOfWeek(today), o * 7), e = addDays(s, 6);
      const buckets = [...Array(7)].map((_, i) => { const x = addDays(s, i); return { from: x, to: x, label: W[i], tip: `${x.getMonth() + 1}月${x.getDate()}日` }; });
      return { from: s, to: e, prev: [addDays(s, -7), addDays(s, -1)], buckets,
        focus: o === 0 ? (today.getDay() + 6) % 7 : -1,
        title: o === 0 ? '本周' : o === -1 ? '上周' : `${s.getMonth() + 1}.${s.getDate()} – ${e.getMonth() + 1}.${e.getDate()}`, prevName: '上周' };
    }
    if (this.mode === 'month') {
      const s = new Date(today.getFullYear(), today.getMonth() + o, 1), e = new Date(s.getFullYear(), s.getMonth() + 1, 0);
      const n = e.getDate();
      const buckets = [...Array(n)].map((_, i) => { const x = new Date(s.getFullYear(), s.getMonth(), i + 1); return { from: x, to: x, label: [1, 8, 15, 22, 29].includes(i + 1) ? String(i + 1) : '', tip: `${x.getMonth() + 1}月${i + 1}日` }; });
      return { from: s, to: e, prev: [new Date(s.getFullYear(), s.getMonth() - 1, 1), new Date(s.getFullYear(), s.getMonth(), 0)], buckets,
        focus: o === 0 ? today.getDate() - 1 : -1, title: o === 0 ? '本月' : `${s.getFullYear()}年${s.getMonth() + 1}月`, prevName: '上月' };
    }
    if (this.mode === 'year') {
      const y = today.getFullYear() + o, s = new Date(y, 0, 1), e = new Date(y, 11, 31);
      const buckets = [...Array(12)].map((_, i) => ({ from: new Date(y, i, 1), to: new Date(y, i + 1, 0), label: String(i + 1), tip: `${y}年${i + 1}月` }));
      return { from: s, to: e, prev: [new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)], buckets,
        focus: o === 0 ? today.getMonth() : -1, title: o === 0 ? '今年' : `${y}年`, prevName: '去年' };
    }
    return { from: new Date(2000, 0, 1), to: today, prev: null, buckets: null, title: '全部' };
  },

  sum(from, to) {
    let t = 0;
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) t += this.data.byDate.get(ymd(d)) || 0;
    return t;
  },

  // Consecutive days with reading, ending today (or yesterday, if today hasn't started)
  streak() {
    let d = new Date(); d.setHours(0, 0, 0, 0);
    if (!this.data.byDate.get(ymd(d))) d = addDays(d, -1);
    let n = 0;
    while (this.data.byDate.get(ymd(d))) { n++; d = addDays(d, -1); }
    return n;
  },
  longestStreak() {
    const days = [...this.data.byDate.keys()].filter(k => this.data.byDate.get(k) > 0).sort();
    let best = 0, run = 0, prev = null;
    for (const k of days) {
      const d = new Date(k + 'T00:00');
      run = prev && ymd(addDays(prev, 1)) === k ? run + 1 : 1;
      best = Math.max(best, run); prev = d;
    }
    return best;
  },

  render() {
    const P = this.period(), D = this.data, all = this.mode === 'all';
    const from = ymd(P.from), to = ymd(P.to);
    const total = all ? [...D.byDate.values()].reduce((a, b) => a + b, 0) : this.sum(P.from, P.to);
    const daysRead = [...D.byDate.entries()].filter(([k, v]) => v > 0 && k >= from && k <= to).length;
    const finished = [...D.metas.values()].flatMap(m => m.finished || [])
      .filter(ts => { const k = ymd(new Date(ts)); return k >= from && k <= to; }).length;

    // Comparison with the previous period
    let compare = '';
    if (P.prev) {
      const before = this.sum(...P.prev);
      if (before > 0) {
        const pct = Math.round((total - before) / before * 100);
        compare = pct === 0 ? `和${P.prevName}持平`
          : `<span class="${pct > 0 ? 'up' : 'down'}">${pct > 0 ? '↑' : '↓'} ${Math.abs(pct)}%</span> 比${P.prevName}`;
      } else if (total > 0) compare = `${P.prevName}没有阅读`;
    }

    // Average per day over the days that have passed in this period
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const end = P.to < today ? P.to : today;
    const spanDays = Math.max(1, Math.round((end - P.from) / 864e5) + 1);
    const tiles = all
      ? [['阅读天数', daysRead + '天'], ['最长连续', this.longestStreak() + '天'], ['读完', finished + '本']]
      : this.mode === 'day'
        ? [['阅读书籍', this.ranking(from, to).length + '本'], ['连续阅读', this.streak() + '天'], ['读完', finished + '本']]
        : [['阅读天数', daysRead + '天'], ['日均', fmtDur(total / spanDays, true)], ['读完', finished + '本']];

    const el = document.getElementById('stats-sheet');
    el.querySelector('.st-tabs').innerHTML = [['day', '日'], ['week', '周'], ['month', '月'], ['year', '年'], ['all', '总']]
      .map(([k, l]) => `<button data-mode="${k}" class="${k === this.mode ? 'on' : ''}">${l}</button>`).join('');
    el.querySelector('.st-body').innerHTML = `
      <div class="st-nav">
        <button data-nav="-1" ${all ? 'disabled' : ''} aria-label="上一个">‹</button>
        <span>${P.title}</span>
        <button data-nav="1" ${all || this.offset >= 0 ? 'disabled' : ''} aria-label="下一个">›</button>
      </div>
      <div class="st-hero">
        <div class="st-total">${fmtDur(total).replace(/(\d+)/g, '<b>$1</b>')}</div>
        <div class="st-compare">${compare || '&nbsp;'}</div>
      </div>
      ${P.buckets ? this.chart(P) : ''}
      <div class="st-tiles">${tiles.map(([l, v]) => `<div><b>${v}</b><span>${l}</span></div>`).join('')}</div>
      ${this.rankHTML(from, to)}
      ${all && !this.bookId ? this.ratingHTML() : ''}`;
  },

  // How the books you've rated are spread across 1–5 stars
  ratingHTML() {
    const rated = [...this.data.metas.values()].filter(m => m.rating);
    if (!rated.length) return `<div class="st-rank-title">评分分布</div><div class="st-empty">还没有给书打过分<br><small>长按书架上的书，在书卡上点星星就能打分</small></div>`;
    const counts = [5, 4, 3, 2, 1].map(n => [n, rated.filter(m => starCount(m.rating) === n)]);
    const max = Math.max(...counts.map(([, l]) => l.length));
    const avg = rated.reduce((s, m) => s + m.rating, 0) / rated.length;
    return `
      <div class="st-rank-title">评分分布</div>
      <div class="st-rating">
        <div class="st-avg"><b>${avg.toFixed(1)}</b><span class="st-avg-stars">${'★'.repeat(Math.round(avg))}<i>${'★'.repeat(5 - Math.round(avg))}</i></span><small>${rated.length} 本已评分</small></div>
        <div class="st-dist">${counts.map(([n, list]) => `
          <div class="st-dist-row" title="${list.length ? list.map(m => bookName(m.title)).slice(0, 4).join('、') + (list.length > 4 ? ' 等' : '') : '暂无'}">
            <span>${n}★</span>
            <div class="st-dist-bar"><i style="width:${list.length / max * 100}%"></i></div>
            <em>${list.length}</em>
          </div>`).join('')}
        </div>
      </div>`;
  },

  chart(P) {
    const vals = P.buckets.map(b => this.sum(b.from, b.to));
    const max = Math.max(...vals, 1);
    const bars = vals.map((v, i) => `
      <div class="st-col${i === P.focus ? ' focus' : ''}" data-tip="${P.buckets[i].tip} · ${fmtDur(v)}">
        <div class="st-bar${v ? '' : ' zero'}" style="height:${v ? Math.max(3, v / max * 100) : 0}%"></div>
        <div class="st-x">${P.buckets[i].label}</div>
      </div>`).join('');
    return `<div class="st-chart ${P.buckets.length > 12 ? 'dense' : ''}"><div class="st-tip"></div>${bars}</div>`;
  },

  ranking(from, to) {
    const per = new Map();
    for (const r of this.data.daily) if (r.date >= from && r.date <= to) per.set(r.bookId, (per.get(r.bookId) || 0) + r.ms);
    return [...per.entries()].filter(([, ms]) => ms > 0).sort((a, b) => b[1] - a[1]);
  },

  rankHTML(from, to) {
    if (this.bookId) {                                   // one book: its read-throughs instead of a ranking
      const m = this.data.metas.get(this.bookId);
      const done = (m?.finished || []).slice().reverse();
      const detail = new Map((m?.readThroughs || []).map(r => [r.end, r]));
      const est = estimateMs(m || {});
      return `<div class="st-rank-title">读完记录</div>` + (done.length
        ? done.map((ts, i) => {
            const r = detail.get(ts);
            const sub = r ? [r.manual ? '手动标为读完' : '', r.ms ? '用时 ' + fmtDur(r.ms, true) : '', r.opens ? `打开 ${r.opens} 次` : '', r.est ? '预计 ' + fmtDur(r.est, true) : ''].filter(Boolean).join(' · ') : '';
            return `<div class="st-done"><b>第 ${done.length - i} 遍</b><span>${fmtTime(ts)}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
          }).join('')
        : `<div class="st-empty">还没有读完过${est ? `<br><small>进度到 98%，并且这一遍实际读满约 ${fmtDur(est * .4, true)} 就算读完一遍</small>` : ''}</div>`);
    }
    const list = this.ranking(from, to).slice(0, 5);
    if (!list.length) return `<div class="st-empty">这段时间还没有阅读记录</div>`;
    const top = list[0][1];
    return `<div class="st-rank-title">读得最多</div>` + list.map(([id, ms]) => {
      const m = this.data.metas.get(id);
      const title = m ? bookName(m.title) : '已删除的书';
      return `<div class="st-rank">
        ${m ? jacket(m, 'mini') : '<div class="cover mini"></div>'}
        <div class="st-rank-info">
          <div class="st-rank-name">${esc(title)}</div>
          <div class="st-rank-bar"><i style="width:${ms / top * 100}%"></i></div>
        </div>
        <div class="st-rank-time">${fmtDur(ms, true)}</div>
      </div>`;
    }).join('');
  },

  bind() {
    const el = document.getElementById('stats-sheet');
    el.querySelector('.sheet-x').onclick = () => Sheet.close(el);
    el.querySelector('.st-tabs').onclick = e => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      this.mode = b.dataset.mode; this.offset = 0; this.render();
    };
    const body = el.querySelector('.st-body');
    body.addEventListener('click', e => {
      const n = e.target.closest('[data-nav]');
      if (n && !n.disabled) { this.offset += +n.dataset.nav; this.render(); }
    });
    // Tooltip: hover on desktop, tap/drag across the bars on a phone
    const show = e => {
      const col = e.target.closest?.('.st-col');
      const tip = body.querySelector('.st-tip');
      if (!col || !tip) return;
      body.querySelectorAll('.st-col.hover').forEach(c => c.classList.remove('hover'));
      col.classList.add('hover');
      tip.textContent = col.dataset.tip;
      const chart = col.parentElement.getBoundingClientRect(), r = col.getBoundingClientRect();
      const x = Math.max(0, Math.min(chart.width - tip.offsetWidth, r.left - chart.left + r.width / 2 - tip.offsetWidth / 2));
      tip.style.transform = `translateX(${x}px)`;
      tip.classList.add('on');
    };
    body.addEventListener('pointermove', show);
    body.addEventListener('pointerdown', show);
    body.addEventListener('pointerleave', () => {
      body.querySelector('.st-tip')?.classList.remove('on');
      body.querySelectorAll('.st-col.hover').forEach(c => c.classList.remove('hover'));
    });
  },
};
