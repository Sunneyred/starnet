/* sidecar/art/mockup.js — product mockups from print files (Art Studio Phase 4).

   A mockup shows a print file ON the product: the print file (exactly the catalog placement's pixel size, artwork
   already positioned inside it) is mapped onto the template's PRINT QUAD — the four corners of the print area as it
   appears in the template picture. Deterministic compositing, the same library and the same seam as art-ops.

   TWO KINDS OF TEMPLATE, one normalized shape
   · DRAWN (built in): the product is drawn by this code — a flat shirt, a framed poster, a phone case. No photo, no
     third-party image, nothing to license. They are plain on purpose, and every result is labelled `kind: 'drawn'`
     so no surface presents one as a product photograph.
   · PACK (the owner's own): a folder with pack.json + a blank product photo (base), optional mask and shading
     images, and the print quad. The pack must state its `license` — the app cannot check image rights, so it
     requires the owner to say what they are and shows it. Loaded from <workspaces>/art-templates/<id>/.

   What a mockup is NOT: print-accurate colour, fabric texture, or proof of how the provider will print it. The
   print file is the source of truth for the product; the mockup is a picture for the listing.

   makeMockups({ canvas, fs?, path?, packsDir? }) -> { list(productId?), get(id), forProduct(productId), render(printBuf, templateId, opts), loadErrors }
   validatePack(json) -> [problems]        warpQuad(...) is exported for the tests. */
'use strict';

const { ArtError } = require('./art-ops.js');

const SIZE = 2000;                      // drawn templates are 2000 x 2000
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// ---------- geometry ----------
const lerp = (a, b, t) => a + (b - a) * t;
/* bilinear point inside a quad [TL, TR, BR, BL] at (u, v) in 0..1 */
function quadPoint(q, u, v) {
  const tx = lerp(q[0][0], q[1][0], u), ty = lerp(q[0][1], q[1][1], u);
  const bx = lerp(q[3][0], q[2][0], u), by = lerp(q[3][1], q[2][1], u);
  return [lerp(tx, bx, v), lerp(ty, by, v)];
}
const isRect = q => q[0][1] === q[1][1] && q[3][1] === q[2][1] && q[0][0] === q[3][0] && q[1][0] === q[2][0] && q[1][0] > q[0][0] && q[3][1] > q[0][1];

/* Draw `img` (sw x sh) so its corners land on the quad. An axis-aligned quad is one drawImage. Any other quad is
   drawn as a grid of triangles, each with its own affine transform — a close approximation of perspective that needs
   only the 2D canvas primitives the probe proved (clip + setTransform). */
function warpQuad(g, img, sw, sh, q, grid) {
  if (isRect(q)) { g.drawImage(img, q[0][0], q[0][1], q[1][0] - q[0][0], q[3][1] - q[0][1]); return 'rect'; }
  const n = Math.max(2, Math.min(40, grid || 16));
  const tri = (s, d) => {
    // affine that maps source triangle s -> destination triangle d
    const [x0, y0] = s[0], [x1, y1] = s[1], [x2, y2] = s[2];
    const [u0, v0] = d[0], [u1, v1] = d[1], [u2, v2] = d[2];
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!det) return;
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det, c = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det;
    const b = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / det, dd = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / det;
    const e = u0 - a * x0 - c * y0, f = v0 - b * x0 - dd * y0;
    // grow the clip a hair around its centroid so neighbouring triangles overlap instead of leaving hairline seams
    const cx = (u0 + u1 + u2) / 3, cy = (v0 + v1 + v2) / 3;
    const grow = p => { const dx = p[0] - cx, dy = p[1] - cy, len = Math.hypot(dx, dy) || 1; return [p[0] + (dx / len) * 1.5, p[1] + (dy / len) * 1.5]; };
    const [p0, p1, p2] = [grow(d[0]), grow(d[1]), grow(d[2])];
    g.save();
    g.beginPath(); g.moveTo(p0[0], p0[1]); g.lineTo(p1[0], p1[1]); g.lineTo(p2[0], p2[1]); g.closePath(); g.clip();
    g.setTransform(a, b, c, dd, e, f);
    g.drawImage(img, 0, 0);
    g.restore();
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u0 = i / n, u1 = (i + 1) / n, v0 = j / n, v1 = (j + 1) / n;
    const s = [[u0 * sw, v0 * sh], [u1 * sw, v0 * sh], [u1 * sw, v1 * sh], [u0 * sw, v1 * sh]];
    const d = [quadPoint(q, u0, v0), quadPoint(q, u1, v0), quadPoint(q, u1, v1), quadPoint(q, u0, v1)];
    tri([s[0], s[1], s[2]], [d[0], d[1], d[2]]);
    tri([s[0], s[2], s[3]], [d[0], d[2], d[3]]);
  }
  return 'grid';
}

