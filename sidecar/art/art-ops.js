/* sidecar/art/art-ops.js — deterministic image operations for the art line (Art Studio Phase 1b).

   The Designer agent decides WHAT to do with a design (which product, where on it, which fabric). These functions
   do it: exact pixel sizes, exact placement inside a print area, measurable facts about the artwork. Nothing here is
   generative and nothing guesses — the same bytes and options always give the same bytes back.

   THE RULES THIS FILE KEEPS
   · Buffers in, buffers out. No file is read or written here (the tool layer owns paths, the workspace jail and the
     originals-are-never-modified rule).
   · Never stretch, never silently upscale. place() refuses with ART_TOO_SMALL when the artwork would print below
     the placement's minimum DPI; the caller reports that, it does not get a blurry file.
   · Never fake a cutout. removeBackground() only keys out a FLAT background it measured at the border, and says
     `removed:false` with the reason when there is none. AI matting is out of scope for v1.
   · Every result carries the numbers it was computed from, so the Gallery and the Reviewer can show facts.

   The image library is injected (`deps.canvas`): { createCanvas(w,h), loadImage(buffer) } — @napi-rs/canvas in the
   app (proved in an installed Windows build by .github/workflows/art-canvas-windows.yml), swappable behind this
   one seam. Errors are ArtError with a stable `code`. */
'use strict';

class ArtError extends Error {
  constructor(code, message, detail) { super(message); this.name = 'ArtError'; this.code = code; this.detail = detail || null; }
}

const MAX_SIDE = 12000;                 // refuse absurd canvases before allocating them (a 12k square is 576 MB of RGBA)
const MAX_PIXELS = 80 * 1000 * 1000;

