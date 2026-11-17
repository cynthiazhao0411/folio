// importer.js — Converts e-book files into a common book object
//
//   { id, title, authors, summary, tags, chapters: [{ title, notes, html, endNotes }] }
//
// Supported inputs:
//   1. Structured HTML exports (a #preface metadata block plus #chapters)
//   2. Plain HTML (chapters split on <h1>/<h2>/<h3> headings)
//   3. Plain text (chapter headings detected by pattern; UTF-8 / GBK auto-detected)

const Importer = {
  async parse(file) {
    const buf = await file.arrayBuffer();
    const text = decodeText(buf);
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const book = /\.txt$/i.test(file.name)
      ? parseTxt(text, baseName)
      : parseHtml(text, baseName);
    // Stable id: re-importing the same book replaces it and keeps reading progress
    book.id = 'b-' + hash(book.source || book.title + '|' + book.authors.join(','));
    return book;
  },
};

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

// ---------- HTML ----------
function parseHtml(html, fallbackTitle) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  if (doc.querySelector('#preface') && doc.querySelector('#chapters')) return parseStructured(doc);
  return parsePlainHtml(doc, fallbackTitle);
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
  const authors = [...preface.querySelectorAll('.byline a[rel="author"]')].map(txt);
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
