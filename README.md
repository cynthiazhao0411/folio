# Folio

A lightweight, mobile-first e-book reader built as a Progressive Web App. No server of its own, no install, no build step. Add it to your home screen and it behaves like a native app. Books and reading records live on your device, and can optionally sync between your phone and computer through your own GitHub account.

**Live:** https://cynthiazhao0411.github.io/folio/

## Features

### Reading
- **Paginated layout**: CSS multi-column pagination with tap and swipe to turn pages.
- **Page curl**: the page follows your finger, with a paper back and a fold shadow. Every frame is a GPU-composited `transform`.
- **Front pages**: each book opens on a cover page (jacket, title, characters, tags, summary), followed by a full-bleed info page with word count, chapter count and date.
- **Navigation**: a chapter scrubber to jump to any page of the current chapter, 上一章 / 下一章 buttons, and jumps to the end of the chapter or of the book. The footer shows the chapter, the page within it and the whole-book percentage.
- **The End**: every book closes on its own final page in the book's colour, always after the latest chapter however often the book is updated.
- **Author's notes in the text**: chapter notes appear as a quiet inline box; long ones are folded to a few lines and open with a tap.
- **Traditional → Simplified**: books in traditional characters are detected and shown in simplified characters, with a one-tap switch back to the original. The conversion is character-for-character, so highlights stay anchored.
- **Screen stays on** while you read, and is released after 90 seconds without a touch.
- **Reading settings**: font size, three paper themes (cream, green, night) and page-turn style, all remembered.

### Highlights, notes and bookmarks
- **Character-precise selection**: long-press (or click and drag on desktop) to select, with drag handles, a live character count and a floating menu at the end of the selection.
- **Highlights and notes**: four highlight colours and notes with timestamps. Writing a note on plain text highlights it automatically. Tap any highlight to change its colour, copy it, edit it or delete it. Every saved version of a note is kept with its time.
- **Bookmarks**: pull the page down to add or remove one, or tap the ribbon to remove it.
- **One panel for everything**: contents, bookmarks and notes live in a single slide-up panel, and each entry jumps straight to its place.