// ---------- drawn templates ----------
function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) throw new ArtError('ART_BAD_COLOR', 'expected a #rrggbb colour, got ' + JSON.stringify(hex));
  const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const lum = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const shade = (hex, k) => { const [r, g, b] = parseHex(hex); const f = c => Math.max(0, Math.min(255, Math.round(c + (k > 0 ? (255 - c) * k : c * k)))); return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')'; };
function backdrop(g, top, bottom) {
  const gr = g.createLinearGradient(0, 0, 0, SIZE); gr.addColorStop(0, top); gr.addColorStop(1, bottom);
  g.fillStyle = gr; g.fillRect(0, 0, SIZE, SIZE);
}
// a studio backdrop that contrasts with the product colour, so a white shirt is not lost on a white wall
const studio = (g, fabricHex) => (lum(parseHex(fabricHex || '#888888')) > 0.6 ? backdrop(g, '#5b6068', '#3f434a') : backdrop(g, '#e9e7e2', '#cfccc5'));
function softShadow(g, draw, blur, dy, alpha) {
  g.save(); g.shadowColor = 'rgba(0,0,0,' + (alpha || 0.35) + ')'; g.shadowBlur = blur; g.shadowOffsetY = dy; draw(); g.restore();
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
function teePath(g) {
  g.beginPath();
  g.moveTo(760, 300); g.quadraticCurveTo(1000, 430, 1240, 300);                    // collar
  g.lineTo(1520, 380); g.lineTo(1800, 700); g.lineTo(1600, 880); g.lineTo(1470, 760);   // right sleeve
  g.lineTo(1470, 1780); g.quadraticCurveTo(1000, 1830, 530, 1780);                  // hem
  g.lineTo(530, 760); g.lineTo(400, 880); g.lineTo(200, 700); g.lineTo(480, 380);    // left sleeve
  g.closePath();
}
function hoodiePath(g) {
  g.beginPath();
  g.moveTo(720, 380); g.quadraticCurveTo(1000, 120, 1280, 380);                     // hood
  g.lineTo(1540, 470); g.lineTo(1840, 1380); g.lineTo(1640, 1460); g.lineTo(1480, 900);
  g.lineTo(1480, 1800); g.quadraticCurveTo(1000, 1850, 520, 1800);
  g.lineTo(520, 900); g.lineTo(360, 1460); g.lineTo(160, 1380); g.lineTo(460, 470);
  g.closePath();
}
function garment(pathFn, extras) {
  return (g, o) => {
    const fabric = o.fabricHex || '#f4f4f4';
    studio(g, fabric);
    softShadow(g, () => { g.fillStyle = fabric; pathFn(g); g.fill(); }, 60, 30, 0.3);
    // a little form: lighter down the middle, darker at the sides, clipped to the garment
    g.save(); pathFn(g); g.clip();
    const gr = g.createLinearGradient(200, 0, 1800, 0);
    gr.addColorStop(0, 'rgba(0,0,0,0.22)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.05)'); gr.addColorStop(1, 'rgba(0,0,0,0.22)');
    g.fillStyle = gr; g.fillRect(0, 0, SIZE, SIZE);
    if (extras) extras(g, fabric);
    g.restore();
    g.lineWidth = 4; g.strokeStyle = shade(fabric, lum(parseHex(fabric)) > 0.5 ? -0.25 : 0.25); pathFn(g); g.stroke();
  };
}
const DRAWN = [
  { id: 'tee-flat', label: 'T-shirt, flat (drawn)', productIds: ['tee-front'], tintable: true, printQuad: [[670, 600], [1330, 600], [1330, 1480], [670, 1480]],
    draw: garment(teePath, (g, fabric) => { g.strokeStyle = shade(fabric, -0.3); g.lineWidth = 16; g.beginPath(); g.moveTo(760, 300); g.quadraticCurveTo(1000, 430, 1240, 300); g.stroke(); }) },
  { id: 'hoodie-flat', label: 'Hoodie, flat (drawn)', productIds: ['hoodie-front'], tintable: true, printQuad: [[730, 640], [1270, 640], [1270, 1360], [730, 1360]],
    draw: garment(hoodiePath, (g, fabric) => {
      g.strokeStyle = shade(fabric, -0.3); g.lineWidth = 10;
      g.beginPath(); g.moveTo(720, 380); g.quadraticCurveTo(1000, 620, 1280, 380); g.stroke();                       // hood opening
      g.beginPath(); g.moveTo(700, 1440); g.lineTo(1300, 1440); g.lineTo(1380, 1700); g.lineTo(620, 1700); g.closePath(); g.stroke();   // pocket
    }) },
  { id: 'cap-front', label: 'Cap, front (drawn)', productIds: ['dad-hat-front'], tintable: true, printQuad: [[720, 820], [1280, 820], [1280, 1065], [720, 1065]],
    draw: (g, o) => {
      const fabric = o.fabricHex || '#f4f4f4'; studio(g, fabric);
      const crown = () => { g.beginPath(); g.moveTo(480, 1180); g.quadraticCurveTo(500, 560, 1000, 540); g.quadraticCurveTo(1500, 560, 1520, 1180); g.closePath(); };
      softShadow(g, () => { g.fillStyle = fabric; crown(); g.fill(); }, 50, 26, 0.3);
      g.fillStyle = shade(fabric, -0.18); g.beginPath(); g.moveTo(430, 1180); g.quadraticCurveTo(1000, 1100, 1570, 1180); g.quadraticCurveTo(1000, 1500, 430, 1180); g.fill();   // brim
      g.lineWidth = 4; g.strokeStyle = shade(fabric, lum(parseHex(fabric)) > 0.5 ? -0.25 : 0.25); crown(); g.stroke();
    } },
  { id: 'poster-wall', label: 'Poster on a wall (drawn)', productIds: ['poster-18x24', 'poster-12x16'], tintable: false, printQuad: [[520, 200], [1480, 200], [1480, 1480], [520, 1480]],
    draw: g => {
      backdrop(g, '#d9d5cd', '#c2beb5');
      g.fillStyle = '#8d7b66'; g.fillRect(0, 1700, SIZE, 300);                                   // floor
      softShadow(g, () => { g.fillStyle = '#ffffff'; g.fillRect(520, 200, 960, 1280); }, 50, 24, 0.4);
    },
    overlay: g => { g.lineWidth = 22; g.strokeStyle = '#1c1c1c'; g.strokeRect(509, 189, 982, 1302); } },   // a thin frame over the sheet's edge
  { id: 'sticker-flat', label: 'Sticker on a surface (drawn)', productIds: ['sticker-4x4'], tintable: false, printQuad: [[560, 560], [1440, 560], [1440, 1440], [560, 1440]],
    draw: g => { backdrop(g, '#3b3f46', '#2a2d33'); softShadow(g, () => { g.fillStyle = '#ffffff'; roundRect(g, 520, 520, 960, 960, 70); g.fill(); }, 40, 18, 0.45); } },
  { id: 'phone-case-back', label: 'Phone case, back (drawn)', productIds: ['phone-case'], tintable: false, printQuad: [[650, 200], [1350, 200], [1350, 1600], [650, 1600]],
    draw: g => { backdrop(g, '#e9e7e2', '#cfccc5'); softShadow(g, () => { g.fillStyle = '#111111'; roundRect(g, 650, 200, 700, 1400, 110); g.fill(); }, 50, 26, 0.4); },
    mask: g => { roundRect(g, 650, 200, 700, 1400, 110); g.fill(); },
    overlay: g => {
      g.fillStyle = '#0c0c0c'; roundRect(g, 700, 250, 300, 300, 70); g.fill();                     // camera island
      g.fillStyle = '#2b2b2b'; for (const [x, y] of [[780, 330], [920, 330], [780, 470]]) { g.beginPath(); g.arc(x, y, 52, 0, Math.PI * 2); g.fill(); }
      g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.5)'; roundRect(g, 650, 200, 700, 1400, 110); g.stroke();
    } },
  { id: 'cover-square', label: 'Square cover (drawn)', productIds: ['cover-art'], tintable: false, printQuad: [[400, 400], [1600, 400], [1600, 1600], [400, 1600]],
    draw: g => { backdrop(g, '#26282d', '#131417'); softShadow(g, () => { g.fillStyle = '#000000'; g.fillRect(400, 400, 1200, 1200); }, 80, 40, 0.6); } },
  { id: 'phone-screen', label: 'Phone screen (drawn)', productIds: ['phone-wallpaper'], tintable: false, printQuad: [[640, 220], [1360, 220], [1360, 1500], [640, 1500]],
    draw: g => { backdrop(g, '#e9e7e2', '#cfccc5'); softShadow(g, () => { g.fillStyle = '#0a0a0a'; roundRect(g, 600, 180, 800, 1360, 110); g.fill(); }, 60, 30, 0.4); },
    mask: g => { roundRect(g, 640, 220, 720, 1280, 80); g.fill(); } }
];

