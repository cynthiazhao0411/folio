// formats.js — Container formats: ZIP files, EPUB books and PDF documents.
// Each produces the same book object as importer.js; EPUB and PDF reuse its HTML and
// TXT parsers wherever the content allows, so a book is recognised the same way
// whichever format it arrived in.

// ================= ZIP =================
// Reads the central directory, then inflates single entries on demand with the
// browser's own DecompressionStream (no library needed).
const Zip = {
  async open(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let end = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('不是有效的压缩文件');
    const count = dv.getUint16(end + 10, true);
    let p = dv.getUint32(end + 16, true);
    const entries = new Map();
    for (let k = 0; k < count && dv.getUint32(p, true) === 0x02014b50; k++) {
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const size = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const offset = dv.getUint32(p + 42, true);
      const raw = buf.subarray(p + 46, p + 46 + nlen);
      const name = flags & 0x800 ? new TextDecoder().decode(raw) : decodeText(raw);   // non-UTF-8 names: often GBK
      if (!name.endsWith('/')) entries.set(name, { method, size, offset });
      p += 46 + nlen + xlen + clen;
    }
    const find = name => entries.get(name) || entries.get([...entries.keys()].find(k => k.toLowerCase() === name.toLowerCase()));
    return {
      names: [...entries.keys()],
      has: name => !!find(name),
      async bytes(name) {
        const e = find(name);
        if (!e) throw new Error('压缩包里缺少 ' + name);
        const nlen = dv.getUint16(e.offset + 26, true), xlen = dv.getUint16(e.offset + 28, true);
        const data = buf.subarray(e.offset + 30 + nlen + xlen, e.offset + 30 + nlen + xlen + e.size);
        if (e.method === 0) return data;
        if (e.method !== 8) throw new Error('不支持的压缩方式');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      },
      async text(name) { return decodeText(await this.bytes(name)); },
    };
  },
};

// Resolve a relative href inside the ZIP ("../Text/ch1.xhtml#x" from "OEBPS/nav.xhtml")
function zipPath(base, href) {
  const u = new URL(href, 'http://zip/' + base);
  return decodeURIComponent(u.pathname.slice(1));
}

