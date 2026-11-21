// Sends one test notification to the subscription in push/subscription.json (Folio's Web Push test).
// Built-in Node modules only: VAPID (RFC 8292) signs the request, the payload is encrypted with
// aes128gcm (RFC 8291). The private key comes from the environment (an Actions secret), never a file.
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
const un64 = s => Buffer.from(s, 'base64url');
const sub = JSON.parse(readFileSync(process.env.SUB_FILE || 'push/subscription.json', 'utf8'));
const d = (process.env.VAPID_PRIVATE_KEY || '').trim();
if (!d) throw new Error('Secret FOLIO_VAPID_PRIVATE_KEY is empty or missing');

// The VAPID key: public half from the subscription file, private half from the secret
const pub = un64(sub.vapidPublic);
const key = crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
const derived = crypto.createECDH('prime256v1'); derived.setPrivateKey(un64(d));   // the public key the secret really belongs to
if (!derived.getPublicKey().equals(pub))
  throw new Error('The secret does not match this subscription: paste the private key shown when notifications were last turned on');

// VAPID JWT (ES256)
const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
const claims = b64u(JSON.stringify({ aud: new URL(sub.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sub.subject }));
const jwt = `${head}.${claims}.${b64u(crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }))}`;

// Payload: Declarative Web Push (iOS 18.4+ shows it and opens `navigate` by itself); Folio's
// service worker shows the same notification on older systems
const sentAt = Number(process.env.SENT_AT) || 0, now = new Date();
const time = now.toLocaleTimeString('zh-CN', { hour12: false, timeZone: process.env.TZ_NAME || 'America/Chicago' });
const payload = { web_push: 8030, notification: { title: 'Folio 测试通知', body: `${time} 发出 · 点这条通知打开 Folio`, navigate: new URL('./?from=push', sub.app).href, silent: false } };

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

if (process.env.DRY_RUN) { process.stdout.write(JSON.stringify({ jwt, body: b64u(body), payload })); process.exit(0); }
const res = await fetch(sub.endpoint, { method: 'POST', body, headers: {
  Authorization: `vapid t=${jwt}, k=${sub.vapidPublic}`, TTL: '86400', Urgency: 'high',
  'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } });
const text = await res.text();
console.log(`Push service (${new URL(sub.endpoint).host}) answered ${res.status} ${text}`);
if (sentAt) console.log(`From the tap in Folio to sending: ${Math.round((Date.now() - sentAt) / 1000)} s`);
if (res.status === 404 || res.status === 410) throw new Error('This subscription is no longer valid: turn notifications on again in Folio');
if (!res.ok) throw new Error('The push service refused the message');
