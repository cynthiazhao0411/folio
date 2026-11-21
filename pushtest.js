// pushtest.js — TEMPORARY prototype: verify Web Push on the iPhone Home Screen app.
//
// Not part of collecting, syncing or backups. It only:
//   1. asks for notification permission (from a tap, as iOS requires) and subscribes this device,
//      with a VAPID key pair made here; the public key and the subscription are saved to
//      push/subscription.json in the private repository (the existing token, Contents: read/write);
//      the private key is shown once, to be pasted into the repository's Actions secret
//      FOLIO_VAPID_PRIVATE_KEY, and is never stored by Folio or written to any repository;
//   2. sends a test: a repository_dispatch event (type folio-push-test, same token) that runs the
//      manual-only workflow push-test/folio-push-test.yml, which signs and sends the notification;
//   3. records how Folio was opened from a notification, so the test can be read off the phone.
// Notification tap: the payload is Declarative Web Push (iOS 18.4+ opens `navigate` by itself);
// sw.js shows the same notification for older systems and focuses or opens Folio on a tap.
const PushTest = {
  FILE: 'push/subscription.json',
  LOG: 'folio-push-log',

  supported() {
    return { sw: 'serviceWorker' in navigator, push: 'PushManager' in window, notif: 'Notification' in window,
      standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true };
  },
  log() { try { return JSON.parse(localStorage.getItem(this.LOG)) || []; } catch { return []; } },
  note(entry) {
    const l = [{ t: Date.now(), ...entry }, ...this.log()].slice(0, 8);
    try { localStorage.setItem(this.LOG, JSON.stringify(l)); } catch {}
  },

  // Called by app.js when Folio is opened or brought forward from a notification
  async arrived(how) {
    this.note({ how, standalone: this.supported().standalone });
    try {
      if (Sync.on) await Sync.check(true);
      this.note({ how: 'sync', ok: !Sync.st.error, msg: Sync.st.error || '已同步' });
    } catch (e) { this.note({ how: 'sync', ok: false, msg: e.message }); }
  },

  async sub() { const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); },

  async open() {
    const s = this.supported(), sub = s.push && s.sw ? await this.sub().catch(() => null) : null;
    const perm = s.notif ? Notification.permission : '不支持';
    const fmt = t => new Date(t).toLocaleString('zh-CN', { hour12: false });
    const HOW = { url: '点通知打开（新启动）', focus: '点通知切回（已在后台）', sync: '自动同步', sent: '请求发送测试通知' };
    const rows = this.log().map(e => `<li>${fmt(e.t)} · ${HOW[e.how] || e.how}${e.how === 'sync' ? '：' + esc(e.msg) : e.how === 'sent' ? '' : e.standalone ? ' · 在主屏幕 App 里 ✓' : ' · <b>不是主屏幕 App</b>'}</li>`).join('');
    const sheet = quickSheet(`
      <div class="pk-title">通知测试（临时）<small>只用来验证 iPhone 能否收到推送，不影响收书和同步</small></div>
      <div class="sheet-scroll">
      <p class="sync-note">运行方式：${s.standalone ? '主屏幕 App ✓' : '<b>浏览器网页</b>（iPhone 上要从主屏幕的 Folio 打开才能开启通知）'}<br>
        推送支持：${s.push && s.sw ? '✓' : '✗ 这里不支持 Web Push'} · 通知权限：${esc(perm === 'granted' ? '已允许' : perm === 'denied' ? '已拒绝（要到 iPhone 设置 → 通知 → Folio 里打开）' : perm === 'default' ? '还没问过' : perm)}<br>
        本机订阅：${sub ? '已注册 ✓' : '没有'}</p>
      <div class="pk-list">
        <button class="pk-row strong" data-a="on"><span>${sub ? '重新开启通知' : '开启通知'}</span><small>${sub ? '会换一对新密钥，要重新填一次私钥' : '允许通知，并把本机登记到私有仓库'}</small></button>
        <button class="pk-row" data-a="send"${sub ? '' : ' disabled'}><span>发送测试通知</span><small>点完锁屏或退出 Folio，等通知</small></button>
        <button class="pk-row muted" data-a="off"${sub ? '' : ' disabled'}><span>关闭通知</span><small>取消本机订阅，删除仓库里的订阅文件</small></button>
      </div>
      ${rows ? `<p class="sync-note">最近记录：</p><ul class="bm-steps">${rows}</ul>` : ''}
      </div>`);
    sheet.card.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      if (a === 'on') return this.enable(sheet);              // the permission request must come from this tap
      await sheet.close();
      if (a === 'send') this.send();
      if (a === 'off') this.disable();
    };
  },

  async enable(sheet) {
    const s = this.supported();
    if (!s.push || !s.sw || !s.notif) return toast('这里不支持 Web Push');
    if (!Sync.repoMode) return toast('需要先连上私有仓库');
    // First thing in the tap: iOS only shows the prompt in response to the user's action
    const perm = await Notification.requestPermission();
    await sheet.close();
    if (perm !== 'granted') return toast(perm === 'denied' ? '通知被拒绝了：到 iPhone 设置 → 通知 → Folio 里打开' : '没有允许通知');
    try {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const pub = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
      const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
      const reg = await navigator.serviceWorker.ready;
      await (await reg.pushManager.getSubscription())?.unsubscribe();   // a new key needs a new subscription
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pub });
      const j = sub.toJSON();
      const text = JSON.stringify({ endpoint: j.endpoint, keys: j.keys, vapidPublic: pub,
        subject: location.origin.startsWith('https:') ? location.origin : 'mailto:folio@example.invalid',
        app: new URL('./', location.href).href, device: Sync.st.device, createdAt: new Date().toISOString() }, null, 2);
      await Repo.commit('push: test subscription', { put: new Map([[this.FILE, { s: await Repo.gitSha(new TextEncoder().encode(text)), text }]]) });
      this.showKey(priv);
    } catch (err) { toast('开启失败：' + err.message); }
  },

  // The private key, shown once: it goes into the repository's Actions secret, nowhere else
  showKey(priv) {
    const s = quickSheet(`
      <div class="pk-title">已开启 ✓<small>最后一步：把私钥存进私有仓库的 Secret</small></div>
      <div class="sheet-scroll">
      <p class="sync-note">这串私钥只在这里显示这一次，Folio 不会保存它。关掉这个窗口前先复制。</p>
      <p class="push-key">${esc(priv)}</p>
      <div class="pk-list"><button class="pk-row strong" data-a="copy"><span>复制私钥</span></button></div>
      <ol class="bm-steps">
        <li>打开你的私有仓库 ${esc(Sync.st.repo)} → Settings → Secrets and variables → Actions → New repository secret。</li>
        <li>Name 填 <b>FOLIO_VAPID_PRIVATE_KEY</b>，Secret 粘贴刚才复制的私钥，保存。</li>
        <li>以后每次「重新开启通知」都会换新私钥，要回来更新这个 Secret。</li>
      </ol></div>`);
    s.card.onclick = async e => { if (e.target.closest('[data-a=copy]')) { await copyText(priv); toast('已复制私钥'); } };
  },

  async send() {
    try {
      await Repo.api('/dispatches', { method: 'POST', body: JSON.stringify({ event_type: 'folio-push-test', client_payload: { sentAt: Date.now(), device: Sync.st.device } }) });
      this.note({ how: 'sent' });
      toast('已请求发送：通常半分钟到一分钟后到达，可以先锁屏或退出 Folio');
    } catch (err) { toast('发送失败：' + err.message); }
  },

  async disable() {
    try {
      await (await this.sub())?.unsubscribe();
      await Repo.commit('push: remove test subscription', { del: [this.FILE] });
      toast('已关闭通知');
    } catch (err) { toast('关闭失败：' + err.message); }
  },
};
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
