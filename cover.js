// cover.js — Custom covers: pick a photo, frame it in a fixed 2:3 window, confirm.
// Nothing is applied until the user taps “使用”. Drag to move; pinch, scroll or use
// the slider to zoom. The image is clamped so it always fills the frame.

const CoverEditor = {
  OUT_W: 600, OUT_H: 900,

  // Resolves to { image: dataURL, color: '#rrggbb' } or null if cancelled
  open(file) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => this.show(img, url, resolve);
      img.onerror = () => { URL.revokeObjectURL(url); toast('无法读取这张图片'); resolve(null); };
      img.src = url;
    });
  },

  show(img, url, resolve) {
    const root = document.createElement('div');
    root.className = 'cropper';
    root.innerHTML = `
      <div class="cr-top">
        <button data-act="cancel">取消</button>
        <span>调整封面</span>
        <button data-act="ok" class="primary">使用</button>
      </div>
      <div class="cr-stage"><div class="cr-frame"></div></div>
      <div class="cr-bottom">
        <input class="cr-zoom" type="range" min="1" max="4" step="0.01" value="1" aria-label="缩放">
        <p>拖动调整位置 · 双指或滑块缩放</p>
      </div>`;
    document.body.appendChild(root);
    const stage = root.querySelector('.cr-stage'), frame = root.querySelector('.cr-frame'), zoom = root.querySelector('.cr-zoom');
    img.className = 'cr-img';
    img.draggable = false;
    stage.insertBefore(img, frame);

    // Frame: as large as fits, always 2:3
    const sw = stage.clientWidth, sh = stage.clientHeight;
    const fw = Math.min(sw * .74, sh * .82 * 2 / 3), fh = fw * 1.5;
    Object.assign(frame.style, { width: fw + 'px', height: fh + 'px' });
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const base = Math.max(fw / iw, fh / ih);              // zoom 1 = image just covers the frame
    img.style.width = iw * base + 'px';
    img.style.height = ih * base + 'px';

    let z = 1, tx = 0, ty = 0;
    const clamp = () => {
      const mx = (iw * base * z - fw) / 2, my = (ih * base * z - fh) / 2;
      tx = Math.max(-mx, Math.min(mx, tx));
      ty = Math.max(-my, Math.min(my, ty));
    };
    const draw = () => {
      clamp();
      img.style.transform = `translate(-50%,-50%) translate(${tx}px,${ty}px) scale(${z})`;
      zoom.value = z;
    };
    const setZoom = nz => { z = Math.max(1, Math.min(4, nz)); draw(); };
    draw();
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });

    // Drag with one pointer, pinch with two
    const pts = new Map();
    let pinch = 0;
    stage.addEventListener('pointerdown', e => {
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    stage.addEventListener('pointermove', e => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 1) { tx += e.clientX - p.x; ty += e.clientY - p.y; }
      p.x = e.clientX; p.y = e.clientY;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) z *= d / pinch;
        pinch = d;
        z = Math.max(1, Math.min(4, z));
      }
      draw();
    });
    const up = e => { pts.delete(e.pointerId); pinch = 0; };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', e => { e.preventDefault(); setZoom(z * Math.exp(-e.deltaY * .002)); }, { passive: false });
    zoom.addEventListener('input', () => setZoom(+zoom.value));

    const close = async result => {
      await root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).finished;
      root.remove();
      URL.revokeObjectURL(url);
      resolve(result);
    };
    root.querySelector('.cr-top').onclick = e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'cancel') close(null);
      if (act === 'ok') close(this.render(img, { iw, ih, fw, fh, k: base * z, tx, ty }));
    };
  },

  // Cut the framed area out of the original image at full resolution
  render(img, { iw, ih, fw, fh, k, tx, ty }) {
    const c = document.createElement('canvas');
    c.width = this.OUT_W; c.height = this.OUT_H;
    const g = c.getContext('2d');
    const sx = iw / 2 + (-fw / 2 - tx) / k, sy = ih / 2 + (-fh / 2 - ty) / k;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, sx, sy, fw / k, fh / k, 0, 0, c.width, c.height);
    return { image: c.toDataURL('image/jpeg', .86), color: this.averageColor(c) };
  },

  // A darkened average of the cover, used for the full-bleed info page behind white text
  averageColor(canvas) {
    const s = document.createElement('canvas');
    s.width = 12; s.height = 18;
    const g = s.getContext('2d');
    g.drawImage(canvas, 0, 0, 12, 18);
    const d = g.getImageData(0, 0, 12, 18).data;
    let r = 0, gr = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4, f = .62;                       // darken so white text stays readable
    const hex = v => Math.round(v / n * f).toString(16).padStart(2, '0');
    return '#' + hex(r) + hex(gr) + hex(b);
  },
};
