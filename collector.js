// collector.js — the "Folio 收书" bookmark.
//
// Folio turns this file into a bookmark (a javascript: URL) with your sync token and
// inbox id filled in. Tapped on a site page, it runs there, signed in as you:
//   • on a work's page: sends that work to Folio right away
//   • on a list page: adds a checkbox to every work, then sends the ones you pick;
//     works already on your shelf that have new chapters are marked and pre-selected
//   • anywhere: "检查书架更新" looks up every unfinished work on your shelf and sends
//     the ones with new chapters
// Works travel through your own secret inbox gist; Folio collects them when it opens.
// If the site does not let the page talk to GitHub, the works are copied to the
// clipboard instead, to paste into Folio.
//
// Batches survive interruptions: the list of works and which ones are already delivered
// are saved in this site's local storage after every work. If the phone reloads the page
// (iOS does this to background tabs), tapping the bookmark again offers to continue with
// only the works that are left. The screen is kept awake while a batch runs.
(async () => {
  const CFG = { token: '__TOKEN__', inbox: '__INBOX__' };
  const API = 'https://api.github.com/gists/' + CFG.inbox;
  const WAIT = 2500;                                  // pause between page loads, to be polite to the site
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const workId = href => ((href || '').match(/\/works\/(\d+)/) || [])[1];
  const abs = href => new URL(href, location.href).href;

  if (window.__folio) window.__folio.close();

  // ---------- panel (shadow DOM keeps the site's styles out) ----------
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      .p { margin: 0 auto 12px; max-width: 440px; width: calc(100% - 24px); box-sizing: border-box;
           background: #f6f1e7; color: #2b2622; border-radius: 18px; padding: 14px 16px 12px;
           font: 15px/1.5 "Songti SC", "STSong", "Noto Serif SC", serif; box-shadow: 0 10px 40px rgba(0,0,0,.28);
           animation: up .35s cubic-bezier(.32,.72,0,1); }
      @keyframes up { from { transform: translateY(30px); opacity: 0 } }
      .h { display: flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: .12em; }
      .h i { flex: 1 }
      .x { border: 0; background: none; font-size: 20px; color: #8a8178; padding: 0 4px; }
      .m { color: #6f665d; font-size: 13px; margin: 6px 0 10px; min-height: 1.5em; white-space: pre-line; }
      .r { display: flex; gap: 8px; flex-wrap: wrap; }
      button.b { flex: 1; border: 0; border-radius: 999px; padding: 9px 12px; font: inherit; font-size: 14px;
                 background: #e9e1d3; color: #2b2622; }
      button.b.a { background: #a0522d; color: #fff; }
      button.b:disabled { opacity: .45 }
      .bar { height: 3px; background: #e9e1d3; border-radius: 2px; overflow: hidden; margin-bottom: 10px; display: none; }
      .bar i { display: block; height: 100%; width: 0; background: #a0522d; transition: width .3s; }
    </style>
    <div class="p">
      <div class="h">Folio 收书<i></i><button class="x" title="关闭">×</button></div>
      <div class="m"></div>
      <div class="bar"><i></i></div>
      <div class="r"></div>
    </div>`;
  document.body.appendChild(host);
  const $ = s => shadow.querySelector(s);
  const say = t => { $('.m').textContent = t; };
  const progress = (i, n) => { $('.bar').style.display = n ? 'block' : 'none'; $('.bar i').style.width = n ? (i / n * 100) + '%' : 0; };
  const buttons = list => {
    $('.r').innerHTML = '';
    for (const [label, fn, accent] of list) {
      const b = document.createElement('button');
      b.className = 'b' + (accent ? ' a' : '');
      b.textContent = label;
      b.onclick = fn;
      $('.r').appendChild(b);
    }
  };
  const marks = [];
  window.__folio = { close() { host.remove(); marks.forEach(m => m.remove()); delete window.__folio; } };
  $('.x').onclick = () => window.__folio.close();

  // ---------- fetching a whole work ----------
  const getDoc = async url => {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('打开失败 ' + r.status);
    const html = await r.text();
    return { html, doc: new DOMParser().parseFromString(html, 'text/html') };
  };
  // Start from the work's first page; pass a content notice if one is shown, then
  // follow the page's own link to the whole work (all chapters on one page).
  async function fetchWork(id) {
    let page = await getDoc(location.origin + '/works/' + id), wholeDone = false;
    for (let hop = 0; hop < 4; hop++) {
      const d = page.doc;
      if (!d.querySelector('#chapters')) {
        const go = [...d.querySelectorAll('a[href]')].find(a => /\?/.test(a.getAttribute('href')) && workId(a.getAttribute('href')) === id);
        if (!go) throw new Error('打不开这篇（可能需要登录）');
        page = await getDoc(abs(go.getAttribute('href')));
        continue;
      }
      const whole = d.querySelector('.chapter.entire a[href]');
      if (whole && !wholeDone) { wholeDone = true; await sleep(800); page = await getDoc(abs(whole.getAttribute('href'))); continue; }
      break;
    }
    const title = page.doc.querySelector('.preface h2.title')?.textContent.trim() || '作品 ' + id;
    return { id, title, html: `<meta name="folio-source" content="${location.origin}/works/${id}">` + page.html };
  }

  // ---------- inbox ----------
  // ---------- the saved batch ----------
  const JOB = 'folio-collect-job';
  const loadJob = () => { try { return JSON.parse(localStorage.getItem(JOB)); } catch { return null; } };
  const saveJob = j => { try { j ? localStorage.setItem(JOB, JSON.stringify(j)) : localStorage.removeItem(JOB); } catch { /* storage full or blocked */ } };
  let lock = null;
  const keepAwake = async on => {
    try {
      if (on && !lock && navigator.wakeLock) { lock = await navigator.wakeLock.request('screen'); lock.onrelease = () => { lock = null; }; }
      if (!on && lock) { await lock.release(); lock = null; }
    } catch { lock = null; }
  };
  // The lock is dropped whenever the page is hidden; take it again on return
  document.addEventListener('visibilitychange', () => { if (!document.hidden && loadJob()) keepAwake(true); });

  let blocked = false;
  const held = [];                                   // works kept for the clipboard when GitHub is unreachable
  async function api(method, body) {
    const r = await fetch(API, {
      method, body: body && JSON.stringify(body),
      headers: { Authorization: 'Bearer ' + CFG.token, Accept: 'application/vnd.github+json' },
    });
    if (r.status === 401) throw new Error('令牌失效了，请在 Folio 里重新生成书签');
    if (!r.ok) throw new Error('收件箱出错 ' + r.status);
    return r.json();
  }
  // Returns true when the work reached the inbox, false when it is held for the clipboard
  async function deliver(w) {
    if (!blocked) {
      try {
        await api('PATCH', { files: { [`in-${w.id}.html`]: { content: w.html } } });   // one file per work: never twice
        return true;
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;      // TypeError = the request never left the page
        blocked = true;
      }
    }
    held.push({ id: w.id, html: w.html });
    return false;
  }
  let shelf = null;
  async function readShelf() {
    if (shelf) return shelf;
    try {
      const g = await api('GET');
      const f = g.files['library.json'];
      const txt = !f ? '[]' : f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
      shelf = JSON.parse(txt);
    } catch (e) {
      if (e instanceof TypeError) blocked = true; else throw e;
      shelf = [];
    }
    return shelf;
  }
  function finish(n, extra = '') {
    progress(0, 0);
    if (held.length) {
      say(`已抓好 ${held.length} 篇。这个网站不让页面直接连到 GitHub，\n点「复制」，再去 Folio 里「粘贴剪贴板里的作品」。${extra}`);
      buttons([['复制', async () => {
        await navigator.clipboard.writeText(JSON.stringify({ app: 'folio-bundle', items: held.map(h => ({ html: h.html })) }));
        const job = loadJob();
        if (job) { job.done.push(...held.map(h => h.id)); job.done.length >= job.ids.length ? saveJob(null) : saveJob(job); }
        say('已复制，打开 Folio 粘贴吧');
      }, true], ['关闭', () => window.__folio.close()]]);
    } else {
      say(n ? `已送到 Folio ✓ 共 ${n} 篇\n打开 Folio 就能看到。${extra}` : '没有需要送的作品。' + extra);
      buttons([['好', () => window.__folio.close(), true]]);
    }
  }
  // Send a batch; `job` is the saved record, so a reload can pick up where this stopped
  async function sendAll(ids, job = { ids: [...new Set(ids)], done: [], failed: {}, at: Date.now() }) {
    saveJob(job);
    keepAwake(true);
    buttons([]);
    const total = job.ids.length;
    let sent = 0;
    for (const id of job.ids) {
      if (job.done.includes(id)) continue;
      const n = job.done.length + Object.keys(job.failed).length + 1;
      say(`正在抓取 ${Math.min(n, total)} / ${total} …\n请保持这个页面打开。如果页面被刷新，再点一次书签就能接着送。`);
      progress(n - 1, total);
      try {
        if (await deliver(await fetchWork(id))) { job.done.push(id); sent++; }
        delete job.failed[id];
      } catch (e) {
        job.failed[id] = e.message;
      }
      saveJob(job);
      await sleep(WAIT);
    }
    keepAwake(false);
    const failed = Object.keys(job.failed);
    if (!held.length) saveJob(failed.length ? { ...job, ids: failed, done: [], failed: job.failed } : null);
    const already = total - sent - failed.length - held.length;
    finish(sent, (already > 0 ? `\n（其中 ${already} 篇之前已经送过）` : '')
      + (failed.length ? `\n${failed.length} 篇失败：${job.failed[failed[0]]}。再点一次书签可以重试。` : ''));
  }

  // ---------- update check ----------
  const countOf = text => parseInt((text || '').split('/')[0].replace(/\D/g, '')) || 0;
  async function checkShelf() {
    buttons([]);
    say('正在读取书架…');
    const list = (await readShelf()).filter(b => !b.done);
    if (!list.length) return finish(0, '\n书架上没有连载中的作品。');
    const found = [];
    for (let i = 0; i < list.length; i++) {
      say(`检查连载 ${i + 1} / ${list.length}　发现 ${found.length} 篇有更新`);
      progress(i, list.length);
      try {
        const { doc } = await getDoc(location.origin + '/works/' + list[i].w);
        const n = countOf(doc.querySelector('dl.stats dd.chapters')?.textContent);
        if (n > list[i].c) found.push(list[i].w);
      } catch { /* skip this one */ }
      await sleep(WAIT);
    }
    if (!found.length) return finish(0, '\n所有连载都是最新的。');
    await sendAll(found);
  }

  // ---------- what kind of page is this? ----------
  const here = workId(location.pathname);
  const blurbs = [...document.querySelectorAll('li.blurb')]
    .map(li => ({ li, id: workId(li.querySelector('h4.heading a[href*="/works/"]')?.getAttribute('href')) }))
    .filter(b => b.id);

  const pending = loadJob();
  const left = pending ? pending.ids.filter(id => !pending.done.includes(id)) : [];
  if (left.length && Date.now() - pending.at < 3 * 864e5) {
    // An unfinished batch from before (the page was reloaded or closed): offer to continue
    const failedOnly = left.every(id => pending.failed?.[id]);
    say(failedOnly ? `上次有 ${left.length} 篇没送成功，要重试吗？`
      : `上次的批量收书还有 ${left.length} 篇没送完（已送 ${pending.done.length} 篇），要继续吗？`);
    buttons([
      ['放弃', () => { saveJob(null); window.__folio.close(); }],
      [failedOnly ? '重试' : '继续', () => sendAll(left, { ...pending, failed: {} }), true],
    ]);
  } else if (here) {
    // A work: send it straight away
    sendAll([here]);
  } else if (blurbs.length) {
    // A list: checkboxes on every work
    const lib = await readShelf();
    const known = new Map(lib.map(b => [b.w, b]));
    const picked = new Set();
    const update = () => {
      say(`已选 ${picked.size} 篇　（书架上有新章节的已帮你勾上）`);
      buttons([
        [picked.size === blurbs.length ? '全不选' : '全选', () => {
          const all = picked.size !== blurbs.length;
          blurbs.forEach(b => { b.box.checked = all; all ? picked.add(b.id) : picked.delete(b.id); });
          update();
        }],
        ['查更新', checkShelf],
        [`送出 ${picked.size} 篇`, () => picked.size && sendAll([...picked]), true],
      ]);
    };
    for (const b of blurbs) {
      const tag = document.createElement('label');
      tag.style.cssText = 'position:absolute;top:8px;right:8px;z-index:10;display:flex;align-items:center;gap:6px;'
        + 'background:#f6f1e7;color:#2b2622;border-radius:999px;padding:4px 10px;font:13px/1.4 serif;box-shadow:0 2px 8px rgba(0,0,0,.18)';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.style.cssText = 'width:18px;height:18px;accent-color:#a0522d;margin:0';
      const mine = known.get(b.id), now = countOf(b.li.querySelector('dd.chapters')?.textContent);
      const note = document.createElement('span');
      if (mine) note.textContent = now > mine.c ? `书架上 · 新 +${now - mine.c} 章` : '书架上';
      tag.append(box, note);
      if (getComputedStyle(b.li).position === 'static') b.li.style.position = 'relative';
      b.li.appendChild(tag);
      marks.push(tag);
      b.box = box;
      if (mine && now > mine.c) { box.checked = true; picked.add(b.id); }
      box.onchange = () => { box.checked ? picked.add(b.id) : picked.delete(b.id); update(); };
    }
    update();
  } else {
    say('这一页没有作品。可以检查书架上连载的更新。');
    buttons([['检查书架更新', checkShelf, true]]);
  }
})().catch(e => alert('Folio 收书出错：' + e.message));
