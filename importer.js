// importer.js — Converts e-book files into a common book object
//
//   { id, title, authors, summary, tags, chapters: [{ title, notes, html, endNotes }] }
//
// Supported inputs:
//   1. Structured HTML exports (a #preface metadata block plus #chapters)
//   2. Plain HTML (chapters split on <h1>/<h2>/<h3> headings)
//   3. Plain text (chapter headings detected by pattern; UTF-8 / GBK auto-detected)
//   4. A saved full-work web page (from the share-sheet shortcut), see parseWorkPage
//   5. EPUB, PDF, and ZIP files holding any of these (formats.js)

const Importer = {
  async parse(file) {
    const text = decodeText(await file.arrayBuffer());
    return this.parseText(text, file.name.replace(/\.[^.]+$/, ''), /\.txt$/i.test(file.name));
  },

  // Any supported file -> [{ book, label }]; a ZIP can hold many books.
  // Files that cannot be read come back as { error, label }.
  async parseFile(file, name = file.name) {
    const base = name.replace(/^.*\//, '').replace(/\.[^.]+$/, ''), label = name.replace(/^.*\//, '');
    const ext = (name.match(/\.([^.\/]+)$/) || [])[1]?.toLowerCase() || '';
    try {
      if (ext === 'pdf') return [{ book: this.finish(await parsePdf(file, base)), label }];
      if (ext === 'epub' || ext === 'zip') {
        const zip = await Zip.open(file);
        if (zip.has('META-INF/container.xml')) return [{ book: this.finish(await parseEpub(zip, base)), label }];
        const out = [];
        for (const n of zip.names) {
          if (/(^|\/)(__MACOSX|\.)/.test(n) || !/\.(html?|txt|epub|pdf)$/i.test(n)) continue;
          out.push(...await this.parseFile(new Blob([await zip.bytes(n)]), n));
        }
        if (!out.length) return [{ error: '压缩包里没有可导入的文件', label }];
        return out;
      }
      const text = decodeText(await file.arrayBuffer());
      return [{ book: this.parseText(text, base, ext === 'txt'), label }];
    } catch (err) {
      console.error(err);
      // pdf.js reports in English; say it plainly
      const msg = err?.name === 'InvalidPDFException' || /Invalid PDF|PDF header/i.test(err?.message || '') ? '不是有效的 PDF 文件'
        : err?.name === 'PasswordException' ? '这个 PDF 有密码保护，Folio 打不开' : err.message;
      return [{ error: msg, label }];
    }
  },
  finish(book) {
    book.id = 'b-' + hash(book.source || book.title + '|' + book.authors.join(','));
    book.authors = normalizeAuthors(book.authors, book.source);
    return book;
  },

  // Also used for pasted text: HTML is recognized by its tags, anything else is plain text
  parseText(text, name, isTxt = !/<html|<body|<div|<p[\s>]/i.test(text.slice(0, 4000))) {
    const book = isTxt ? parseTxt(text, name) : parseHtml(text, name);
    // Stable id: re-importing the same book replaces it and keeps reading progress
    book.id = 'b-' + hash(book.source || book.title + '|' + book.authors.join(','));
    book.authors = normalizeAuthors(book.authors, book.source);    // after the id, which must stay stable
    return book;
  },
};

// Author names, the same way for every import channel (HTML export, work page, EPUB, PDF,
// TXT, the bookmark's inbox):
//   • whitespace tidied, empty names dropped, duplicates removed
//   • "anonymous" in any capitalisation is the author "Anonymous", a real name like any other
//   • a work that came from a work page (its source is a /works/ link) but names no author was
//     posted anonymously, so it is "Anonymous" too. Books with no source and no author (a TXT
//     file, say) stay without one: their author is unknown, not anonymous.
function normalizeAuthors(list, source) {
  const out = [];
  for (const raw of list || []) {
    let a = String(raw ?? '').replace(/\s+/g, ' ').replace(/^by\s+/i, '').trim();
    if (!a) continue;
    if (/^anonymous$/i.test(a)) a = 'Anonymous';
    if (!out.includes(a)) out.push(a);
  }
  if (!out.length && /\/works\/\d+/.test(source || '')) out.push('Anonymous');
  return out;
}

// ---------- Encoding: try strict UTF-8, fall back to GB18030 (superset of GBK) ----------
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('gb18030').decode(buf); }
}

// FNV-1a string hash for stable book ids
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

const txt = el => (el ? el.textContent.trim() : '');