// ---------- owner packs ----------
function validatePack(p) {
  const problems = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['pack.json must be an object'];
  if (!ID_RE.test(String(p.id))) problems.push('id must be lower-case letters, digits and dashes');
  if (!p.label) problems.push('needs a label');
  if (!Array.isArray(p.productIds) || !p.productIds.length || !p.productIds.every(x => ID_RE.test(String(x)))) problems.push('productIds must list the catalog product ids this template shows');
  if (!String(p.license || '').trim()) problems.push('needs a "license": say what rights you have to the product photo (e.g. "my own photo")');
  if (!/^[^/\\]+\.(png|jpe?g)$/i.test(String(p.base || ''))) problems.push('base must be an image file name inside the pack folder');
  for (const k of ['mask', 'shading']) if (p[k] != null && !/^[^/\\]+\.(png|jpe?g)$/i.test(String(p[k]))) problems.push(k + ' must be an image file name inside the pack folder');
  const q = p.printQuad;
  if (!Array.isArray(q) || q.length !== 4 || !q.every(pt => Array.isArray(pt) && pt.length === 2 && pt.every(n => Number.isFinite(n) && n >= 0))) problems.push('printQuad must be four [x, y] corners: top-left, top-right, bottom-right, bottom-left');
  else {
    // corners must go round clockwise and enclose a real area (a bow-tie or a line would smear the print)
    let area = 0; for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
    if (!(area > 400)) problems.push('printQuad corners must go clockwise from the top-left and enclose an area');
  }
  return problems;
}