function makeArtOps(deps) {
  const lib = deps && deps.canvas;
  if (!lib || typeof lib.createCanvas !== 'function' || typeof lib.loadImage !== 'function') {
    throw new ArtError('ART_NO_CANVAS', 'art-ops needs a canvas library: { createCanvas, loadImage }');
  }

  // ---------- small pure helpers ----------
  const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
  const hex2 = n => (n < 16 ? '0' : '') + n.toString(16);
  const toHex = (r, g, b) => '#' + hex2(r) + hex2(g) + hex2(b);
  function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) throw new ArtError('ART_BAD_COLOR', 'expected a #rrggbb colour, got ' + JSON.stringify(hex));
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  // relative luminance (sRGB, WCAG) in 0..1
  function luminance(r, g, b) {
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  const contrastRatio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  const colorDist = (r1, g1, b1, r2, g2, b2) => Math.max(Math.abs(r1 - r2), Math.abs(g1 - g2), Math.abs(b1 - b2));

  function checkSize(w, h, what) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new ArtError('ART_BAD_SIZE', what + ' must be whole pixels >= 1, got ' + w + 'x' + h);
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS) throw new ArtError('ART_TOO_LARGE', what + ' ' + w + 'x' + h + ' is larger than this engine allows (' + MAX_SIDE + ' px a side, ' + (MAX_PIXELS / 1e6) + ' MP)');
  }

  async function decode(buf) {
    if (!buf || typeof buf.length !== 'number' || !buf.length) throw new ArtError('ART_EMPTY', 'no image bytes');
    let img;
    try { img = await lib.loadImage(buf); }
    catch (e) { throw new ArtError('ART_DECODE', 'not a readable PNG or JPEG image: ' + String((e && e.message) || e)); }
    checkSize(img.width, img.height, 'the image');
    return img;
  }
  function pixelsOf(img) {
    const cv = lib.createCanvas(img.width, img.height), g = cv.getContext('2d');
    g.drawImage(img, 0, 0);
    return { cv, g, data: g.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height };
  }
  const encode = cv => cv.toBuffer('image/png');

  /* What is behind the artwork? Measured on the outer border only (the one place a background must show):
       transparent  >= 95% of border pixels are (near) fully transparent
       flat         >= 97% of opaque border pixels sit within `tolerance` of the border's median colour
       none         anything else — a full-bleed picture; there is no background to trim or remove */
  function measureBackground(px, tolerance) {
    const { data, w, h } = px;
    const rs = [], gs = [], bs = [];
    let clear = 0, total = 0;
    const visit = (x, y) => {
      const i = (y * w + x) * 4; total++;
      if (data[i + 3] <= 8) { clear++; return; }
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    };
    for (let x = 0; x < w; x++) { visit(x, 0); if (h > 1) visit(x, h - 1); }
    for (let y = 1; y < h - 1; y++) { visit(0, y); if (w > 1) visit(w - 1, y); }
    if (total && clear / total >= 0.95) return { kind: 'transparent', color: null };
    if (!rs.length) return { kind: 'transparent', color: null };
    const med = a => { const s = Uint8Array.from(a).sort(); return s[s.length >> 1]; };
    const mr = med(rs), mg = med(gs), mb = med(bs);
    let near = 0;
    for (let k = 0; k < rs.length; k++) if (colorDist(rs[k], gs[k], bs[k], mr, mg, mb) <= tolerance) near++;
    // a flat background must also cover (nearly) the whole border: a few transparent corners are fine, half is not
    if (near / rs.length >= 0.97 && rs.length / total >= 0.9) return { kind: 'flat', color: [mr, mg, mb] };
    return { kind: 'none', color: null };
  }
  const isBg = (data, i, bg, tolerance) => bg.kind === 'transparent'
    ? data[i + 3] <= 8
    : bg.kind === 'flat' && (data[i + 3] <= 8 || colorDist(data[i], data[i + 1], data[i + 2], bg.color[0], bg.color[1], bg.color[2]) <= tolerance);

  function boundsOf(px, bg, tolerance) {
    const { data, w, h } = px;
    if (bg.kind === 'none') return { x: 0, y: 0, width: w, height: h, empty: false };
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      let row = y * w * 4;
      for (let x = 0; x < w; x++, row += 4) {
        if (isBg(data, row, bg, tolerance)) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return { x: 0, y: 0, width: w, height: h, empty: true };   // nothing but background
    return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1, empty: false };
  }

  // ---------- inspect ----------
  /* Facts about a design. `tolerance` (0-255, default 12) is how far a pixel may sit from the measured background
     colour and still count as background. */
  async function inspect(buf, opts) {
    const tolerance = clampInt((opts && opts.tolerance) != null ? opts.tolerance : 12, 0, 128);
    const img = await decode(buf);
    const px = pixelsOf(img);
    const { data, w, h } = px;
    const bg = measureBackground(px, tolerance);
    const bbox = boundsOf(px, bg, tolerance);

    // palette + alpha + luminance over a sample grid of at most ~250k pixels (exact enough, fast on print-size art)
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)));
    const buckets = new Map();
    let hasAlpha = false, art = 0, sampled = 0, lumSum = 0;
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        const i = (y * w + x) * 4; sampled++;
        if (data[i + 3] < 250) hasAlpha = true;
        if (isBg(data, i, bg, tolerance) || data[i + 3] <= 8) continue;
        art++;
        lumSum += luminance(data[i], data[i + 1], data[i + 2]);
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        const b = buckets.get(key);
        if (b) { b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; }
        else buckets.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
      }
    }
    const dominantColors = Array.from(buckets.values()).sort((a, b) => b.n - a.n).slice(0, 6).map(b => ({
      hex: toHex(Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)),
      share: art ? Math.round((b.n / art) * 1000) / 1000 : 0
    }));
    return {
      width: w, height: h, megapixels: Math.round((w * h) / 10000) / 100,
      aspect: Math.round((w / h) * 1000) / 1000,
      hasAlpha,
      background: { kind: bg.kind, color: bg.color ? toHex(bg.color[0], bg.color[1], bg.color[2]) : null,
        isDark: bg.color ? luminance(bg.color[0], bg.color[1], bg.color[2]) < 0.18 : null },
      bbox: { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height },
      empty: bbox.empty,                                   // true = the image is only background
      coverage: sampled ? Math.round((art / sampled) * 1000) / 1000 : 0,   // share of the canvas that is artwork
      meanLuminance: art ? Math.round((lumSum / art) * 1000) / 1000 : null,
      dominantColors,
      tolerance
    };
  }

  // ---------- trim ----------
  /* Crop away the measured background border. `padding` (px) keeps a margin. A full-bleed image (background
     'none') comes back unchanged with trimmed:false — there is nothing to trim, and saying so is the result. */
  async function trim(buf, opts) {
    const tolerance = clampInt((opts && opts.tolerance) != null ? opts.tolerance : 12, 0, 128);
    const padding = clampInt((opts && opts.padding) || 0, 0, 4000);
    const img = await decode(buf);
    const px = pixelsOf(img);
    const bg = measureBackground(px, tolerance);
    const b = boundsOf(px, bg, tolerance);
    if (b.empty) throw new ArtError('ART_EMPTY_ART', 'the image contains only background — there is no artwork to trim to');
    const x = Math.max(0, b.x - padding), y = Math.max(0, b.y - padding);
    const x1 = Math.min(px.w, b.x + b.width + padding), y1 = Math.min(px.h, b.y + b.height + padding);
    const w = x1 - x, h = y1 - y;
    if (bg.kind === 'none' || (w === px.w && h === px.h)) {
      return { buffer: encode(px.cv), width: px.w, height: px.h, trimmed: false, background: bg.kind, crop: { x: 0, y: 0, width: px.w, height: px.h } };
    }
    const out = lib.createCanvas(w, h), g = out.getContext('2d');
    g.drawImage(px.cv, x, y, w, h, 0, 0, w, h);
    return { buffer: encode(out), width: w, height: h, trimmed: true, background: bg.kind, crop: { x, y, width: w, height: h } };
  }

  // ---------- removeBackground ----------
  /* Key out a FLAT background, starting from the border and spreading only through connected background-coloured
     pixels — so the same colour INSIDE the artwork (the white of an eye on a white page) is kept. Returns
     removed:false with a reason when the background is not flat; never an invented cutout. */
  async function removeBackground(buf, opts) {
    const tolerance = clampInt((opts && opts.tolerance) != null ? opts.tolerance : 12, 0, 128);
    const img = await decode(buf);
    const px = pixelsOf(img);
    const { data, w, h } = px;
    const bg = measureBackground(px, tolerance);
    if (bg.kind === 'transparent') return { buffer: encode(px.cv), width: w, height: h, removed: false, reason: 'the background is already transparent' };
    if (bg.kind !== 'flat') return { buffer: encode(px.cv), width: w, height: h, removed: false, reason: 'no flat background was found at the border; this engine does not cut out photographic backgrounds' };

    const seen = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let top = 0, cleared = 0;
    const push = p => { if (!seen[p] && isBg(data, p * 4, bg, tolerance)) { seen[p] = 1; stack[top++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (top) {
      const p = stack[--top], x = p % w, y = (p - x) / w;
      data[p * 4 + 3] = 0; cleared++;
      if (x > 0) push(p - 1); if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w); if (y < h - 1) push(p + w);
    }
    const out = lib.createCanvas(w, h), g = out.getContext('2d');
    const id = g.createImageData(w, h); id.data.set(data); g.putImageData(id, 0, 0);
    return { buffer: encode(out), width: w, height: h, removed: true, color: toHex(bg.color[0], bg.color[1], bg.color[2]),
      clearedShare: Math.round((cleared / (w * h)) * 1000) / 1000 };
  }

  // ---------- fit ----------
  const ANCHORS = { center: [0.5, 0.5], top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5],
    'top-left': [0, 0], 'top-right': [1, 0], 'bottom-left': [0, 1], 'bottom-right': [1, 1] };
  function anchorOf(name) {
    const a = ANCHORS[name || 'center'];
    if (!a) throw new ArtError('ART_BAD_OPTION', 'unknown anchor ' + JSON.stringify(name) + ' (use one of ' + Object.keys(ANCHORS).join(', ') + ')');
    return a;
  }
  /* Where does a sw x sh image land inside a box? contain = whole image visible; cover = box filled, edges cropped.
     Aspect ratio is always preserved. Pure — exported for the tests and the mockup renderer. */
  function layout(sw, sh, box, mode, anchor, maxScale) {
    const m = mode || 'contain';
    if (m !== 'contain' && m !== 'cover') throw new ArtError('ART_BAD_OPTION', 'unknown fit mode ' + JSON.stringify(mode) + ' (use contain or cover)');
    const [ax, ay] = anchorOf(anchor);
    let scale = m === 'contain' ? Math.min(box.width / sw, box.height / sh) : Math.max(box.width / sw, box.height / sh);
    if (maxScale != null && scale > maxScale) scale = maxScale;
    const dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
    return { x: Math.round(box.x + (box.width - dw) * ax), y: Math.round(box.y + (box.height - dh) * ay), width: dw, height: dh, scale };
  }

  /* Resize onto a width x height canvas. Transparent unless `background` (#rrggbb) is given. */
  async function fit(buf, opts) {
    const o = opts || {};
    checkSize(o.width, o.height, 'the target size');
    const padding = clampInt(o.padding || 0, 0, Math.max(0, Math.floor(Math.min(o.width, o.height) / 2) - 1));
    const img = await decode(buf);
    const box = { x: padding, y: padding, width: o.width - 2 * padding, height: o.height - 2 * padding };
    const r = layout(img.width, img.height, box, o.mode, o.anchor, null);
    const out = lib.createCanvas(o.width, o.height), g = out.getContext('2d');
    if (o.background) { const [cr, cg, cb] = parseHex(o.background); g.fillStyle = toHex(cr, cg, cb); g.fillRect(0, 0, o.width, o.height); }
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.save(); g.beginPath(); g.rect(box.x, box.y, box.width, box.height); g.clip();
    g.drawImage(img, r.x, r.y, r.width, r.height);
    g.restore();
    return { buffer: encode(out), width: o.width, height: o.height, artRect: { x: r.x, y: r.y, width: r.width, height: r.height }, scale: Math.round(r.scale * 10000) / 10000 };
  }

  // ---------- print sizing ----------
  function checkPlacement(p) {
    if (!p || typeof p !== 'object') throw new ArtError('ART_BAD_PLACEMENT', 'a placement is required');
    checkSize(p.widthPx, p.heightPx, 'the placement');
    const inset = p.safeInsetPx || 0;
    if (!Number.isInteger(inset) || inset < 0 || inset * 2 >= Math.min(p.widthPx, p.heightPx)) throw new ArtError('ART_BAD_PLACEMENT', 'safeInsetPx ' + inset + ' does not leave a printable area');
    if (!(p.dpi > 0)) throw new ArtError('ART_BAD_PLACEMENT', 'the placement needs a dpi');
    const minDpi = p.minDpi != null ? p.minDpi : p.dpi;
    if (!(minDpi > 0) || minDpi > p.dpi) throw new ArtError('ART_BAD_PLACEMENT', 'minDpi must be between 0 and dpi');
    return { inset, minDpi };
  }
  /* Would this artwork print sharply enough? `fill` (0-1] is how much of the safe area the art should span.
     effectiveDpi is the resolution the SOURCE pixels end up at on the product. ok:false means placing it would
     enlarge the art past the placement's minimum DPI. Pure. */
  function printCheck(srcW, srcH, placement, opts) {
    const { inset, minDpi } = checkPlacement(placement);
    const o = opts || {};
    const fill = o.fill == null ? 1 : Number(o.fill);
    if (!(fill > 0 && fill <= 1)) throw new ArtError('ART_BAD_OPTION', 'fill must be in (0, 1]');
    const safe = { x: inset, y: inset, width: placement.widthPx - 2 * inset, height: placement.heightPx - 2 * inset };
    const fw = Math.max(1, Math.round(safe.width * fill)), fh = Math.max(1, Math.round(safe.height * fill));
    const [ax, ay] = anchorOf(o.anchor);
    const box = { x: Math.round(safe.x + (safe.width - fw) * ax), y: Math.round(safe.y + (safe.height - fh) * ay), width: fw, height: fh };
    const r = layout(srcW, srcH, box, o.mode, o.anchor, null);
    const effectiveDpi = Math.round((placement.dpi / r.scale) * 10) / 10;
    const maxScale = placement.dpi / minDpi;
    // the largest fill this source could take at minimum DPI (what to try instead when ok is false)
    // (scale grows linearly with fill, so it is maxScale over the scale a full-area placement would need)
    const fullScale = layout(srcW, srcH, safe, o.mode, o.anchor, null).scale;
    const maxFill = Math.min(1, Math.floor((maxScale / fullScale) * 1000) / 1000);
    return { ok: r.scale <= maxScale + 1e-9, scale: Math.round(r.scale * 10000) / 10000, effectiveDpi, requiredDpi: minDpi,
      nominalDpi: placement.dpi, artRect: { x: r.x, y: r.y, width: r.width, height: r.height }, safeRect: safe,
      maxFillAtMinDpi: maxFill };
  }

  /* The print file: a canvas of EXACTLY placement.widthPx x heightPx, transparent, with the artwork inside the safe
     area. Refuses (ART_TOO_SMALL) instead of enlarging past the minimum DPI. */
  async function place(buf, placement, opts) {
    const img = await decode(buf);
    const check = printCheck(img.width, img.height, placement, opts);
    if (!check.ok) {
      throw new ArtError('ART_TOO_SMALL', 'the artwork is ' + img.width + 'x' + img.height + ' px; at this size on this placement it would print at ' +
        check.effectiveDpi + ' dpi, below the minimum ' + check.requiredDpi + ' dpi' +
        (check.maxFillAtMinDpi != null && check.maxFillAtMinDpi > 0 ? ' (it could fill up to ' + Math.round(check.maxFillAtMinDpi * 100) + '% of the print area)' : ''), check);
    }
    const out = lib.createCanvas(placement.widthPx, placement.heightPx), g = out.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    const s = check.safeRect, r = check.artRect;
    g.save(); g.beginPath(); g.rect(s.x, s.y, s.width, s.height); g.clip();   // cover mode crops at the safe area, never past it
    g.drawImage(img, r.x, r.y, r.width, r.height);
    g.restore();
    return { buffer: encode(out), width: placement.widthPx, height: placement.heightPx, artRect: r, safeRect: s,
      scale: check.scale, effectiveDpi: check.effectiveDpi, requiredDpi: check.requiredDpi, upscaled: check.scale > 1 };
  }

  // ---------- fabric ----------
  /* How much of the artwork would be hard to see on a fabric colour? Share of (sampled) opaque art pixels whose
     WCAG contrast against the fabric is under `minContrast` (default 1.6 — "nearly the same shade"). A fact for the
     Designer and Reviewer, not a verdict. */
  async function fabricContrast(buf, fabricHex, opts) {
    const [fr, fg, fb] = parseHex(fabricHex);
    const minContrast = (opts && opts.minContrast) || 1.6;
    const img = await decode(buf);
    const { data, w, h } = pixelsOf(img);
    const fl = luminance(fr, fg, fb);
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 250000)));
    let art = 0, low = 0;
    for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) continue;
      art++;
      if (contrastRatio(luminance(data[i], data[i + 1], data[i + 2]), fl) < minContrast) low++;
    }
    return { fabric: toHex(fr, fg, fb), fabricIsDark: fl < 0.18, artPixelsSampled: art, lowContrastShare: art ? Math.round((low / art) * 1000) / 1000 : 0, minContrast };
  }

  /* Conservative, deterministic help for artwork that disappears into a fabric colour.
       none      unchanged
       outline   a solid outline around the artwork's silhouette, in white on dark fabric / near-black on light
                 (needs transparency — on a full-rectangle image the "silhouette" is the rectangle, and it says so)
       separate  only the pixels that nearly match the fabric are pushed away from it (lighter on dark fabric,
                 darker on light), keeping their hue; everything else is untouched
     Returns what it changed. The Reviewer judges whether the result is good; this never claims it is. */
  async function recolorForFabric(buf, opts) {
    const o = opts || {};
    const strategy = o.strategy || 'none';
    const [fr, fg, fb] = parseHex(o.fabric);
    const fl = luminance(fr, fg, fb), dark = fl < 0.18;
    const img = await decode(buf);
    const w = img.width, h = img.height;
    if (strategy === 'none') { const px = pixelsOf(img); return { buffer: encode(px.cv), width: w, height: h, strategy, changedShare: 0 }; }

    if (strategy === 'outline') {
      const width = clampInt(o.width != null ? o.width : Math.max(2, Math.round(Math.min(w, h) / 200)), 1, 200);
      const color = o.color ? parseHex(o.color) : (dark ? [255, 255, 255] : [17, 17, 17]);
      const sil = lib.createCanvas(w, h), sg = sil.getContext('2d');
      sg.drawImage(img, 0, 0);
      sg.globalCompositeOperation = 'source-in';
      sg.fillStyle = toHex(color[0], color[1], color[2]); sg.fillRect(0, 0, w, h);
      // the outline needs room: grow the canvas by the outline width on every side so it is never clipped
      const out = lib.createCanvas(w + 2 * width, h + 2 * width), g = out.getContext('2d');
      const steps = Math.max(16, Math.min(64, width * 8));
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        g.drawImage(sil, width + Math.round(Math.cos(a) * width), width + Math.round(Math.sin(a) * width));
      }
      g.drawImage(img, width, width);
      const px = pixelsOf(img);
      const bg = measureBackground(px, 12);
      return { buffer: encode(out), width: w + 2 * width, height: h + 2 * width, strategy, outlineWidth: width,
        outlineColor: toHex(color[0], color[1], color[2]),
        note: bg.kind === 'transparent' ? null : 'the image has no transparent background, so the outline follows its rectangular edge' };
    }

    if (strategy === 'separate') {
      const minContrast = o.minContrast || 1.6;
      const px = pixelsOf(img);
      const { data } = px;
      let art = 0, changed = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 8) continue;
        art++;
        let r = data[i], g2 = data[i + 1], b = data[i + 2];
        if (contrastRatio(luminance(r, g2, b), fl) >= minContrast) continue;
        // walk the pixel toward white (dark fabric) or black (light fabric) until it clears the contrast floor
        const tr = dark ? 255 : 0;
        let t = 0;
        for (let step = 0; step < 20; step++) {
          t += 0.05;
          const nr = Math.round(r + (tr - r) * t), ng = Math.round(g2 + (tr - g2) * t), nb = Math.round(b + (tr - b) * t);
          if (contrastRatio(luminance(nr, ng, nb), fl) >= minContrast || step === 19) { r = nr; g2 = ng; b = nb; break; }
        }
        data[i] = r; data[i + 1] = g2; data[i + 2] = b; changed++;
      }
      const out = lib.createCanvas(w, h), g = out.getContext('2d');
      const id = g.createImageData(w, h); id.data.set(data); g.putImageData(id, 0, 0);
      return { buffer: encode(out), width: w, height: h, strategy, changedShare: art ? Math.round((changed / art) * 1000) / 1000 : 0, minContrast };
    }
    throw new ArtError('ART_BAD_OPTION', 'unknown recolor strategy ' + JSON.stringify(strategy) + ' (use none, outline or separate)');
  }

  /* preview(buf, { maxEdge?, backgroundHex? }) — a SMALL copy to look at: the image scaled DOWN (never up) so its long
     edge is at most maxEdge, flattened onto a background colour, as a JPEG. Print files are far too large to hand to a
     vision model; this is what an agent (and the Gallery) looks at instead. It is a picture of the file, never the
     file: nothing prints from it. The background is the fabric colour for a fabric product (what the print will sit
     on), else a mid grey so both light and dark art on a transparent page stay visible. */
  async function preview(buf, opts) {
    const o = opts || {};
    const img = await decode(buf);
    const maxEdge = Math.max(64, Math.min(4096, Math.round(Number(o.maxEdge) || 1568)));
    const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
    const bg = /^#[0-9a-f]{6}$/i.test(String(o.backgroundHex || '')) ? String(o.backgroundHex).toLowerCase() : '#7f7f7f';
    const out = lib.createCanvas(w, h), g = out.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    return { buffer: out.toBuffer('image/jpeg', 86), width: w, height: h, background: bg, scale: Math.round(k * 10000) / 10000 };
  }

  return { inspect, trim, removeBackground, fit, place, printCheck, layout, fabricContrast, recolorForFabric, preview };
}

/* The app's instance: @napi-rs/canvas, loaded on first use so a sidecar boot never pays for (or dies on) the
   native module unless the art line actually runs. */
let _default = null;
function defaultArtOps() {
  if (!_default) _default = makeArtOps({ canvas: require('@napi-rs/canvas') });
  return _default;
}

module.exports = { makeArtOps, defaultArtOps, ArtError, MAX_SIDE, MAX_PIXELS };