// Authors from a byline. Linked authors come first; an unlinked byline (anonymous works have
// no author link) is read as plain text, so "Anonymous" is kept like any other author name.
function bylineAuthors(root) {
  const linked = [...(root?.querySelectorAll('.byline a[rel="author"]') || [])].map(txt).filter(Boolean);
  if (linked.length) return linked;
  const plain = txt(root?.querySelector('.byline')).replace(/^\s*by\s+/i, '').trim();
  return plain ? [plain] : [];
}

// ---------- HTML ----------
function parseHtml(html, fallbackTitle) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('#preface') && doc.querySelector('#chapters')) return parseStructured(doc);
  if (doc.querySelector('dl.work.meta') && doc.querySelector('#chapters')) {
    const book = parseWorkPage(doc);
    if (book.chapters.length) return book;
  }
  return parsePlainHtml(doc, fallbackTitle);
}

// A full-work web page, as saved by the share-sheet shortcut (which also adds
// <meta name="folio-source">). Same information as the structured export, laid out differently:
//   .preface h2.title, h3.byline a[rel=author], .summary blockquote
//   dl.work.meta: <dt class="relationship">Relationships:</dt><dd>…links…</dd>, and a nested
//                 dl.stats for Published / Completed / Words / Chapters
//   #chapters > .chapter: .chapter.preface h3.title, .notes blockquote, .userstuff (text), .end.notes
//   (single-chapter works put .userstuff straight inside #chapters)
function parseWorkPage(doc) {
  const pre = doc.querySelector('.preface.group');
  const title = txt(pre?.querySelector('h2.title')) || txt(doc.querySelector('title'));
  const authors = bylineAuthors(pre);
  const summary = pre?.querySelector('.summary blockquote')?.innerHTML || '';

  const tags = {};
  doc.querySelectorAll('dl.work.meta > dt').forEach(dt => {
    const key = txt(dt).replace(/:$/, ''), dd = dt.nextElementSibling;
    if (!dd || !key) return;
    const inner = dd.querySelector('dl');
    if (inner) {                                    // stats: "Published: … Words: …"
      tags[key] = [[...inner.querySelectorAll('dt')].map(d => `${txt(d)} ${txt(d.nextElementSibling)}`).join(' ')];
    } else if (dd.querySelector('.position')) {     // series: just the series names
      tags[key] = [...dd.querySelectorAll('.position a[href*="/series/"]')].map(txt);
    } else {
      const links = [...dd.querySelectorAll('a')].map(txt);
      tags[key] = links.length ? links : [txt(dd)];
    }
  });

  // Same source URL format as the structured export, so both kinds of import update the same book
  const src = doc.querySelector('meta[name="folio-source"]')?.content || '';
  const source = src.replace(/(\/\d{4,})[\/?#].*$/, '$1');

  const cleanText = el => { el = el.cloneNode(true); el.querySelectorAll('.landmark').forEach(n => n.remove()); return el.innerHTML; };
  const chapters = [];
  const box = doc.querySelector('#chapters');
  const parts = box.querySelectorAll(':scope > .chapter');
  if (parts.length) {
    parts.forEach((ch, i) => {
      const head = txt(ch.querySelector('.chapter.preface h3.title')).replace(/\s+/g, ' ');
      const m = head.match(/^Chapter\s+(\d+)(?::\s*(.+))?$/i);
      const text = ch.querySelector(':scope > .userstuff');
      chapters.push({
        title: m ? (m[2] || `第${m[1]}章`) : head || `第${i + 1}章`,
        notes: ch.querySelector('.chapter.preface .notes:not(.end) blockquote')?.innerHTML || '',
        html: text ? cleanText(text) : '',
        endNotes: ch.querySelector('.end.notes blockquote')?.innerHTML || '',
      });
    });
  } else {
    const text = box.querySelector('.userstuff');
    if (text) chapters.push({ title, notes: '', html: cleanText(text), endNotes: '' });
  }
  // The author's notes for the whole work: before the first chapter and after the last
  const workNotes = pre?.querySelector(':scope > .notes blockquote')?.innerHTML || '';
  const workEnd = doc.querySelector('#work_endnotes blockquote')?.innerHTML || '';
  const kept = chapters.filter(c => c.html.trim());
  if (kept.length) {
    if (workNotes) kept[0].notes = workNotes + (kept[0].notes ? '<hr>' + kept[0].notes : '');
    if (workEnd) { const last = kept[kept.length - 1]; last.endNotes = (last.endNotes ? last.endNotes + '<hr>' : '') + workEnd; }
  }
  return { title, authors, summary, tags, source, chapters: kept };
}

// Structured export layout:
//   #preface  title (h1), author (.byline), metadata table (dl/dt/dd), summary (blockquote)
//   #chapters alternating blocks:
//     <div class="meta">      chapter heading (h2.heading) + opening notes </div>
//     <div class="userstuff"> chapter body </div>
//     (optional) <div class="meta"> end notes </div>
function parseStructured(doc) {
  const preface = doc.querySelector('#preface');
  const title = txt(preface.querySelector('.meta h1')) || txt(doc.querySelector('title'));
  const authors = bylineAuthors(preface);
  const summary = preface.querySelector('blockquote')?.innerHTML || '';

  const tags = {};
  preface.querySelectorAll('dl dt').forEach(dt => {
    const key = txt(dt).replace(/:$/, '');
    const dd = dt.nextElementSibling;
    if (!dd) return;
    const links = [...dd.querySelectorAll('a')].map(txt);
    tags[key] = links.length ? links : [txt(dd)];
  });

  // Source URL (first link containing a long numeric id) identifies the same book across imports
  const source = [...preface.querySelectorAll('a[href]')]
    .map(a => a.getAttribute('href')).find(h => /\/\d{4,}/.test(h)) || '';

  const chapters = [];
  let cur = null;
  for (const el of doc.querySelector('#chapters').children) {
    const heading = el.querySelector?.('h2.heading');
    if (el.matches('.meta') && heading) {
      const raw = txt(heading);
      const m = raw.match(/^Chapter\s+(\d+)(?::\s*(.+))?$/i);   // e.g. "Chapter 5: Title"
      cur = { title: m ? (m[2] || `第${m[1]}章`) : raw,
              notes: el.querySelector('blockquote')?.innerHTML || '', html: '', endNotes: '' };
      chapters.push(cur);
    } else if (el.matches('.userstuff')) {
      if (!cur) { cur = { title, notes: '', html: '', endNotes: '' }; chapters.push(cur); }  // single-chapter work
      cur.html += el.innerHTML;
    } else if (el.matches('.meta') && cur) {
      cur.endNotes += el.querySelector('blockquote')?.innerHTML || '';
    }
  }
  return { title, authors, summary, tags, source, chapters };
}

// Plain HTML: split on the highest heading level that appears at least twice
function parsePlainHtml(doc, fallbackTitle) {
  const body = doc.body;
  body.querySelectorAll('script, style, nav, iframe').forEach(n => n.remove());
  const title = txt(doc.querySelector('title')) || txt(body.querySelector('h1')) || fallbackTitle;
  const author = doc.querySelector('meta[name="author"]')?.content || '';
  const level = ['h1', 'h2', 'h3'].find(h => body.querySelectorAll(h).length >= 2);

  const chapters = [];
  if (!level) {
    chapters.push({ title, notes: '', html: body.innerHTML, endNotes: '' });
  } else {
    // Walk the tree; each heading at the chosen level starts a new chapter
    let cur = { title: '开篇', notes: '', html: '', endNotes: '' };
    const flush = () => { if (cur.html.trim()) chapters.push(cur); };
    const walk = node => {
      for (const n of [...node.childNodes]) {
        if (n.nodeType === 1 && n.tagName.toLowerCase() === level) {
          flush();
          cur = { title: txt(n), notes: '', html: '', endNotes: '' };
        } else if (n.nodeType === 1 && n.querySelector(level)) {
          walk(n);                               // heading is nested deeper; recurse
        } else {
          cur.html += n.nodeType === 1 ? n.outerHTML : (n.textContent.trim() ? `<p>${escapeHtml(n.textContent)}</p>` : '');
        }
      }
    };
    walk(body);
    flush();
  }
  return { title, authors: author ? [author] : [], summary: '', tags: {}, source: '', chapters };
}

// ---------- TXT ----------
const CHAPTER_LINE = /^\s*(第[零〇一二两三四五六七八九十百千万\d]+[章回节卷集部篇].{0,30}|(Chapter|CHAPTER)\s+\d+.{0,40}|番外([\s\d一二三四五六七八九十：:·.-]+.{0,20})?|序章|楔子|尾声|后记)\s*$/;

function parseTxt(text, title) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chapters = [];
  let cur = { title: '开篇', notes: '', html: '', endNotes: '' };
  for (const line of lines) {
    // Looks like a heading and does not end with sentence punctuation
    if (CHAPTER_LINE.test(line) && !/[。！？…”"]\s*$/.test(line)) {
      if (cur.html) chapters.push(cur);
      cur = { title: line.trim(), notes: '', html: '', endNotes: '' };
    } else if (line.trim()) {
      cur.html += `<p>${escapeHtml(line.trim())}</p>`;
    }
  }
  if (cur.html) chapters.push(cur);
  if (chapters.length === 1 && chapters[0].title === '开篇') chapters[0].title = title;
  return { title, authors: [], summary: '', tags: {}, source: '', chapters };
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