function makeMockups(deps) {
  const d = deps || {};
  const lib = d.canvas;
  if (!lib || typeof lib.createCanvas !== 'function') throw new ArtError('ART_NO_CANVAS', 'mockup.js needs a canvas library');
  const loadErrors = [];

  function ownerPacks() {
    loadErrors.length = 0;
    if (!d.fs || !d.path || !d.packsDir || !d.fs.existsSync(d.packsDir)) return [];
    const out = [];
    let names = [];
    try { names = d.fs.readdirSync(d.packsDir); } catch (e) { loadErrors.push('could not read the templates folder: ' + String((e && e.message) || e)); return []; }
    for (const name of names.slice().sort()) {
      const dir = d.path.join(d.packsDir, name), file = d.path.join(dir, 'pack.json');
      if (!d.fs.existsSync(file)) continue;
      let json;
      try { json = JSON.parse(String(d.fs.readFileSync(file, 'utf8')).replace(/^﻿/, '')); }
      catch (e) { loadErrors.push(name + ': pack.json could not be read (' + String((e && e.message) || e) + ')'); continue; }
      const problems = validatePack(json);
      if (json && json.id !== name) problems.push('id must match its folder name (' + name + ')');
      if (DRAWN.some(t => t.id === (json && json.id))) problems.push('id clashes with a built-in template');
      for (const k of ['base', 'mask', 'shading']) if (json && json[k] && !d.fs.existsSync(d.path.join(dir, json[k]))) problems.push(k + ' file ' + json[k] + ' is missing');
      if (problems.length) { loadErrors.push(name + ': ' + problems.join('; ')); continue; }
      out.push({ id: json.id, label: String(json.label), productIds: json.productIds.slice(), kind: 'pack', license: String(json.license), source: String(json.source || ''),
        printQuad: json.printQuad.map(pt => [pt[0], pt[1]]), dir, base: json.base, mask: json.mask || null, shading: json.shading || null, tintable: false });
    }
    return out;
  }
  const all = () => DRAWN.map(t => ({ id: t.id, label: t.label, productIds: t.productIds.slice(), kind: 'drawn', license: 'drawn by this app (no third-party image)', source: '',
    printQuad: t.printQuad, tintable: t.tintable, _t: t })).concat(ownerPacks());
  const view = t => ({ id: t.id, label: t.label, productIds: t.productIds, kind: t.kind, license: t.license, source: t.source, tintable: t.tintable });

  /* render(printBuf, templateId, { fabricHex? }) -> { buffer, width, height, templateId, kind, license, warp }
     printBuf is a print file (any size; its whole canvas is the print area). */
  async function render(printBuf, templateId, opts) {
    const o = opts || {};
    const t = all().find(x => x.id === templateId);
    if (!t) throw new ArtError('ART_NO_TEMPLATE', 'no mockup template ' + JSON.stringify(templateId) + '. Templates: ' + all().map(x => x.id).join(', '));
    if (o.fabricHex) parseHex(o.fabricHex);
    let print;
    try { print = await lib.loadImage(printBuf); } catch (e) { throw new ArtError('ART_DECODE', 'the print file is not a readable image: ' + String((e && e.message) || e)); }

    let W = SIZE, H = SIZE, cv, g, baseImg = null;
    if (t.kind === 'pack') {
      try { baseImg = await lib.loadImage(d.fs.readFileSync(d.path.join(t.dir, t.base))); } catch (e) { throw new ArtError('ART_BAD_TEMPLATE', 'template ' + t.id + ': its base image could not be opened (' + String((e && e.message) || e) + ')'); }
      W = baseImg.width; H = baseImg.height;
      if (t.printQuad.some(pt => pt[0] > W || pt[1] > H)) throw new ArtError('ART_BAD_TEMPLATE', 'template ' + t.id + ': its print quad lies outside its ' + W + 'x' + H + ' base image');
    }
    cv = lib.createCanvas(W, H); g = cv.getContext('2d');
    if (t.kind === 'pack') g.drawImage(baseImg, 0, 0); else t._t.draw(g, { fabricHex: o.fabricHex });

    // the print goes on its own layer so a mask can cut it without cutting the product
    const layer = lib.createCanvas(W, H), lg = layer.getContext('2d');
    lg.imageSmoothingEnabled = true; lg.imageSmoothingQuality = 'high';
    const warp = warpQuad(lg, print, print.width, print.height, t.printQuad, o.grid);
    if (t.kind === 'pack' && t.mask) {
      const m = await lib.loadImage(d.fs.readFileSync(d.path.join(t.dir, t.mask)));
      lg.globalCompositeOperation = 'destination-in'; lg.drawImage(m, 0, 0, W, H); lg.globalCompositeOperation = 'source-over';
    } else if (t.kind === 'drawn' && t._t.mask) {
      lg.globalCompositeOperation = 'destination-in'; lg.fillStyle = '#000000'; t._t.mask(lg); lg.globalCompositeOperation = 'source-over';
    }
    g.drawImage(layer, 0, 0);
    if (t.kind === 'pack' && t.shading) {
      const s = await lib.loadImage(d.fs.readFileSync(d.path.join(t.dir, t.shading)));
      g.globalCompositeOperation = 'multiply'; g.drawImage(s, 0, 0, W, H); g.globalCompositeOperation = 'source-over';
    }
    if (t.kind === 'drawn' && t._t.overlay) t._t.overlay(g);
    return { buffer: cv.toBuffer('image/png'), width: W, height: H, templateId: t.id, kind: t.kind, license: t.license, warp };
  }

  return {
    list(productId) { return all().filter(t => !productId || t.productIds.includes(productId)).map(view); },
    get(id) { const t = all().find(x => x.id === id); return t ? view(t) : null; },
    /* the default template for a product: the owner's own pack wins over the drawn one */
    forProduct(productId) { const ts = all().filter(t => t.productIds.includes(productId)); const t = ts.find(x => x.kind === 'pack') || ts[0]; return t ? view(t) : null; },
    render,
    get loadErrors() { ownerPacks(); return loadErrors.slice(); }
  };
}

let _default = null;
function defaultMockups(extra) {
  if (!_default || extra) { const m = makeMockups(Object.assign({ canvas: require('@napi-rs/canvas') }, extra || {})); if (extra) return m; _default = m; }
  return _default;
}

module.exports = { makeMockups, defaultMockups, validatePack, warpQuad, quadPoint, DRAWN_IDS: DRAWN.map(t => t.id), SIZE };