### Library
- **Continue reading**: a card at the top of the shelf reopens the book you were last reading.
- **Phone layout**: three columns, with covers sized so three full rows fit the first screen.
- **Refresh**: syncs now, collects works waiting in the inbox and redraws the shelf.
- **Cover colours**: each book keeps its own colour, handed out so the palette stays evenly used.
- **Covers**: generated automatically, taken from an EPUB, or uploaded from your photos and cropped in a fixed 2:3 frame (drag, pinch or scroll to zoom).
- **Catalog card**: long-press a book (right-click on desktop) to open its card. From there you can rate, set a status (unread / reading / finished), rename, move to a folder, edit tags, pin, change the cover, export as EPUB, view its stats, hide it or delete it.
- **Multi-select**: batch pin, move, tag, set covers, hide, change status or delete.
- **Organisation**: folders, tags (with suggestions taken from the book's own metadata), pinned books first, hidden books, and filter chips.
- **Updates, not duplicates**: importing a book again, in any format, updates its text and keeps your progress, notes, ratings and history. New chapters get a "新 +N 章" badge until you open the book.

### Reading records
- **Reading sessions**: every time a book is opened, Folio records when, for how long, and from where to where. This is the base for history, calendar and year-in-review views.
- **Honest timer**: the clock stops after 90 seconds without input and stops immediately when the app goes to the background.
- **Stats**: day, week, month, year and all-time, with comparison to the previous period, reading days, streaks and most-read books.
- **Read-throughs**: a book counts as read once progress passes 85% *and* this run's reading time reaches 40% of the estimated time (word count ÷ reading speed), so it adapts to both short and long books. The first time you mark a book finished by hand also counts once.
- **Ratings**: every rating you give is kept, and the book's rating is their average to the nearest half star. Re-rating within five minutes counts as a correction. You're asked to rate a book when you finish it, and the library view shows your rating distribution.

### Import and export
- **Formats**: EPUB (EPUB 2 and 3, including covers and books split across files), PDF (text is rebuilt into paragraphs; running headers and page numbers are removed), structured HTML, saved web pages, plain HTML (split into chapters by headings), TXT (chapter detection; UTF-8 and GBK detected automatically), and ZIP files holding any of these. Several files can be picked at once.
- **Paste import**: paste one book's HTML, or a bundle of several, from the clipboard.
- **EPUB export**: share any book as an EPUB 3 file.
- **Backup and restore**: export every record (books, progress, notes, sessions, ratings) to one JSON file. Without sync, a gentle reminder appears after a week without a backup.
- **Offline**: a service worker caches the app, so it opens without a network.

### Sync and web collection
- **Phone ↔ computer sync**: connect a GitHub personal access token with gist access on each device. The whole library is stored in your own secret gists; the device that changed last wins, so nothing is ever half-merged. Book text is uploaded only when it changes, and a book that is open is never replaced under you.
- **Collect bookmark**: Folio generates a bookmark for Safari or Chrome. On a work's page it sends that work to your shelf; on a list page it adds checkboxes so you can send several at once, pre-selecting ones on your shelf that have new chapters; "查更新" checks every unfinished book on your shelf for new chapters. Works travel through a private inbox gist and are imported the next time Folio opens. Batches are saved after every work, so if the page is reloaded, tapping the bookmark again continues with only the works that are left; the screen is kept awake while a batch runs. If a site blocks the connection, the bookmark copies the works to the clipboard instead.

## Technical notes

| Module | Description |
|---|---|
| `importer.js` | Parsing: DOMParser for HTML structure, TextDecoder with GB18030 fallback, regex-based TXT chapter detection, stable IDs from a hash of source or title and authors |
| `formats.js` | ZIP reader on the browser's `DecompressionStream`; EPUB (OPF, spine, nav / NCX, cover; structured-export layout recognised); PDF text extraction with line and paragraph rebuilding |
| `reader.js` | Layout and turning: one chapter at a time, `column-width` pagination, `translate3d` positioning; two-sheet double buffer for the curl; scrubber, inline author's notes, traditional → simplified display |
| `annotations.js` | Bookmarks, highlights and notes anchored by character offsets in each chapter's plain text (independent of layout) and re-located by quoted text after re-import; custom selection with cached glyph boxes and arithmetic hit-testing |
| `stats.js` | Reading clock (idle and background detection), read-through rule, stats page with pure HTML/CSS charts and rating distribution |
| `sync.js` | Device sync over the GitHub Gist API: whole-library snapshot, per-book text files, last-writer-wins; inbox for the collect bookmark |
| `collector.js` | Source of the collect bookmark: whole-work fetching, list-page picking, update checks, clipboard fallback |
| `cover.js` | Cover cropper: fixed 2:3 frame, drag / pinch / wheel zoom, Canvas export and dominant-colour extraction |
| `library.js` | Library: filtering, continue card, catalog card, ratings, pickers, multi-select toolbar, custom dialogs |
| `epub.js` | EPUB 3 export: XHTML normalisation plus a minimal ZIP writer (store mode, CRC-32) |
| `ui.js` | Web Animations API motion: draggable bottom sheets, book open/close transitions, title fitting |
| `db.js` | IndexedDB wrapper: metadata, text, notes, daily totals and reading sessions in separate stores; upgrades only add, and snapshot the data first |
| `app.js` | App shell: import, settings, sessions, wake lock, debounced progress saving, backup and restore |
| `sw.js` | Network-first with cache fallback; a new release takes effect on the next launch |
| `lib/` | [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0), loaded only when a PDF is imported; a traditional → simplified table generated from [OpenCC](https://github.com/BYVoid/OpenCC) (Apache-2.0) |

Plain HTML, CSS and JavaScript: no framework, no build step.

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
1. On GitHub: **Settings → Developer settings → Personal access tokens → Tokens (classic)**, create a token with only the `gist` scope.
2. In Folio on each device: **⋯ → 设备同步**, paste the token. If both devices already have books, choose which library to keep.
3. For the collect bookmark: **⋯ → 设备同步 → 网页收书书签 → 复制书签**, then save it as a bookmark's address.

The token is stored only on your devices and inside your own bookmark. Do not share either.
