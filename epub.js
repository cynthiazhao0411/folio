// epub.js — Export a book from the library as an EPUB 3 file (for sharing, or for
// opening in another reader). Includes a tiny ZIP writer: EPUB allows uncompressed
// ("stored") entries, so all we need is the ZIP headers and a CRC-32.

const Epub = {
  async build(meta, chapters) {
    const enc = new TextEncoder();
    const xml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const files = [];
    const add = (name, data) => files.push({ name, data: typeof data === 'string' ? enc.encode(data) : data });
    const title = xml(meta.title), author = xml(meta.authors.join('、') || '佚名');
    const uid = 'urn:folio:' + meta.id;

    add('mimetype', 'application/epub+zip');                          // must be first and uncompressed
    add('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

    const page = (t, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
<head><meta charset="UTF-8"/><title>${xml(t)}</title><link rel="stylesheet" href="style.css"/></head>
<body>${body}</body></html>`;
    add('OEBPS/style.css', `body{font-family:serif;line-height:1.8;margin:0 5%;}p{margin:0 0 .9em;text-indent:0;}
h1{text-align:center;font-size:1.4em;margin:2em 0 1.4em;}.notes{font-size:.85em;color:#777;border-left:2px solid #ccc;padding-left:.8em;margin:1em 0;}
.tp{text-align:center;margin-top:30%;}.tp h1{margin:0 0 .6em;}.tp p{color:#666;}img.cover{display:block;max-width:100%;max-height:100%;margin:0 auto;}`);

    // Cover image (only when the user set a custom one)
    let coverItem = '', coverMeta = '';
    if (meta.cover) {
      const bin = Uint8Array.from(atob(meta.cover.split(',')[1]), c => c.charCodeAt(0));
      add('OEBPS/cover.jpg', bin);
      add('OEBPS/cover.xhtml', page(meta.title, `<img class="cover" src="cover.jpg" alt="${title}"/>`));
      coverItem = `<item id="cover-img" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`;
      coverMeta = '<meta name="cover" content="cover-img"/>';
    }
    add('OEBPS/title.xhtml', page(meta.title, `<div class="tp"><h1>${title}</h1><p>${author} 著</p></div>`));

    // Chapters: the stored HTML is re-serialized as well-formed XHTML
    const toXhtml = html => {
      const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
      doc.querySelectorAll('script,style').forEach(n => n.remove());
      const ser = new XMLSerializer();
      return [...doc.body.childNodes].map(n => ser.serializeToString(n)).join('')
        .replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '');
    };
    chapters.forEach((c, i) => {
      const body = `<h1>${xml(c.title)}</h1>`
        + (c.notes ? `<div class="notes">${toXhtml(c.notes)}</div>` : '')
        + toXhtml(c.html)
        + (c.endNotes ? `<div class="notes">${toXhtml(c.endNotes)}</div>` : '');
      add(`OEBPS/ch${i + 1}.xhtml`, page(c.title, body));
    });

    const nav = chapters.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${xml(c.title)}</a></li>`).join('\n');
    add('OEBPS/nav.xhtml', page('目录', `<nav epub:type="toc" id="toc"><h1>目录</h1><ol>\n${nav}\n</ol></nav>`));
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    add('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${xml(uid)}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>${author}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${now}</meta>
    ${coverMeta}
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
    ${coverItem}
    ${chapters.map((_, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine>
    ${meta.cover ? '<itemref idref="cover"/>' : ''}
    <itemref idref="title"/>
    ${chapters.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('\n    ')}
  </spine>
</package>`);
    return new Blob([zip(files)], { type: 'application/epub+zip' });
  },
};

// ---- Minimal ZIP (stored entries only) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(d) { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);  // UTF-8 names
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(12, dosTime, true); cen.setUint16(14, dosDate, true); cen.setUint32(16, crc, true); cen.setUint32(20, size, true); cen.setUint32(24, size, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + size;
  }
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}
