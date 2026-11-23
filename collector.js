// collector.js — the "Folio 收书" bookmark.
//
// Folio turns this file into a bookmark (a javascript: URL) with your sync token and
// inbox id filled in. Tapped on a site page, it runs there, signed in as you:
//   • on a work's page: sends that work to Folio right away
//   • on a list page: adds a checkbox to every work, then sends the ones you pick;
//     works already on your shelf that have new chapters are marked and pre-selected
//   • anywhere: "检查书架更新" looks up every unfinished work on your shelf and sends
//     the ones with new chapters
//   • on any other site: finds the e-book files the page offers for download (EPUB, TXT,
//     HTML, PDF, ZIP — e.g. a public-domain library's book page) and sends the ones you pick
// Works travel through the inbox/ folder of your own private repository (before v1.2.6: a
// secret inbox gist); Folio collects them when it opens.
// If the site does not let the page talk to GitHub, the works are copied to the
// clipboard instead, to paste into Folio.
//
// Batches survive interruptions: the list of works and which ones are already delivered
// are saved in this site's local storage after every work. If the phone reloads the page
// (iOS does this to background tabs), tapping the bookmark again offers to continue with
// only the works that are left. The screen is kept awake while a batch runs.
(async () => {
  const CFG = { token: '__TOKEN__', inbox: '__INBOX__', repo: '__REPO__', branch: '__BRANCH__', app: '__APP__', installed: '__INSTALLED__' };
  const API = CFG.repo ? 'https://api.github.com/repos/' + CFG.repo : 'https://api.github.com/gists/' + CFG.inbox;
  // The browser's own fetch, taken from a fresh frame, so a site script that replaced window.fetch
  // does not get to see the token (this narrows the risk; it cannot rule out a hostile page)
  const send = (() => {
    try {
      const f = document.createElement('iframe');
      f.style.display = 'none';
      document.documentElement.appendChild(f);
      const native = f.contentWindow.fetch.bind(f.contentWindow);
      return (url, opts) => native(url, opts);
    } catch { return (url, opts) => fetch(url, opts); }
  })();
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
      .m em { font-style: normal; font-size: 11px; color: #a0522d; background: #ece3d2; border-radius: 999px; padding: 1px 8px; margin-right: 6px; white-space: nowrap; vertical-align: 1px; }
      .r { display: flex; gap: 8px; flex-wrap: wrap; }
      button.b, a.b { flex: 1; border: 0; border-radius: 999px; padding: 9px 12px; font: inherit; font-size: 14px;
                 background: #e9e1d3; color: #2b2622; text-align: center; text-decoration: none; box-sizing: border-box; }
      a.b.a { background: #a0522d; color: #fff; }
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
  const say = (t, tag = '') => {
    const m = $('.m');
    m.textContent = '';
    const [first, ...rest] = t.split('\n');
    // The title of the work being fetched goes in front of the progress text
    if (tag) { const e = document.createElement('em'); e.textContent = tag; m.append(e); }
    m.append(first);
    if (rest.length) m.append('\n' + rest.join('\n'));
  };
  // A short form of the title: drop a leading 【tag】, keep 12 characters
  // Titles as Folio shows them: no brackets (with what is inside) at either end (ui.js, cleanTitle)
  const bareTitle = t => {
    let s = String(t || '').trim();
    const O = '【\\[(（{［｛〔〖', C = '】\\])）}］｝〕〗';
    const head = new RegExp(`^[${O}][^${O}${C}]*[${C}]\\s*`), tail = new RegExp(`\\s*[${O}][^${O}${C}]*[${C}]$`);
    for (let k = 0, m; k < 8; k++) {
      if ((m = s.match(head)) && m[0].length < s.length) { s = s.slice(m[0].length).trim(); continue; }
      if ((m = s.match(tail)) && m.index > 0) { s = s.slice(0, m.index).trim(); continue; }
      break;
    }
    return s || String(t || '').trim();
  };
  const shortTitle = t => {
    const s = bareTitle(t);
    const c = Array.from(s);
    return c.length > 12 ? c.slice(0, 12).join('') + '…' : s;
  };
  const progress = (i, n) => { $('.bar').style.display = n ? 'block' : 'none'; $('.bar i').style.width = n ? (i / n * 100) + '%' : 0; };
  const buttons = list => {
    $('.r').innerHTML = '';
    for (const [label, fn, accent] of list) {
      // A string instead of a function makes a real link: the tap itself opens it, which is what
      // browsers require before they hand a link to an installed app or to another app
      const link = typeof fn === 'string', b = document.createElement(link ? 'a' : 'button');
      b.className = 'b' + (accent ? ' a' : '');
      b.textContent = label;
      if (link) { b.href = fn; if (/^https?:/.test(fn)) { b.target = '_blank'; b.rel = 'noopener'; } b.onclick = () => setTimeout(() => window.__folio?.close(), 400); }
      else b.onclick = fn;
      $('.r').appendChild(b);
    }
  };
  // "打开 Folio" after delivery. What can really open the installed app differs by platform:
  //  • Computer / Android, bookmark copied from the installed Folio window: a web+folio:// link. Folio's
  //    manifest declares it (protocol_handlers); Chrome and Edge register it with the system when Folio
  //    is installed, so the tap opens the Folio app window (the browser may ask once to allow it).
  //    "在浏览器打开" stays as the second button for when that is not set up.
  //  • Computer / Android otherwise: a link to Folio's own address. Chrome 139+ opens such a link in
  //    the installed app when there is one (navigation capturing); otherwise in a tab of the same
  //    browser, with the same books.
  //  • iPhone: Safari cannot open a home-screen web app, and Folio in a Safari tab keeps a separate,
  //    empty shelf, so the panel says to go back to Folio, which collects the new works by itself as
  //    soon as it comes to the front (and a 收书 notification, if turned on, opens it with one tap).
  // The marker (#from=collect / ?open=) makes Folio collect the inbox at once.
  const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const APP = /^https?:\/\//.test(CFG.app) ? CFG.app : '';
  let lastArrived = null;                            // the last work of the current batch that reached the inbox
  const openButtons = () => {
    if (IOS) return null;
    if (!APP) return null;
    const book = lastArrived ? `book=${encodeURIComponent(lastArrived.id)}&t=${encodeURIComponent(lastArrived.title.slice(0, 80))}` : '';
    const web = APP + '#from=collect' + (book ? '&' + book : '');
    return CFG.installed === 'yes' ? [['打开 Folio', 'web+folio://collect' + (book ? '?' + book : ''), true], ['在浏览器打开', web]] : [['打开 Folio', web, true], ['好', () => window.__folio.close()]];
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
  async function api(method, body, path = '', accept = 'application/vnd.github+json') {
    const r = await send(API + path, {
      method, body: body && JSON.stringify(body), cache: 'no-store',
      headers: { Authorization: 'Bearer ' + CFG.token, Accept: accept },
    });
    if (r.status === 401) throw new Error('令牌失效了，请在 Folio 里重新生成书签');
    if (!r.ok) { const e = new Error('收件箱出错 ' + r.status); e.status = r.status; throw e; }
    return accept.includes('raw') ? r.text() : r.json();
  }
  const utf8b64 = text => { const b = new TextEncoder().encode(text); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
  // Repository inbox: a work's page is one file (one request); an e-book file goes in as itself,
  // with what its page said about it beside it, both in one commit
  async function putRepo(w) {
    if (!w.b64) {
      const path = `/contents/inbox/in-${w.id}.html`, body = { message: 'inbox: ' + w.id, content: utf8b64(w.html), branch: CFG.branch };
      for (let i = 0; i < 3; i++) {
        try { return await api('PUT', body, path); } catch (e) {
          if (e.status === 422) {                      // sent before and not collected yet: replace it
            try { body.sha = (await api('GET', null, path + '?ref=' + CFG.branch)).sha; } catch { /* gone meanwhile */ }
          } else if (e.status !== 409) throw e;          // 409: the repository moved on during the write
          await sleep(800);
        }
      }
      throw new Error('收件箱一直在被改动，稍后再试');
    }
    const name = `inbox/in-${w.id}.${w.ext}`;
    const file = await api('POST', { content: w.b64, encoding: 'base64' }, '/git/blobs');
    const info = await api('POST', { content: JSON.stringify({ name: w.name, meta: w.meta || null }), encoding: 'utf-8' }, '/git/blobs');
    for (let i = 0; i < 4; i++) {
      const ref = await api('GET', null, '/git/ref/heads/' + CFG.branch);
      const base = await api('GET', null, '/git/commits/' + ref.object.sha);
      const tree = await api('POST', { base_tree: base.tree.sha, tree: [
        { path: name, mode: '100644', type: 'blob', sha: file.sha },
        { path: name + '.meta.json', mode: '100644', type: 'blob', sha: info.sha }] }, '/git/trees');
      const c = await api('POST', { message: 'inbox: ' + w.id, tree: tree.sha, parents: [ref.object.sha] }, '/git/commits');
      try { return await api('PATCH', { sha: c.sha, force: false }, '/git/refs/heads/' + CFG.branch); }
      catch (e) { if (e.status !== 422 && e.status !== 409) throw e; await sleep(800); }
    }
    throw new Error('收件箱一直在被改动，稍后再试');
  }
  // Returns true when the work reached the inbox, false when it is held for the clipboard
  async function deliver(w) {
    if (!blocked) {
      try {
        if (CFG.repo) { await putRepo(w); return true; }
        const file = w.b64 ? `in-${w.id}.${w.ext}.b64` : `in-${w.id}.html`;              // one file per work: never twice
        // A file: one line of JSON (file name and what the page says about the book), then the file
        const head = JSON.stringify({ name: w.name, meta: w.meta || null });
        await api('PATCH', { files: { [file]: { content: w.b64 ? head + '\n' + w.b64 : w.html } } });
        return true;
      } catch (e) {
        if (!(e?.name === 'TypeError')) throw e;      // TypeError = the request never left the page
        blocked = true;
      }
    }
    held.push(w.b64 ? { id: w.id, name: w.name, meta: w.meta, b64: w.b64 } : { id: w.id, html: w.html });
    return false;
  }
  let shelf = null;
  async function readShelf() {
    if (shelf) return shelf;
    try {
      let txt;
      if (CFG.repo) {
        try { txt = await api('GET', null, `/contents/inbox/library.json?ref=${CFG.branch}`, 'application/vnd.github.raw+json'); }
        catch (e) { if (e.status === 404) txt = '[]'; else throw e; }
      } else {
        const g = await api('GET');
        const f = g.files['library.json'];
        txt = !f ? '[]' : f.truncated ? await (await send(f.raw_url)).text() : f.content;
      }
      shelf = JSON.parse(txt);
    } catch (e) {
      if (e?.name === 'TypeError') blocked = true; else throw e;
      shelf = [];
    }
    return shelf;
  }
  // One notification per batch (push.js / folio-push.yml): once every work of the batch has been
  // handled and each delivery is already committed to the repository, tell the repository how many
  // were written and how many failed. Only when a device has turned notifications on (the file
  // push/subscription.json exists) and at least one work arrived. Uses the same token (Contents:
  // read and write); any problem here is ignored, so collecting never depends on it.
  // `last`: the last work of the batch that arrived ({ id, title }); Folio opens its card
  // The last work of the batch, left in the repository (inbox/arrived.json) so Folio opens it however
  // it is brought up next: the notification, the 打开 Folio button or switching back by hand
  async function markArrival(last) {
    const path = '/contents/inbox/arrived.json';
    const body = { message: 'inbox: arrived', branch: CFG.branch,
      content: utf8b64(JSON.stringify({ id: String(last.id), title: String(last.title || '').slice(0, 80), at: Date.now() })) };
    for (let i = 0; i < 3; i++) {
      try { await api('PUT', body, path); return; } catch (e) {
        if (e.status !== 422 && e.status !== 409) return;  // 422: the file is there (its sha is needed); 409: it changed meanwhile
        try { body.sha = (await api('GET', null, path + '?ref=' + CFG.branch)).sha; } catch { return; }
      }
    }
  }
  // One notification per batch: a repository_dispatch event; the repository's workflow
  // (folio-push.yml) sends it to every device that turned notifications on (push/subscription*.json)
  async function notifyBatch(ok, failed, titles, last) {
    if (!CFG.repo || !ok || blocked) return;
    if (last) await markArrival(last).catch(() => {});
    try {
      const t = new AbortController(); setTimeout(() => t.abort(), 6000);
      const has = await send(API + `/contents/push?ref=${CFG.branch}`, { cache: 'no-store', signal: t.signal,
        headers: { Authorization: 'Bearer ' + CFG.token, Accept: 'application/vnd.github+json' } });
      if (!has.ok || !(await has.json()).some?.(f => /^subscription[^/]*\.json$/.test(f.name))) return;
      await send(API + '/dispatches', { method: 'POST', signal: t.signal, headers: { Authorization: 'Bearer ' + CFG.token, Accept: 'application/vnd.github+json' },
        body: JSON.stringify({ event_type: 'folio-collected', client_payload: { ok, failed, titles: titles.slice(0, 3), last: last || null, at: Date.now() } }) });
    } catch { /* no notification this time; the works are in the inbox all the same */ }
  }
  function finish(n, extra = '') {
    progress(0, 0);
    if (held.length) {
      say(`已抓好 ${held.length} 篇，但没能连到 GitHub（网络不稳，或这个网站不让页面连出去）。\n网络恢复后再点一次书签就能接着送；也可以点「复制」，再去 Folio 里「粘贴剪贴板里的作品」。${extra}`);
      buttons([['复制', async () => {
        await navigator.clipboard.writeText(JSON.stringify({ app: 'folio-bundle', items: held.map(h => h.b64 ? { name: h.name, meta: h.meta, b64: h.b64 } : { html: h.html }) }));
        const job = loadJob();
        if (job) { job.done.push(...held.map(h => h.id)); job.done.length >= job.ids.length ? saveJob(null) : saveJob(job); }
        say('已复制，打开 Folio 粘贴吧');
      }, true], ['关闭', () => window.__folio.close()]]);
    } else {
      const open = n ? openButtons() : null;
      // Sent is not shelved: Folio takes the works in when it opens (and opens the last one, within 15 minutes)
      const how = IOS ? '切回主屏幕的 Folio，会马上收进书架，并打开最后一本。'
        : open ? '点「打开 Folio」，会马上收进书架，并打开最后一本。' : '打开 Folio 时会收进书架，并打开最后一本。';
      say(n ? `已送出 ✓ 共 ${n} 篇\n${how}${extra}` : '没有需要送的作品。' + extra);
      buttons(open || [['好', () => window.__folio.close(), true]]);
    }
  }
  // Send a batch; `job` is the saved record, so a reload can pick up where this stopped
  async function sendAll(ids, job = { ids: [...new Set(ids)], done: [], failed: {}, at: Date.now() }) {
    saveJob(job);
    keepAwake(true);
    buttons([]);
    const total = job.ids.length;
    let sent = 0;
    const arrived = [];
    lastArrived = null;
    for (const id of job.ids) {
      if (job.done.includes(id)) continue;
      const n = job.done.length + Object.keys(job.failed).length + 1;
      const hint = '\n请保持这个页面打开。如果页面被刷新，再点一次书签就能接着送。';
      // On a list page the title is already on screen; otherwise it appears once the work is opened
      let known = '';
      try { known = shortTitle(blurbs.find(b => b.id === id)?.li.querySelector('h4.heading a[href*="/works/"]')?.textContent); } catch { /* not a list page */ }
      say(`正在抓取 ${Math.min(n, total)} / ${total}${known ? '' : ' …'}` + hint, known);
      progress(n - 1, total);
      try {
        const work = await fetchWork(id);
        say(`正在抓取 ${Math.min(n, total)} / ${total}` + hint, shortTitle(work.title));
        if (await deliver(work)) { job.done.push(id); sent++; arrived.push(shortTitle(work.title)); lastArrived = { id, title: bareTitle(work.title) }; }
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
    // This batch: every work now in the inbox (also those an interrupted earlier run delivered), and
    // every work that did not get there (could not be fetched, or held because GitHub was unreachable)
    await notifyBatch(job.done.length, failed.length + held.length, arrived, lastArrived);
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
  } else if (fileLinks().length) {
    pickFiles(fileLinks());
  } else {
    say('这一页没有可以收的作品或电子书文件。可以检查书架上连载的更新。');
    buttons([['检查书架更新', checkShelf, true]]);
  }

  // ---------- e-book files offered on the page ----------
  // Links whose address ends in an e-book format (also the "book.epub3.images" style some
  // libraries use). Each file is downloaded with this page's own access and sent as-is.
  function fileLinks() {
    const seen = new Set(), out = [];
    for (const a of document.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      const m = url.pathname.toLowerCase().match(/\.(epub|txt|html?|pdf|zip)(?:[.\d\w-]*)$/) || url.pathname.toLowerCase().match(/\.(epub)\d?\.(?:images|noimages)$/);
      if (!m || !/^https?:$/.test(url.protocol) || seen.has(url.href)) continue;
      if (m[1].startsWith('htm') && !/download|下载/i.test(a.textContent + a.getAttribute('download'))) continue;   // ordinary page links are not books
      seen.add(url.href);
      out.push({ url: url.href, ext: m[1].replace('htm', 'html').replace('htmll', 'html'), label: (a.textContent || '').replace(/\s+/g, ' ').trim() || url.pathname.split('/').pop() });
    }
    return out;
  }
  // What the page says about the book, from the common ways sites describe one: schema.org
  // data (JSON-LD or itemprop), Open Graph / book meta tags, then plain page elements
  function pageMeta() {
    const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
    const meta = sel => clean(document.querySelector(sel)?.getAttribute('content'));
    let ld = {};
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const all = [].concat(JSON.parse(s.textContent)).flatMap(x => x['@graph'] || [x]);
        const b = all.find(x => /Book|CreativeWork|Novel/.test([].concat(x['@type']).join(' ')));
        if (b) { ld = b; break; }
      } catch { /* not JSON */ }
    }
    const names = v => [].concat(v || []).map(a => clean(typeof a === 'string' ? a : a?.name)).filter(Boolean);
    const authors = names(ld.author).length ? names(ld.author)
      : [...document.querySelectorAll('[itemprop="author"], [itemprop="creator"], a[rel="author"]')].map(e => clean(e.getAttribute('content') || e.textContent)).filter(Boolean).slice(0, 4);
    const fallbackAuthor = meta('meta[name="author"]') || meta('meta[property="book:author"]') || meta('meta[property="og:book:author"]');
    const image = [].concat(ld.image || [])[0];
    const cover = (typeof image === 'string' ? image : image?.url) || meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]')
      || document.querySelector('[itemprop="image"]')?.getAttribute('src') || document.querySelector('img[class*="cover" i]')?.getAttribute('src') || '';
    return {
      title: clean(ld.name) || meta('meta[property="og:title"]') || clean(document.querySelector('[itemprop="name"]')?.textContent) || clean(document.querySelector('h1')?.textContent) || clean(document.title),
      authors: authors.length ? [...new Set(authors)] : fallbackAuthor ? [fallbackAuthor] : [],
      summary: clean(ld.description) || meta('meta[property="og:description"]') || meta('meta[name="description"]') || clean(document.querySelector('[itemprop="description"]')?.textContent),
      cover: cover ? new URL(cover, location.href).href : '',
      url: location.href.split('#')[0],
    };
  }
  // The cover picture, if this page is allowed to read it (most sites serve their own images)
  async function coverData(url) {
    if (!url) return '';
    try {
      const r = await fetch(url, { credentials: 'include' });
      if (!r.ok || !/^image\//.test(r.headers.get('content-type') || '')) return '';
      const blob = await r.blob();
      if (blob.size > 1.5 * 1048576) return '';
      return await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(''); fr.readAsDataURL(blob); });
    } catch { return ''; }
  }

  function pickFiles(list) {
    const info = pageMeta();
    const title = info.title.slice(0, 80);
    // One copy of the book is enough: EPUB first, then TXT, then the rest
    const order = ['epub', 'txt', 'html', 'pdf', 'zip'];
    const first = [...list].sort((a, b) => order.indexOf(a.ext) - order.indexOf(b.ext))[0];
    const picked = new Set([first.url]);
    const draw = () => {
      say(`${title.slice(0, 24)}${info.authors.length ? ' · ' + info.authors.join('、').slice(0, 20) : ''}\n这一页有 ${list.length} 个电子书文件，选要送到 Folio 的：\n` + list.map((f, i) => `${picked.has(f.url) ? '☑' : '☐'} ${i + 1}. ${f.ext.toUpperCase()} · ${f.label.slice(0, 30)}`).join('\n'));
      buttons([
        ...list.slice(0, 6).map((f, i) => [`${picked.has(f.url) ? '✓ ' : ''}${i + 1}`, () => { picked.has(f.url) ? picked.delete(f.url) : picked.add(f.url); draw(); }]),
        [`送出 ${picked.size} 个`, () => picked.size && sendFiles(list.filter(f => picked.has(f.url)), title, info), true],
      ]);
    };
    draw();
  }
  async function sendFiles(files, title, info = {}) {
    buttons([]);
    keepAwake(true);
    const meta = { ...info, cover: await coverData(info.cover) };
    let sent = 0;
    const errors = [], names = [];
    lastArrived = null;
    for (const [i, f] of files.entries()) {
      say(`正在下载 ${i + 1} / ${files.length}：${title}（${f.ext.toUpperCase()}）…`);
      progress(i, files.length);
      try {
        const r = await fetch(f.url, { credentials: 'include' });
        if (!r.ok) throw new Error('下载失败 ' + r.status);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length > 20 * 1048576) throw new Error('文件超过 20 MB，请下载后在 Folio 里导入');
        let bin = '';
        for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
        let h = 0x811c9dc5;
        for (const c of f.url) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); }
        const name = (title || 'book').replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60) + '.' + f.ext;
        if (await deliver({ id: 'f' + (h >>> 0).toString(36), ext: f.ext, name, meta, b64: btoa(bin) })) { sent++; names.push(name.replace(/\.\w+$/, '')); lastArrived = { id: 'f' + (h >>> 0).toString(36), title: (title || '').slice(0, 80) }; }
      } catch (e) {
        errors.push(e?.name === 'TypeError' ? '这个网站不允许页面下载这个文件（下载地址在别的网站上），请手动下载后导入' : e.message);
      }
    }
    keepAwake(false);
    await notifyBatch(sent, errors.length + held.length, names, lastArrived);
    finish(sent, errors.length ? `\n${errors.length} 个失败：${errors[0]}` : '');
  }
})().catch(e => alert('Folio 收书出错：' + e.message));