// ================= EPUB =================
async function parseEpub(zip, fallbackTitle) {
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const container = xml(await zip.text('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB 缺少目录信息');
  const opf = xml(await zip.text(opfPath));
  const dc = tag => [...opf.getElementsByTagNameNS('*', tag)].map(e => e.textContent.trim()).filter(Boolean);

  const title = dc('title')[0] || fallbackTitle;
  const authors = dc('creator');
  const desc = dc('description')[0] || '';
  const summary = /<[a-z][\s\S]*>/i.test(desc) ? desc : desc ? `<p>${escapeHtml(desc)}</p>` : '';
  const subjects = dc('subject');
  const tags = subjects.length ? { Tags: subjects } : {};
  const source = [...dc('identifier'), ...dc('source')].find(u => /^https?:\/\/.+\/\d{4,}/.test(u)) || '';

  // Manifest and reading order
  const items = new Map();
  for (const it of opf.getElementsByTagNameNS('*', 'item')) {
    items.set(it.getAttribute('id'), {
      path: zipPath(opfPath, it.getAttribute('href')),
      type: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  }
  const spine = [...opf.getElementsByTagNameNS('*', 'itemref')]
    .map(r => items.get(r.getAttribute('idref')))
    .filter(it => it && /html|xml/.test(it.type));

  // Table of contents: EPUB 3 nav document, or the EPUB 2 NCX
  const toc = new Map();                     // file path -> chapter title (first entry per file)
  const addToc = (path, label) => { if (label && !toc.has(path)) toc.set(path, label.replace(/\s+/g, ' ').trim()); };
  const navItem = [...items.values()].find(it => /\bnav\b/.test(it.props));
  const ncxItem = [...items.values()].find(it => /dtbncx/.test(it.type));
  if (navItem && zip.has(navItem.path)) {
    const nav = new DOMParser().parseFromString(await zip.text(navItem.path), 'text/html');
    const list = nav.querySelector('nav[epub\\:type="toc"], nav[*|type="toc"]') || nav.querySelector('nav') || nav;
    list.querySelectorAll('a[href]').forEach(a => addToc(zipPath(navItem.path, a.getAttribute('href')).split('#')[0], a.textContent));
  } else if (ncxItem && zip.has(ncxItem.path)) {
    const ncx = xml(await zip.text(ncxItem.path));
    for (const np of ncx.getElementsByTagNameNS('*', 'navPoint')) {
      const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent;
      const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
      if (src) addToc(zipPath(ncxItem.path, src).split('#')[0], label);
    }
  }

  // Read every spine document's body
  const bodies = [];
  for (const it of spine) {
    if (!zip.has(it.path)) continue;
    const doc = new DOMParser().parseFromString(await zip.text(it.path), 'text/html');
    doc.querySelectorAll('script, style, img, svg, image, link').forEach(n => n.remove());
    bodies.push({ path: it.path, body: doc.body });
  }

  let book = null;
  // Books generated from a structured HTML export keep its layout: parse them exactly
  // like that export, so the EPUB and the HTML of the same work are the same book.
  const merged = new DOMParser().parseFromString('<!doctype html><html><body></body></html>', 'text/html');
  for (const b of bodies) merged.body.insertAdjacentHTML('beforeend', b.body.innerHTML);
  const boxes = merged.querySelectorAll('#chapters');
  if (merged.querySelector('#preface') && boxes.length) {
    for (const extra of [...boxes].slice(1)) { boxes[0].append(...extra.childNodes); extra.remove(); }
    const s = parseStructured(merged);
    if (s.chapters.some(c => c.html.trim())) book = { ...s, source: s.source || source };
  }

  if (!book) {
    const chapters = [];
    for (const { path, body } of bodies) {
      const text = body.textContent.trim();
      if (!text) continue;
      const label = toc.get(path);
      const head = body.querySelector('h1, h2, h3');
      // Drop a leading heading that repeats the chapter title (the reader shows the title itself)
      if (head && label && head.textContent.replace(/\s+/g, ' ').trim() === label) head.remove();
      const html = body.innerHTML;
      if (label || !chapters.length || !toc.size) {
        chapters.push({ title: label || (head && txt(head)) || (chapters.length ? `第${chapters.length + 1}节` : title), notes: '', html, endNotes: '' });
      } else {
        chapters[chapters.length - 1].html += html;          // a chapter split across files
      }
    }
    book = { title, authors, summary, tags, source, chapters: chapters.filter(c => c.html.replace(/<[^>]+>/g, '').trim()) };
  }
  if (!book.authors.length) book.authors = authors;
  if (!book.summary) book.summary = summary;

  // Cover image, if the book has one
  const coverId = [...opf.getElementsByTagNameNS('*', 'meta')].find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem = [...items.values()].find(it => /cover-image/.test(it.props)) || items.get(coverId);
  if (coverItem && /^image\//.test(coverItem.type)) {
    try { Object.assign(book, await coverFromBytes(await zip.bytes(coverItem.path), coverItem.type)); } catch { /* keep the generated cover */ }
  }
  return book;
}

// Fit an image into the 2:3 cover frame; returns { cover, coverColor }
async function coverFromBytes(bytes, type) {
  const bmp = await createImageBitmap(new Blob([bytes], { type }));
  const c = document.createElement('canvas');
  c.width = 600; c.height = 900;
  const k = Math.max(c.width / bmp.width, c.height / bmp.height);
  const w = bmp.width * k, h = bmp.height * k;
  c.getContext('2d').drawImage(bmp, (c.width - w) / 2, (c.height - h) / 2, w, h);
  return { cover: c.toDataURL('image/jpeg', .86), coverColor: CoverEditor.averageColor(c) };
}

// ================= PDF =================
// Text only: lines are rebuilt from positioned text, page numbers and running headers
// are dropped, lines are joined into paragraphs, then the TXT parser finds the chapters.
// pdf.js (about 1.8 MB) is loaded only the first time a PDF is imported.
async function parsePdf(file, fallbackTitle) {
  const pdfjs = await import('./lib/pdf/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('lib/pdf/pdf.worker.min.mjs', location.href).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const info = (await pdf.getMetadata().catch(() => null))?.info || {};

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const { items } = await page.getTextContent();
    const lines = [];
    for (const it of items) {
      if (!it.str) continue;
      const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
      let line = lines.find(l => Math.abs(l.y - y) < h * .5);
      if (!line) lines.push(line = { y, h, parts: [] });
      line.parts.push({ x, w: it.width, s: it.str });
    }
    for (const l of lines) {
      l.parts.sort((a, b) => a.x - b.x);
      l.x0 = l.parts[0].x;
      l.x1 = Math.max(...l.parts.map(p => p.x + p.w));
      // Some fonts map characters to look-alike radicals (⾬ for 雨); NFKC restores just those,
      // leaving full-width punctuation alone
      l.text = l.parts.map(p => p.s).join('').replace(/[\u2e80-\u2fdf\uf900-\ufaff]/g, c => c.normalize('NFKC')).replace(/\s+/g, ' ').trim();
    }
    pages.push(lines.filter(l => l.text).sort((a, b) => b.y - a.y));   // top to bottom
    page.cleanup();
  }

  // Running headers / footers: the same first or last line on many pages
  const norm = s => s.replace(/\d+/g, '#');
  const freq = new Map();
  for (const ls of pages) for (const l of [ls[0], ls[ls.length - 1]]) if (l) freq.set(norm(l.text), (freq.get(norm(l.text)) || 0) + 1);
  const repeated = s => pages.length >= 3 && freq.get(norm(s)) >= Math.max(3, pages.length * .4);
  const pageNo = s => /^[-–—\s]*(\d+|[ivxlc]+)[-–—\s]*$/i.test(s) || /^第\s*\d+\s*页/.test(s) || /^\d+\s*\/\s*\d+$/.test(s);

  const all = pages.flatMap((ls, pi) => ls.filter((l, i) => !pageNo(l.text) && !((i === 0 || i === ls.length - 1) && repeated(l.text))).map(l => ({ ...l, pi })));
  if (!all.length) throw new Error('这个 PDF 里没有可读的文字（可能是扫描图片）');
  const left = Math.min(...all.map(l => l.x0));
  const widths = all.map(l => l.x1 - left).sort((a, b) => a - b);
  const full = widths[Math.floor(widths.length * .9)];
  const gaps = [];
  for (let i = 1; i < all.length; i++) if (all[i].pi === all[i - 1].pi) gaps.push(all[i - 1].y - all[i].y);
  gaps.sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)] || 14;

  const paras = [];
  let cur = '';
  all.forEach((l, i) => {
    const prev = all[i - 1];
    const indent = l.x0 - left > l.h * .8;
    const short = prev && prev.x1 - left < full * .85;
    const ended = prev && /[。！？!?.…”」』"）)]$/.test(prev.text);
    const far = prev && prev.pi === l.pi && prev.y - l.y > gap * 1.6;
    if (!prev || indent || far || (short && ended) || CHAPTER_LINE.test(l.text) || CHAPTER_LINE.test(prev.text)) {
      if (cur) paras.push(cur);
      cur = l.text;
    } else {
      cur += /[A-Za-z0-9,]$/.test(cur) && /^[A-Za-z0-9]/.test(l.text) ? ' ' + l.text : l.text;   // CJK lines join without a space
    }
  });
  if (cur) paras.push(cur);

  const title = (info.Title || '').trim() || fallbackTitle;
  const book = parseTxt(paras.join('\n'), title);
  if (info.Author) book.authors = [info.Author.trim()];
  return book;
}
