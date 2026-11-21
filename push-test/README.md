# Web Push test (temporary prototype)

Verifies that Folio, installed on the iPhone Home Screen, can receive a push notification and is
opened by tapping it. It is not wired into collecting, syncing or backups, and is meant to be
removed or replaced once the real-device test is done.

- `pushtest.js` — the 设备同步 → 通知测试（临时） sheet: asks for notification permission (from a
  tap), makes a VAPID key pair, subscribes, saves the public key and subscription to
  `push/subscription.json` in the private data repository, and shows the private key once.
  The private key is never stored by Folio or written to any repository.
  "发送测试通知" sends a `repository_dispatch` event (`folio-push-test`) with the existing token
  (Contents: read and write is enough).
- `sw.js` — `push` shows the notification; `notificationclick` brings an open Folio forward or
  opens `./?from=push`. Messages are Declarative Web Push JSON, which iOS 18.4+ shows and opens
  (`navigate`) by itself.
- `folio-push-test.yml` — copy into the private data repository as
  `.github/workflows/folio-push-test.yml`. Runs only on `workflow_dispatch` (Actions tab) or the
  `folio-push-test` dispatch; never on pushes. Needs the repository secret
  `FOLIO_VAPID_PRIVATE_KEY`. `send.mjs` is the same script, kept here for reading and testing;
  it uses only built-in Node modules (VAPID ES256 signature, aes128gcm encryption).
