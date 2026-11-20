# Folio

A lightweight, mobile-first e-book reader built as a Progressive Web App. No server of its own, no install, no build step. Add it to your home screen and it behaves like a native app. Books and reading records live on your device, and can optionally sync between your phone and computer through your own GitHub account.

**Live:** https://cynthiazhao0411.github.io/folio/

## Features

### Reading
- **Paginated layout**: CSS multi-column pagination with tap and swipe to turn pages.
- **Page curl**: the page bends from wherever it is taken: a corner gives a diagonal fold, the middle of the edge an upright one, and the lifted point follows the finger (on a computer, drag in the page margins; clicks and taps turn from the height they land at). The turned-over part shows the back of the paper, the same page mirrored and faint, with shading where it bends and a shadow along the fold on the page underneath. Pages turn back the same way from the left. Only transforms and clip paths change while a page turns; the text is never repainted.
- **Front pages**: each book opens on a cover page (jacket, title, characters, tags, summary), followed by a full-bleed info page with word count, chapter count and date.
- **Navigation**: a chapter scrubber to jump to any page of the current chapter, and 上一章 / 下一章 buttons. The footer shows the chapter, the page within it and the whole-book percentage.
- **The End**: every book closes on its own final page in the book's colour, always after the latest chapter however often the book is updated.
- **Author's notes in the text**: chapter notes appear as a quiet inline box; long ones are folded to a few lines and open with a tap.
- **Traditional → Simplified**: books in traditional characters are detected and shown in simplified characters, with a one-tap switch back to the original. The conversion is character-for-character, so highlights stay anchored.
- **Screen stays on** while you read, and is released after 90 seconds without a touch.
- **Reading settings**: font size, three paper themes (cream, green, night) and page-turn style, all remembered.

### Highlights, notes and bookmarks
- **Character-precise selection**: long-press (or click and drag on desktop) to select, with drag handles, a live character count and a floating menu at the end of the selection. Every character is measured (including the first one of a wrapped line, which WebKit reports with an extra empty box), the pointer is matched to a line first and then to the nearest character on it, and a drag that starts beside a handle moves that handle.
- **Highlights and notes**: four highlight colours and notes with timestamps. Writing a note on plain text highlights it automatically. Tap any highlight to change its colour, copy it, edit it or delete it. Every saved version of a note is kept with its time.
- **Bookmarks**: pull the page down to add or remove one, or tap the ribbon to remove it.
- **Bookmark notes**: in the bookmarks list, 加备注 / 改备注 attaches one line to a bookmark. The note is kept on the bookmark's own record with its earlier versions, so it syncs and backs up with it; the bookmark's place and the reading progress are not touched.
- **One panel for everything**: contents, bookmarks and notes live in a single slide-up panel, and each entry jumps straight to its place.

