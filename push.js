// push.js — Web Push for collecting ("新书已加入 Folio").
//
// After a batch of works has been written to the private repository, the 收书 panel sends one
// repository_dispatch event (folio-collected); the workflow .github/workflows/folio-push.yml in that
// repository signs and sends the notification to every device saved in push/subscription*.json.
// Tapping it opens Folio on the last book of the batch (app.js, arrive).
//
// This file only manages this device's subscription (设备同步 → 收书通知). Each device turns
// notifications on for itself and has its own file, push/subscription-<id>.json (push/subscription.json
// is the one device from before v1.3.4). All devices use one VAPID key pair: the first device to turn
// notifications on makes it here; the public key goes into its file (the existing token, Contents:
// read and write) and the private key is shown once, to be pasted into the repository's Actions secret
// FOLIO_VAPID_PRIVATE_KEY. It is never stored by Folio or written to any repository. Later devices
// subscribe with the public key already in the repository, so the secret never has to change.
const Push = {
  supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
  async sub() { const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); },
  // This device's own name for its file (kept on the device)
  id() {
    let id = localStorage.getItem('folio-push-id');
    if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('folio-push-id', id); }
    return id;
  },
  get file() { return `push/subscription-${this.id()}.json`; },
  // Every device's subscription in the repository: path → its contents
  async saved() {
    const head = await Repo.head(), files = await Repo.ls(head.tree, 'push'), out = new Map();
    for (const [p, sha] of files) {
      if (!/^push\/subscription[^/]*\.json$/.test(p)) continue;
      try { out.set(p, JSON.parse(new TextDecoder().decode(await Repo.blob(sha)))); } catch { /* unreadable: left as it is */ }
    }
    return out;
  },

  async open() {
    const sub = this.supported() ? await this.sub().catch(() => null) : null;
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let log = [];
    try { log = JSON.parse(localStorage.getItem('folio-arrival-log') || '[]').slice(-6).reverse(); } catch { /* no record */ }
    const when = t => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const s = quickSheet(`
      <div class="pk-title">收书通知<small>${sub ? '已开启：网页收书完成后，这台设备会收到一条通知' : '网页收书完成后，在这台设备上收到一条通知'}</small></div>
      <div class="sheet-scroll">
      ${!this.supported() ? '<p class="sync-note">这里不支持网页推送。</p>'
        : !sub && !standalone && /iPhone|iPad|iPod/.test(navigator.userAgent) ? '<p class="sync-note">iPhone 上要从主屏幕的 Folio 打开才能开启通知。</p>' : ''}
      <div class="pk-list">
        ${sub ? '<button class="pk-row muted" data-a="off"><span>关闭通知</span><small>这台设备不再收到收书通知</small></button>'
          : this.supported() ? '<button class="pk-row strong" data-a="on"><span>开启通知</span><small>每台设备分别开启，互不影响</small></button>' : ''}
      </div>
      ${log.length ? `<p class="sync-note">最近的跳转记录（打不开新书时，截图这里）：</p><ul class="arrival-log">${log.map(l => `<li><span>${when(l.at)}</span>${esc(l.line)}</li>`).join('')}</ul>` : ''}
      </div>`);
    s.card.onclick = async e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'on') return this.enable(s);                   // the permission request must come from this tap
      if (a === 'off') { await s.close(); this.disable(); }
    };
  },

  async enable(sheet) {
    if (!Sync.repoMode) return toast('需要先连上私有仓库');
    const perm = await Notification.requestPermission();      // first thing in the tap: iOS requires it
    await sheet.close();
    if (perm !== 'granted') return toast(perm === 'denied' ? '通知被拒绝了：到 iPhone 设置 → 通知 → Folio 里打开' : '没有允许通知');
    try {
      const saved = await this.saved();
      // The key the Actions secret already belongs to; a new pair only when no device has one yet
      let pub = [...saved.values()].map(s => s.vapidPublic).find(k => typeof k === 'string' && k.length > 80), priv = null;
      if (!pub) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        pub = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
        priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
      }
      const reg = await navigator.serviceWorker.ready;
      let cur = await reg.pushManager.getSubscription();
      const old = cur?.endpoint;
      const curKey = cur?.options?.applicationServerKey ? b64url(new Uint8Array(cur.options.applicationServerKey)) : '';
      if (cur && curKey !== pub) { await cur.unsubscribe(); cur = null; }   // another key needs a new subscription
      const j = (cur || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pub })).toJSON();
      const text = JSON.stringify({ endpoint: j.endpoint, keys: j.keys, vapidPublic: pub,
        subject: location.origin.startsWith('https:') ? location.origin : 'mailto:folio@example.invalid',
        app: new URL('./', location.href).href, device: Sync.st.device, id: this.id(), createdAt: new Date().toISOString() }, null, 2);
      // This device's earlier entries (the same subscription, before or after renewing it) are replaced
      const del = [...saved].filter(([p, s]) => p !== this.file && (s.id === this.id() || s.endpoint === j.endpoint || (old && s.endpoint === old))).map(([p]) => p);
      await Repo.commit('push: subscription', { put: new Map([[this.file, { s: await Repo.gitSha(new TextEncoder().encode(text)), text }]]), del });
      if (priv) this.showKey(priv);
      else toast('已开启收书通知');
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
        <li>打开私有仓库 ${esc(Sync.st.repo)} → Settings → Secrets and variables → Actions。</li>
        <li>编辑 <b>FOLIO_VAPID_PRIVATE_KEY</b>（没有就新建），粘贴刚才复制的私钥，保存。</li>
      </ol></div>`);
    s.card.onclick = async e => { if (e.target.closest('[data-a=copy]')) { await copyText(priv); toast('已复制私钥'); } };
  },

  async disable() {
    try {
      const cur = await this.sub();
      const saved = await this.saved();
      const del = [...saved].filter(([p, s]) => p === this.file || s.id === this.id() || (cur && s.endpoint === cur.endpoint)).map(([p]) => p);
      await cur?.unsubscribe();
      if (del.length) await Repo.commit('push: remove subscription', { del });
      toast('已关闭收书通知');
    } catch (err) { toast('关闭失败：' + err.message); }
  },
};
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
