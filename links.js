// links.js — Books from a pasted link, and the page information that comes with a file.
//
// Folio is a web page itself, so it can only read another site directly when that site allows
// it (CORS). When it does, a pasted link to a book page or a file is collected right here:
// the page's book information is read, its best e-book file (EPUB first) is downloaded and
// imported. When it does not, the 收书 bookmark is the way: it runs on the site's own page,
// where the same steps are allowed (collector.js uses the same rules as below).

const BOOK_EXT = ['epub', 'txt', 'pdf', 'zip', 'html'];

// The format a link points to: by its address (".epub", ".epub3.images", ".txt.utf-8"…) or
// by the type the server says it is
function fileExtOf(url, type = '') {
  const path = new URL(url).pathname.toLowerCase();
  const m = path.match(/\.(epub|txt|pdf|zip)(?:[.\d\w-]*)$/) || path.match(/\.(epub)\d?\.(?:images|noimages)$/);
  if (m) return m[1];
  if (/epub/.test(type)) return 'epub';
  if (/pdf/.test(type)) return 'pdf';
  if (/zip/.test(type)) return 'zip';
  if (/text\/plain/.test(type)) return 'txt';
  return '';
}

// Book information from a page: schema.org (JSON-LD, itemprop), Open Graph / book meta tags,
// then plain page elements
function pageMetaOf(doc, base) {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const meta = sel => clean(doc.querySelector(sel)?.getAttribute('content'));
  let ld = {};
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const all = [].concat(JSON.parse(s.textContent)).flatMap(x => x['@graph'] || [x]);
      const b = all.find(x => /Book|CreativeWork|Novel/.test([].concat(x['@type']).join(' ')));
      if (b) { ld = b; break; }
    } catch { /* not JSON */ }
  }
  const names = v => [].concat(v || []).map(a => clean(typeof a === 'string' ? a : a?.name)).filter(Boolean);
  let authors = names(ld.author);
  if (!authors.length) authors = [...doc.querySelectorAll('[itemprop="author"], [itemprop="creator"], a[rel="author"]')].map(e => clean(e.getAttribute('content') || e.textContent)).filter(Boolean).slice(0, 4);
  if (!authors.length) { const a = meta('meta[name="author"]') || meta('meta[property="book:author"]'); if (a) authors = [a]; }
  const image = [].concat(ld.image || [])[0];
  const cover = (typeof image === 'string' ? image : image?.url) || meta('meta[property="og:image"]') || meta('meta[name="twitter:image"]')
    || doc.querySelector('[itemprop="image"]')?.getAttribute('src') || doc.querySelector('img[class*="cover" i]')?.getAttribute('src') || '';
  return {
    title: clean(ld.name) || meta('meta[property="og:title"]') || clean(doc.querySelector('[itemprop="name"]')?.textContent) || clean(doc.querySelector('h1')?.textContent) || clean(doc.title),
    authors: [...new Set(authors)],
    summary: clean(ld.description) || meta('meta[property="og:description"]') || meta('meta[name="description"]') || clean(doc.querySelector('[itemprop="description"]')?.textContent),
    cover: cover ? new URL(cover, base).href : '',
    url: base.split('#')[0],
  };
}

// The e-book files a page links to, best format first
function fileLinksOf(doc, base) {
  const seen = new Set(), out = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    let url;
    try { url = new URL(a.getAttribute('href'), base).href; } catch { continue; }
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    const ext = fileExtOf(url);
    if (!ext) continue;
    seen.add(url);
    out.push({ url, ext, label: (a.textContent || '').replace(/\s+/g, ' ').trim() });
  }
  return out.sort((a, b) => BOOK_EXT.indexOf(a.ext) - BOOK_EXT.indexOf(b.ext));
}

// A downloaded file plus what its page said: the file's own information wins, the page fills gaps
async function booksFromFile(blob, name, meta) {
  const out = await Importer.parseFile(blob, name);
  if (!meta) return out;
  const base = name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  for (const r of out) {
    const b = r.book;
    if (!b) continue;
    if (meta.title && (!b.title || b.title === base || /^收到的作品/.test(b.title))) b.title = meta.title;
    if (!b.authors?.length && meta.authors?.length) b.authors = normalizeAuthors(meta.authors);
    if (!b.summary && meta.summary) b.summary = `<p>${escapeHtml(meta.summary)}</p>`;
    if (!b.source && meta.url) { b.source = meta.url; Importer.finish(b); }   // the same page always gives the same book
    if (!b.cover && /^data:image\//.test(meta.cover || '')) {
      try {
        const bytes = Uint8Array.from(atob(meta.cover.split(',')[1]), c => c.charCodeAt(0));
        Object.assign(b, await coverFromBytes(bytes, meta.cover.slice(5, meta.cover.indexOf(';'))));
      } catch { /* keep the generated cover */ }
    }
  }
  return out;
}

const LinkImport = {
  // Returns { sources, failed } for importBooks, or { blocked } when the site does not let Folio read it
  async collect(link, onStep) {
    const host = new URL(link).hostname.replace(/^www\./, '');
    const get = async url => {
      try { return await fetch(url, { credentials: 'omit' }); }
      catch { return null; }                          // the site does not allow it (or no network)
    };
    onStep?.('正在打开链接…');
    const res = await get(link);
    if (!res) return { blocked: host };
    if (!res.ok) return { error: `打不开这个链接（${res.status}）` };
    const type = res.headers.get('content-type') || '';
    let fileUrl = link, fileRes = res, meta = null;
    if (!fileExtOf(link, type)) {
      if (!/html/.test(type)) return { error: '这个链接既不是电子书文件，也不是网页' };
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      meta = pageMetaOf(doc, link);
      const files = fileLinksOf(doc, link);
      if (!files.length) return { error: `在「${meta.title || host}」这个页面上没有找到可以下载的电子书文件（EPUB、TXT、PDF、ZIP）` };
      fileUrl = files[0].url;
      onStep?.(`《${meta.title}》正在下载 ${files[0].ext.toUpperCase()}…`);
      fileRes = await get(fileUrl);
      if (!fileRes) return { blocked: new URL(fileUrl).hostname.replace(/^www\./, ''), meta };
      if (!fileRes.ok) return { error: `下载失败（${fileRes.status}）` };
      if (meta.cover) {                               // the cover picture, when the site allows reading it
        const c = await get(meta.cover);
        if (c?.ok && /^image\//.test(c.headers.get('content-type') || '')) {
          const blob = await c.blob();
          if (blob.size < 1.5 * 1048576) meta.cover = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(''); fr.readAsDataURL(blob); });
          else meta.cover = '';
        } else meta.cover = '';
      }
    }
    const ext = fileExtOf(fileUrl, fileRes.headers.get('content-type') || '') || 'epub';
    const name = (meta?.title || decodeURIComponent(new URL(fileUrl).pathname.split('/').pop()).replace(/\.[^.]+$/, '') || 'book').slice(0, 60) + '.' + ext;
    const results = await booksFromFile(await fileRes.blob(), name, meta || { url: link });
    return { sources: results.filter(r => r.book), failed: results.filter(r => r.error) };
  },
};
