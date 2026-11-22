// Sends one 收书 notification to the device in push/subscription.json (run by folio-push.yml).
// Built-in Node modules only: VAPID (RFC 8292) signs the request, the payload is encrypted with
// aes128gcm (RFC 8291). The private key comes from the environment (an Actions secret), never a
// file, and is never printed. EVENT is the dispatch's client_payload: { ok, failed, titles }.
import { readFileSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
const un64 = s => Buffer.from(s, 'base64url');
const fail = msg => { console.error(msg); process.exit(1); };
console.log(`Node ${process.version}`);

const FILE = process.env.SUB_FILE || 'push/subscription.json';
if (!existsSync(FILE)) { console.log('No device has turned notifications on (push/subscription.json is missing): nothing to send.'); process.exit(0); }
const sub = JSON.parse(readFileSync(FILE, 'utf8'));

// The message: what this batch did, exactly. A manual run (no event) sends a test message.
const ev = (() => { try { return JSON.parse(process.env.EVENT || '{}') || {}; } catch { return {}; } })();
const ok = Math.max(0, Math.floor(+ev.ok || 0)), failed = Math.max(0, Math.floor(+ev.failed || 0));
const titles = (Array.isArray(ev.titles) ? ev.titles : []).map(t => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 3);
const manual = !('ok' in ev);
if (!manual && !ok) { console.log('Nothing arrived in this batch: no notification.'); process.exit(0); }
const names = titles.length ? titles.slice(0, 2).join('、') + (ok > 2 && titles.length ? ' 等' : '') : '';
const notification = manual
  ? { title: 'Folio 测试通知', body: '收书通知工作正常。点开会打开 Folio。' }
  : failed
    ? { title: `收书完成：成功 ${ok} 本，失败 ${failed} 本`, body: `${names ? `已加入：${names}。` : ''}失败的作品，再点一次收书书签可以重试。` }
    : { title: '新书已加入 Folio', body: `${ok} 本${names ? `：${names}` : ''}。点开就能看到。` };
const payload = { web_push: 8030, notification: { ...notification, navigate: new URL('./?from=push', sub.app).href, silent: false } };

// The VAPID key: checked before use, with messages that never show the key itself
const d = (process.env.VAPID_PRIVATE_KEY || '').trim();
if (!d) fail('The secret FOLIO_VAPID_PRIVATE_KEY is empty or missing.');
if (!/^[A-Za-z0-9_-]{43}$/.test(d)) fail(`The secret FOLIO_VAPID_PRIVATE_KEY is not in the expected form (43 characters, letters, digits, - and _; it has ${d.length}). Paste exactly the key Folio showed.`);
const pub = un64(sub.vapidPublic || '');
if (pub.length !== 65 || pub[0] !== 4) fail('push/subscription.json has no valid public key: turn notifications on again in Folio.');
let mine;
try { const e = crypto.createECDH('prime256v1'); e.setPrivateKey(un64(d)); mine = e.getPublicKey(); }
catch { fail('The secret FOLIO_VAPID_PRIVATE_KEY is not a valid key. Paste exactly the key Folio showed.'); }
if (!mine.equals(pub)) fail(`The secret belongs to another key pair (secret's public key starts ${b64u(mine).slice(0, 8)}, the subscription's starts ${sub.vapidPublic.slice(0, 8)}). `
  + 'Notifications were turned on again after the secret was saved: put the private key shown that last time into the secret.');
const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });

// VAPID JWT (ES256)
const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
const claims = b64u(JSON.stringify({ aud: new URL(sub.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sub.subject }));
const jwt = `${head}.${claims}.${b64u(crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }))}`;

// aes128gcm encryption (RFC 8291), one record
const ua = un64(sub.keys.p256dh), auth = un64(sub.keys.auth);
const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
const as = ecdh.getPublicKey(), secret = ecdh.computeSecret(ua), salt = crypto.randomBytes(16);
const hkdf = (s, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32);
const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])])), c.final(), c.getAuthTag()]);
const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
const body = Buffer.concat([salt, rs, Buffer.from([as.length]), as, ct]);

if (process.env.DRY_RUN) { process.stdout.write(JSON.stringify({ jwt, body: b64u(body), payload }) + '\n'); process.exit(0); }
const res = await fetch(sub.endpoint, { method: 'POST', body, headers: {
  Authorization: `vapid t=${jwt}, k=${sub.vapidPublic}`, TTL: '86400', Urgency: 'high',
  'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } });
console.log(`${manual ? 'Test' : `Batch: ${ok} arrived, ${failed} failed`} → push service (${new URL(sub.endpoint).host}) answered ${res.status} ${await res.text()}`);
if (ev.at) console.log(`From the end of the batch to sending: ${Math.round((Date.now() - ev.at) / 1000)} s`);
if (res.status === 404 || res.status === 410) fail('This subscription is no longer valid: turn notifications on again in Folio (设备同步 → 收书通知).');
if (!res.ok) fail('The push service refused the message.');
