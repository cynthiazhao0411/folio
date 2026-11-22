// push.js — Web Push for collecting ("新书已加入 Folio").
//
// After a batch of works has been written to the private repository, the 收书 panel sends one
// repository_dispatch event (folio-collected); the workflow .github/workflows/folio-push.yml in that
// repository signs and sends one notification to the device saved in push/subscription.json. Tapping
// it opens Folio, which collects the inbox at once (app.js, ?from=push / sw.js 'push-open').
//
// This file only manages this device's subscription (设备同步 → 收书通知). One device receives the
// notifications. Turning them on makes a VAPID key pair here: the public key and the subscription go
// to push/subscription.json (the existing token, Contents: read and write); the private key is shown
// once, to be pasted into the repository's Actions secret FOLIO_VAPID_PRIVATE_KEY, and is never stored
// by Folio or written to any repository. A subscription that already works is left as it is.
const Push = {
  FILE: 'push/subscription.json',

  supported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
  async sub() { const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); },

  async open() {
    const sub = this.supported() ? await this.sub().catch(() => null) : null;
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const s = quickSheet(`
      <div class="pk-title">收书通知<small>${sub ? '已开启：网页收书完成后，这台设备会收到一条通知' : '网页收书完成后，在这台设备上收到一条通知'}</small></div>
      <div class="sheet-scroll">
      ${!this.supported() ? '<p class="sync-note">这里不支持网页推送。</p>'
        : !sub && !standalone && /iPhone|iPad|iPod/.test(navigator.userAgent) ? '<p class="sync-note">iPhone 上要从主屏幕的 Folio 打开才能开启通知。</p>' : ''}
      <div class="pk-list">
        ${sub ? '<button class="pk-row muted" data-a="off"><span>关闭通知</span><small>这台设备不再收到收书通知</small></button>'
          : this.supported() ? '<button class="pk-row strong" data-a="on"><span>开启通知</span><small>只能有一台设备收通知，开启后会换掉之前那台</small></button>' : ''}
      </div></div>`);
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
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const pub = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
      const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d;
      const reg = await navigator.serviceWorker.ready;
      await (await reg.pushManager.getSubscription())?.unsubscribe();   // a new key needs a new subscription
      const j = (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pub })).toJSON();
      const text = JSON.stringify({ endpoint: j.endpoint, keys: j.keys, vapidPublic: pub,
        subject: location.origin.startsWith('https:') ? location.origin : 'mailto:folio@example.invalid',
        app: new URL('./', location.href).href, device: Sync.st.device, createdAt: new Date().toISOString() }, null, 2);
      await Repo.commit('push: subscription', { put: new Map([[this.FILE, { s: await Repo.gitSha(new TextEncoder().encode(text)), text }]]) });
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
        <li>打开私有仓库 ${esc(Sync.st.repo)} → Settings → Secrets and variables → Actions。</li>
        <li>编辑 <b>FOLIO_VAPID_PRIVATE_KEY</b>（没有就新建），粘贴刚才复制的私钥，保存。</li>
      </ol></div>`);
    s.card.onclick = async e => { if (e.target.closest('[data-a=copy]')) { await copyText(priv); toast('已复制私钥'); } };
  },

  async disable() {
    try {
      await (await this.sub())?.unsubscribe();
      await Repo.commit('push: remove subscription', { del: [this.FILE] });
      toast('已关闭收书通知');
    } catch (err) { toast('关闭失败：' + err.message); }
  },
};
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