### Library
- **Continue reading**: a card at the top of the shelf reopens the book you were last reading.
- **Phone layout**: three columns, with cover height sized to the real space under the status bar so exactly three full rows fit the first screen, and covers about 10% wider than that height alone would give (at least 18px between columns). The same rule serves every folder view; the last row keeps clear of the home indicator and the paper-colour pill.
- **Paper colour on the shelf**: a small pill in the bottom corner switches light / green / night in one tap.
- **Refresh**: syncs now, collects works waiting in the inbox and redraws the shelf.
- **Cover colours**: each book keeps its own colour, handed out so the palette stays evenly used.
- **Covers**: generated automatically, taken from an EPUB, or uploaded from your photos and cropped in a fixed 2:3 frame (drag, pinch or scroll to zoom).
- **Catalog card**: long-press a book (right-click on desktop) to open its card. From there you can rate, set a status (unread / reading / finished), rename, move to a folder, edit tags, pin, change the cover, export as EPUB, view its stats, hide it or delete it.
- **Multi-select**: batch pin, move, tag, set covers, hide, change status or delete. The folder picker keeps "＋ 新建文件夹" as its first row (never behind the toolbar); a folder made there receives the selected books straight away, several folders can be created, and a folder emptied by a move stays on the shelf until you delete it.
- **Organisation**: folders, tags (with suggestions taken from the book's own metadata), pinned books first and hidden books. The shelf's filter row shows "全部" and the folders; tags are set and managed on the catalog card and are not shown beside the folders.
- **System tags**: the catalog card shows 短篇 / 中篇 / 长篇 (under 30,000 characters / under 100,000 / longer), 完结 / 连载 (from the work's chapter count, e.g. 12/12 or 12/?) and 重读 (finished twice, or finished once and being read again). They are worked out each time from the book and its reading record, never stored, and shown apart from your own #tags, which they never change.
- **Updates, not duplicates**: importing a book again, in any format, updates its text and keeps your progress, notes, ratings and history. New chapters get a "新 +N 章" badge until you open the book.

### Reading records
- **Reading sessions**: every time a book is opened, Folio records when, for how long, and from where to where. This is the base for history, calendar and year-in-review views.
- **Honest timer**: the clock stops after 90 seconds without input and stops immediately when the app goes to the background.
- **Stats**: day, week, month, year and all-time, with comparison to the previous period, reading days, streaks and most-read books.
- **Read-throughs**: a book counts as read once progress reaches 98% *and* the real reading time of this read-through reaches 40% of the book's estimated time, so jumping to the end never counts; going back to the first 10% starts the next read-through. Reading time is only counted while the book is open and in use (the clock stops after 90 s without a touch and when Folio is hidden). Each finished read-through keeps its start and end, its total reading time across every opening, how many times the book was opened for it (from the session records, a reopening within 2 minutes counted once) and the estimate it was measured against. Marking a book finished by hand counts once. The count shows on the shelf (读完 N 遍) and, with the read-through under way, at the top of the long-press card, which opens every finish with its details.
- **Estimated reading time**: every chapter and the whole book get an estimate from their character count at 400 characters a minute, a typical silent-reading pace for Chinese; it is stored with the book (and filled in once for books imported earlier) and shown as 预计 on the long-press card, never as a countdown.
- **Ratings**: every rating you give is kept, and the book's rating is their average to the nearest half star. Re-rating within five minutes counts as a correction. You're asked to rate a book when you finish it, and the library view shows your rating distribution.

### Import and export
- **Formats**: EPUB (EPUB 2 and 3, including covers and books split across files), PDF (text is rebuilt into paragraphs; running headers and page numbers are removed), structured HTML, saved web pages, plain HTML (split into chapters by headings), TXT (chapter detection; UTF-8 and GBK detected automatically), and ZIP files holding any of these. Several files can be picked at once.
- **Reliable batches**: progress is shown while importing ("正在导入 3 / 20"). Each book is saved text first, record second, then read back; if any step fails that book is rolled back (or its previous version restored), so the shelf never holds a book without its text. Empty files and files with almost no text are rejected, and one summary states exactly how many books were added or updated and which files failed and why.
- **Paste import**: paste one book's HTML, or a bundle of several, from the clipboard. A pasted web link is collected directly when the site allows other pages to read it: the page's title, author, summary and cover (from JSON-LD, Open Graph and common meta tags) fill in whatever the downloaded file lacks, and the page's EPUB, TXT, PDF, ZIP or HTML links are offered. Sites that do not allow it are named, and the collect bookmark is suggested instead.
- **Computer: drag and drop**: drop one or many files anywhere on the shelf. Unsupported files are skipped with a count, one broken file never stops the others, books already on the shelf are recognised (updated or reported as unchanged), and the result states what happened to each file.
- **Computer: downloads folder** (Chrome and Edge): choose a folder once (for example 下载); after that, "从下载文件夹收书" imports only the e-book files it has not seen before, including one level of sub-folders. Folio reads the folder only when that button is pressed. The folder permission and the list of seen files stay on that computer only (never synced or backed up). If the browser withdraws the permission, the folder is moved or deleted, or a file cannot be imported, Folio says so; a broken file is not reported again unless it changes or a full recheck is asked for.
- **EPUB export**: share any book as an EPUB 3 file.
- **Complete backup and one-step restore** (ZIP file): one ZIP file holds every book (text and chapter structure), all metadata (titles, authors, covers, progress, ratings, status, read-throughs, pins, folders, tags), highlights, bookmarks and notes with their positions and history, reading sessions and daily totals, empty folders and the reader settings. Every backup is read back and compared with the data before it is offered; every restore is checked before and after writing. Restore can merge into the current shelf or replace it, the current shelf is copied aside first so a restore can be undone, and older JSON backups still restore. Without sync, a gentle reminder appears after a week without a backup.
- **Automatic cloud backup**: once sync is connected, the same complete backup is kept in the `backup/` folder of your private sync repository. It runs about 90 seconds after a change, when Folio goes to the background, when the network returns, and on the next launch if something was left out; it is not a background service and cannot run while Folio is not open. Each backup is one commit: only new files are uploaded (book text already in the repository is referenced, not uploaded again), and the folder is switched in a single step, so a failed or interrupted backup leaves the previous one intact and never touches local data. Earlier backups stay in the repository history, and **⋯ → 设备同步 → 云端自动备份 → 从云端备份恢复** lists the recent ones to restore from (merge or replace, with undo). Network problems, rate limits and invalid tokens are shown there and retried every few minutes. The token is never written into any backup.
- **Offline**: a service worker caches the app, so it opens without a network.

### Sync and web collection
- **Phone ↔ computer sync**: the whole library is stored in a private GitHub repository of your own, reached with a fine-grained token limited to that repository. The device that changed last wins, so nothing is ever half-merged; a device whose first sync has not finished never uploads over the cloud library. Only changed files are uploaded (a reading-progress change rewrites one small file), and a book that is open is never replaced under you. Libraries set up before v1.2.6 used secret gists; **升级到私有仓库** moves them (see below).
- **Collect bookmark**: Folio generates a bookmark for Safari or Chrome. On a work's page it sends that work to your shelf; on a list page it adds checkboxes so you can send several at once, pre-selecting ones on your shelf that have new chapters; "查更新" checks every unfinished book on your shelf for new chapters. Works travel through the `inbox/` folder of the private repository and are imported the next time Folio opens; e-book files are stored as themselves, next to a small file with what the page said about the book. A work leaves the inbox only after it is saved on the device *and* uploaded to the sync folder, so a later sync from the other device can never replace a work that exists nowhere else; if that upload cannot happen, the work simply stays in the inbox and is picked up again (importing again only updates). Files in the inbox that contain no text are skipped with a notice. Batches are saved after every work, so if the page is reloaded, tapping the bookmark again continues with only the works that are left; the screen is kept awake while a batch runs. If a site blocks the connection, the bookmark copies the works to the clipboard instead. On other sites, the bookmark lists the e-book files the page offers for download (EPUB, TXT, PDF, ZIP, HTML) and sends the ones you pick; this works where the site lets its own pages download those files.

## Technical notes

| Module | Description |
|---|---|
| `importer.js` | Parsing: DOMParser for HTML structure, TextDecoder with GB18030 fallback, regex-based TXT chapter detection, stable IDs from a hash of source or title and authors |
| `formats.js` | ZIP reader on the browser's `DecompressionStream`; EPUB (OPF, spine, nav / NCX, cover; structured-export layout recognised); PDF text extraction with line and paragraph rebuilding |
| `reader.js` | Layout and turning: one chapter at a time, `column-width` pagination, `translate3d` positioning; two-sheet double buffer and a third sheet for the back of the turning page in the curl; scrubber, inline author's notes, traditional → simplified display |
| `annotations.js` | Bookmarks, highlights and notes anchored by character offsets in each chapter's plain text (independent of layout) and re-located by quoted text after re-import; custom selection with cached glyph boxes and arithmetic hit-testing |
| `stats.js` | Reading clock (idle and background detection), read-through rule, stats page with pure HTML/CSS charts and rating distribution |
| `repo.js` | Private repository storage over the Git Data API: content-checksummed shards, batched uploads, one atomic commit per write (fast-forward only), reads by blob id |
| `migrate.js` | Moving a library from the old secret gists to the repository: one commit, read back and compared, gists left in place |
| `cloud.js` | Automatic cloud backup: debounced, incremental, atomic backup into `backup/`, restore from any recent backup (gists before v1.2.6) |
| `links.js` | Pasted links: page metadata (JSON-LD, Open Graph, meta tags), e-book file links, metadata merged into imported files |
| `desktop.js` | Computer import: downloads folder (File System Access API, permission handling, seen-file list) and drag and drop |
| `sync.js` | Device sync: whole-library snapshot in `sync/`, last-writer-wins; inbox for the collect bookmark (gists before v1.2.6) |
| `collector.js` | Source of the collect bookmark: whole-work fetching, list-page picking, update checks, clipboard fallback |
| `cover.js` | Cover cropper: fixed 2:3 frame, drag / pinch / wheel zoom, Canvas export and dominant-colour extraction |
| `library.js` | Library: filtering, continue card, catalog card, ratings, pickers, multi-select toolbar, custom dialogs |
| `epub.js` | EPUB 3 export: XHTML normalisation plus a minimal ZIP writer (store mode, CRC-32) |
| `ui.js` | Web Animations API motion: draggable bottom sheets, book open/close transitions, title fitting |
| `db.js` | IndexedDB wrapper: metadata, text, notes, daily totals, reading sessions and prefs in separate stores, plus a `device` store for data that belongs to one computer only (never synced, backed up or restored); upgrades only add, and snapshot the data first |
| `backup.js` | Complete backup (ZIP: manifest with counts and checksums, one file per store, one per book, settings), verification, merge / replace restore, undo |
| `app.js` | App shell: import, settings, sessions, wake lock, debounced progress saving, backup and restore |
| `sw.js` | Network-first with cache fallback; a new release takes effect on the next launch |
| `lib/` | [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0), loaded only when a PDF is imported; a traditional → simplified table generated from [OpenCC](https://github.com/BYVoid/OpenCC) (Apache-2.0) |

Plain HTML, CSS and JavaScript: no framework, no build step.

## Fonts and licence

The interface and the book text use the font the iPhone shows, **PingFang SC**. PingFang is Apple's and cannot be shipped with Folio, so on devices without it (Windows, Android, Linux) Folio uses bundled open fonts of the same design family, loaded locally with `@font-face` (no network font service):
- **Folio Sans**: Noto Sans SC (Source Han Sans), variable weight, in `fonts/sans/`, split by character range (`fonts/sans/sans.css`) so only the pieces of the characters on screen are downloaded. Symbols and emoji are left to each system's own fonts.
- **Folio Latin**: Inter (`fonts/inter-latin*-wght-normal.woff2`) for Latin letters, digits and Western punctuation, which PingFang draws with narrow Latin glyphs.
- **Folio Quotes**: the four curly quotes from Folio Sans at proportional width (`fonts/sans/folio-quotes.woff2`), as PingFang sets them.
- A device that has PingFang finds it first and downloads none of these.

The title and author inside every jacket, and the bold title on the cover page, are set in **Noto Serif CJK SC** (Source Han Serif): `fonts/NotoSerifSC-Regular.woff` (400) and `fonts/NotoSerifSC-Medium.woff` (500–700), subset to GB2312 + Latin + punctuation.

All bundled fonts are under the SIL Open Font License 1.1 (`fonts/OFL.txt`, `fonts/sans/OFL.txt`, `fonts/Inter-OFL.txt`), which must stay with the files. The service worker precaches the small files; the pieces of Folio Sans are cached as they are first used, so the fonts also work offline.

## Run locally

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. If your phone is on the same network, use your computer's LAN IP instead.

## Deploy

Push to GitHub, then in the repository go to **Settings → Pages** and serve the `main` branch from the root.

## Install
- **iPhone**: open the site in Safari → Share → **Add to Home Screen**.
- **Computer (Chrome)**: open the site → the install icon in the address bar, or **⋮ → Cast, save and share → Install page as app**.

## Set up sync
1. On GitHub, create a new repository (for example `folio-data`) and choose **Private**.
2. **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Under Repository access choose **Only select repositories** and pick that repository; under Permissions set only **Contents** to **Read and write** (Metadata read-only is added automatically). Choose an expiry date you are comfortable with.
3. In Folio on each device: **⋯ → 设备同步**, enter the repository (`user/folio-data`) and the token. Folio refuses a public repository. If both devices already have books, choose which library to keep.
4. For the collect bookmark: **⋯ → 设备同步 → 网页收书书签 → 复制书签**, then save it as a bookmark's address. Copy it again after changing the token or moving from gists.

### Moving from gists (libraries set up before v1.2.6)
**⋯ → 设备同步 → 升级到私有仓库** on one device, with a new empty private repository and a token as above. Folio first finishes the old sync, writes the sync library, the cloud backup and the inbox to the repository in one commit, reads everything back and compares it record by record and book by book, and only then switches. If anything fails, nothing changes and the device keeps using the gists. The gists are not deleted or changed; one file, `moved-to-repo.json`, is added to the index gist so the other device knows to stop writing there. On the other device (after updating to v1.2.6) use the same button with the same repository; it joins instead of moving the data again. Until both bookmarks are replaced, works the old bookmark still sends to the old inbox are imported (read only). The old gists and the old gist token can be deleted by hand once they are no longer needed (**设备同步 → 旧 Gist → 停用旧 Gist** makes this device forget them).

### Repository layout and limits
- `sync/`, `backup/`: `manifest.json` lists every file with an FNV checksum and its Git blob id; `stores/<name>/<n>.json` holds each database store in shards of about 64 KB by record key; `media/` holds long values such as covers, named by checksum and stored once; `books/<xx>/<id>.json` holds one book, split into parts above 2 MB. Stores are enumerated from the database, so data added by later versions is included automatically.
- `inbox/`: works from the bookmark; `library.json` for its update checks. `migration.json` records a move from gists.
- Writes upload new files a few MB per request and finish with one commit whose branch update is fast-forward only, keeping well below GitHub's limit of about 80 writing requests a minute. Reads fetch blobs by id, never list folders, and verify checksums. Downloading a whole library takes about one request per book (GitHub allows 5,000 an hour); if a first download is cut short, books already downloaded are kept on the device and the next attempt continues.

### Security
The token is stored in this browser's local storage and inside your own bookmark; it is never written to the repository, a backup or a log. Anyone who obtains it can read and change that repository (and only that one, with a fine-grained token limited as above). The bookmark runs on the site you tap it on; it uses the browser's own `fetch` from a fresh frame so a site script that replaced `fetch` does not see the token, but a hostile page could still try other ways, so use the bookmark only on sites you trust. A private repository protects the data from other people on GitHub; it does not protect against a compromised device or browser profile, or against GitHub itself.

## Book titles and pairings

A title such as `【亚内】Some Work` carries the pairing in its first full-width bracket pair. `parseBookTitle()` in `ui.js` is the single rule: the cover page shows `CP · 亚内` under the jacket, and every other place (shelf, jacket, reader, contents, dialogs, stats) shows the cleaned name through `bookName()`. The stored title is never rewritten, so the pairing stays in the data and the rule applies to existing and newly imported books alike. Titles without brackets, with empty brackets, or consisting only of a bracket are shown unchanged; further bracket pairs after the first are left in the name.

## Backup format

`folio-backup-YYYY-MM-DD.zip`, format 3:

- `manifest.json`: app and database version, creation time, device, and for every part its record count and checksum
- `stores/<name>.json`: every database store except book text, internal snapshots and the device-only store. Stores are enumerated, never hard-coded, so data added by later versions is included automatically; blobs, binary data and dates are tagged and restored exactly
- `books/<id>.json`: one file per book, full text and chapter structure
- `local.json`: this device's settings (theme, font size, page turn); sync credentials are never included

This is the same split as device sync (one snapshot plus one file per book), so a backup and a synced library are the same data in the same shape. The restore entry also accepts the JSON backups of earlier versions. On phones the file is offered through the share sheet; on computers it is a normal download. The automatic cloud backup holds the same data in the repository's `backup/` folder (stores split into shards there, see above).
