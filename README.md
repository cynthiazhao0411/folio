# Folio

A lightweight, mobile-first e-book reader built as a Progressive Web App. No backend, no install, no build step. Add it to your home screen and it behaves like a native app, while every book and every reading record stays on your device.

**Live:** https://cynthiazhao0411.github.io/folio/

## Features

### Reading
- **Paginated layout**: CSS multi-column pagination with tap and swipe to turn pages.
- **Page curl**: the page follows your finger, with a paper back and a fold shadow. Every frame is a GPU-composited `transform`.
- **Front pages**: each book opens on a cover page (jacket, title, characters, tags, summary), followed by a full-bleed info page with word count, chapter count and date.
- **Reading settings**: font size, three paper themes (cream, green, night) and page-turn style, all remembered.

### Highlights, notes and bookmarks
- **Character-precise selection**: long-press (or click and drag on desktop) to select, with drag handles, a live character count and a floating menu at the end of the selection.
- **Highlights and notes**: four highlight colours and notes with timestamps. Writing a note on plain text highlights it automatically. Tap any highlight to change its colour, copy it, edit it or delete it.
- **Bookmarks**: pull the page down to add or remove one, or tap the ribbon to remove it.
- **One panel for everything**: contents, bookmarks and notes live in a single slide-up panel, and each entry jumps straight to its place.

### Library
- **Covers**: generated automatically, or upload your own photo and crop it in a fixed 2:3 frame (drag, pinch or scroll to zoom).
- **Catalog card**: long-press a book (right-click on desktop) to open its card. From there you can rate, set a status (unread / reading / finished), rename, move to a folder, edit tags, pin, change the cover, export as EPUB, view its stats, hide it or delete it.
- **Multi-select**: batch pin, move, tag, set covers, hide, change status or delete.
- **Organisation**: folders, tags (with suggestions taken from the book's own metadata), pinned books first, hidden books, and filter chips.
- **Re-import keeps everything**: importing the same book again updates the text and keeps your progress, notes, rating and history.

### Reading stats
- **Honest timer**: the clock stops after 90 seconds without input and stops immediately when the app goes to the background.
- **Views**: day, week, month, year and all-time, with comparison to the previous period, reading days, streaks and most-read books.
- **Read-throughs**: a book counts as read once progress passes 85% *and* this run's reading time reaches 40% of the estimated time (word count ÷ reading speed), so it adapts to both short and long books. The first time you mark a book finished by hand also counts once.
- **Ratings**: you're asked to rate a book when you finish it (only if it hasn't been rated yet). The library view shows your average rating and its 5-to-1 distribution.

### Import and export
- **Formats**: structured HTML, saved web pages, plain HTML (split into chapters by headings), and TXT (chapter detection; UTF-8 and GBK encodings detected automatically).
- **Paste import**: paste a book's HTML from the clipboard.
- **EPUB export**: share any book as an EPUB 3 file.
- **Backup and restore**: export all books, progress, notes and daily records to a single JSON file.
- **Offline**: a service worker caches the app, so it opens without a network.

## Technical notes

| Module | Description |
|---|---|
| `importer.js` | Parsing: DOMParser for HTML structure, TextDecoder with GB18030 fallback, regex-based TXT chapter detection, stable IDs from a hash of source or title and authors |
| `reader.js` | Layout and turning: one chapter at a time, `column-width` pagination, `translate3d` positioning; two-sheet double buffer for the curl, next chapter pre-laid-out while idle |
| `annotations.js` | Bookmarks, highlights and notes anchored by character offsets in each chapter's plain text (independent of layout) and re-located by quoted text after re-import; custom selection with cached glyph boxes and arithmetic hit-testing |
| `stats.js` | Reading clock (idle and background detection), read-through rule, stats page with pure HTML/CSS charts and rating distribution |
| `cover.js` | Cover cropper: fixed 2:3 frame, drag / pinch / wheel zoom, Canvas export and dominant-colour extraction |
| `library.js` | Library: filtering, catalog card, pickers, multi-select toolbar, custom dialogs |
| `epub.js` | EPUB 3 export: XHTML normalisation plus a minimal ZIP writer (store mode, CRC-32) |
| `ui.js` | Web Animations API motion: draggable bottom sheets, book open/close transitions, title fitting |
| `db.js` | IndexedDB wrapper; book metadata and text in separate stores so the library only loads light records |
| `app.js` | App shell: import, settings, debounced progress saving, backup and restore |
| `sw.js` | Network-first with cache fallback; a new release takes effect on the next launch |

Plain HTML, CSS and JavaScript: no framework, no dependencies, no build step.

## Run locally

```bash
python -m http.server 8000
```

Open `http://localhost:8000`. If your phone is on the same network, use your computer's LAN IP instead.

## Deploy

Push to GitHub, then in the repository go to **Settings → Pages** and serve the `main` branch from the root.

## Quick import from a web page (iPhone Shortcut)

A home-screen web app can't receive links from other apps directly, so this Shortcut copies a book to the clipboard and you paste it into Folio:

1. Open **Shortcuts**, create a new shortcut and name it "Save to Folio".
2. In its details, turn on **Show in Share Sheet** and set the input type to **URLs**.
3. Add **Get Contents of URL** with **Shortcut Input** as the input.
4. Add **Copy to Clipboard**.
5. Add **Show Notification** with the text "Copied, open Folio to paste".

To use it: long-press an HTML download link → Share → Save to Folio → open Folio → Import → Paste.
