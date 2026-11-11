/* node test/art-ops.test.js — the art engine's image operations do exactly what they report (Art Studio Phase 1b).

   Fixtures are drawn here, pixel for pixel, so every expectation is a known number rather than a golden file:
   a transparent-background mark, the same mark on a flat white page, a full-bleed picture, and a too-small image.
   The laws under test: exact output sizes, the artwork stays inside the safe area, aspect ratio is preserved,
   nothing is silently enlarged, and no cutout is invented. */
'use strict';
const A = require('./_assert.js');
const C = require('@napi-rs/canvas');
const { makeArtOps, defaultArtOps, ArtError } = require('../sidecar/art/art-ops.js');
const ops = makeArtOps({ canvas: C });

function draw(w, h, fn) { const cv = C.createCanvas(w, h), g = cv.getContext('2d'); fn(g); return cv.toBuffer('image/png'); }
async function pixels(buf) {
  const img = await C.loadImage(buf); const cv = C.createCanvas(img.width, img.height), g = cv.getContext('2d');
  g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, img.width, img.height).data;
  return { w: img.width, h: img.height, at: (x, y) => Array.from(d.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)) };
}
async function alphaBounds(buf) {
  const p = await pixels(buf); let x0 = p.w, y0 = p.h, x1 = -1, y1 = -1;
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (p.at(x, y)[3] > 8) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}
async function refuses(fn, code, msg) {
  try { await fn(); A.ok(false, msg + ' — expected ' + code + ', but it did not refuse'); }
  catch (e) { A.ok(e instanceof ArtError && e.code === code, msg + ' — got ' + (e && (e.code || e.message))); return e; }
}

// a 400x300 transparent canvas with a magenta 200x100 block at (60,80) holding a blue 40x40 square at (100,110)
const MARK = draw(400, 300, g => { g.fillStyle = '#ff00aa'; g.fillRect(60, 80, 200, 100); g.fillStyle = '#2040ff'; g.fillRect(100, 110, 40, 40); });
// the same block on a flat white page, with a WHITE square inside it (must survive background removal)
const ON_WHITE = draw(400, 300, g => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 400, 300); g.fillStyle = '#ff00aa'; g.fillRect(60, 80, 200, 100); g.fillStyle = '#ffffff'; g.fillRect(100, 110, 40, 40); });
// a full-bleed picture: a different colour in every quadrant, nothing that reads as a background
const BLEED = draw(200, 200, g => { ['#102030', '#c04020', '#20a060', '#e0d040'].forEach((c, i) => { g.fillStyle = c; g.fillRect((i % 2) * 100, (i >> 1) * 100, 100, 100); }); });
const BLACK_MARK = draw(120, 80, g => { g.fillStyle = '#050505'; g.fillRect(20, 20, 80, 40); g.fillStyle = '#ffee00'; g.fillRect(40, 30, 20, 20); });
const EMPTY = draw(50, 50, () => {});

(async () => {
  // ---------- construction ----------
  A.throws(() => makeArtOps({}), 'art-ops refuses to exist without a canvas library');
  A.ok(typeof defaultArtOps().inspect === 'function', 'the app instance loads the real library on first use');

  // ---------- inspect ----------
  const im = await ops.inspect(MARK);
  A.eq([im.width, im.height], [400, 300], 'inspect: size');
  A.eq(im.background.kind, 'transparent', 'inspect: a transparent border is a transparent background');
  A.eq(im.hasAlpha, true, 'inspect: alpha is reported');
  A.eq(im.bbox, { x: 60, y: 80, width: 200, height: 100 }, 'inspect: the artwork\'s bounding box is exact');
  A.eq(im.dominantColors[0].hex, '#ff00aa', 'inspect: the dominant colour is the magenta block');
  A.ok(im.dominantColors.some(c => c.hex === '#2040ff'), 'inspect: the blue square is in the palette');
  A.ok(Math.abs(im.coverage - (200 * 100) / (400 * 300)) < 0.01, 'inspect: coverage is the artwork\'s share of the canvas (' + im.coverage + ')');
  A.eq(im.empty, false, 'inspect: there is artwork');

  const iw = await ops.inspect(ON_WHITE);
  A.eq(iw.background.kind, 'flat', 'inspect: a uniform border is a flat background');
  A.eq([iw.background.color, iw.background.isDark], ['#ffffff', false], 'inspect: the flat colour and its darkness are measured');
  A.eq(iw.bbox, { x: 60, y: 80, width: 200, height: 100 }, 'inspect: the bounding box ignores the flat background');
  A.eq(iw.hasAlpha, false, 'inspect: an opaque image has no alpha');

  const ib = await ops.inspect(BLEED);
  A.eq(ib.background.kind, 'none', 'inspect: a full-bleed picture has no background');
  A.eq(ib.bbox, { x: 0, y: 0, width: 200, height: 200 }, 'inspect: its bounding box is the whole image');
  A.eq((await ops.inspect(EMPTY)).empty, true, 'inspect: an image with nothing on it says so');
  await refuses(() => ops.inspect(Buffer.from('not an image')), 'ART_DECODE', 'inspect: garbage bytes are refused, not guessed at');
  await refuses(() => ops.inspect(Buffer.alloc(0)), 'ART_EMPTY', 'inspect: no bytes is refused');

  // ---------- trim ----------
  const t = await ops.trim(MARK);
  A.eq([t.width, t.height, t.trimmed], [200, 100, true], 'trim: crops to the artwork exactly');
  A.eq(t.crop, { x: 60, y: 80, width: 200, height: 100 }, 'trim: reports the crop it made');
  const tp = await pixels(t.buffer);
  A.eq(tp.at(0, 0), [255, 0, 170, 255], 'trim: the top-left pixel is now artwork');
  A.eq(tp.at(60, 50), [32, 64, 255, 255], 'trim: interior detail is untouched');
  const t2 = await ops.trim(MARK, { padding: 10 });
  A.eq([t2.width, t2.height], [220, 120], 'trim: padding keeps a margin');
  const tw = await ops.trim(ON_WHITE);
  A.eq([tw.width, tw.height, tw.background], [200, 100, 'flat'], 'trim: a flat background is trimmed too');
  const tb = await ops.trim(BLEED);
  A.eq([tb.width, tb.height, tb.trimmed], [200, 200, false], 'trim: a full-bleed picture is returned whole and says trimmed:false');
  await refuses(() => ops.trim(EMPTY), 'ART_EMPTY_ART', 'trim: an image with no artwork is refused');

  // ---------- removeBackground ----------
  const rb = await ops.removeBackground(ON_WHITE);
  A.eq(rb.removed, true, 'removeBackground: a flat background is removed');
  A.eq(rb.color, '#ffffff', 'removeBackground: it reports the colour it keyed');
  const rp = await pixels(rb.buffer);
  A.eq(rp.at(5, 5)[3], 0, 'removeBackground: the page is now transparent');
  A.eq(rp.at(70, 90), [255, 0, 170, 255], 'removeBackground: the artwork is intact');
  A.eq(rp.at(120, 130), [255, 255, 255, 255], 'removeBackground: the same colour INSIDE the artwork is kept (flood from the border only)');
  A.ok(Math.abs(rb.clearedShare - (400 * 300 - 200 * 100) / (400 * 300)) < 0.005, 'removeBackground: it reports how much it cleared (' + rb.clearedShare + ')');
  const rn = await ops.removeBackground(BLEED);
  A.eq(rn.removed, false, 'removeBackground: a photographic / full-bleed image is NOT cut out');
  A.ok(/no flat background/.test(rn.reason), 'removeBackground: and it says why');
  A.eq((await pixels(rn.buffer)).at(10, 10), [16, 32, 48, 255], 'removeBackground: the refused image comes back unchanged');
  const rt = await ops.removeBackground(MARK);
  A.eq([rt.removed, /already transparent/.test(rt.reason)], [false, true], 'removeBackground: an already-transparent image is left alone');

  // ---------- layout (pure) ----------
  A.eq(ops.layout(200, 100, { x: 0, y: 0, width: 100, height: 100 }, 'contain', 'center'), { x: 0, y: 25, width: 100, height: 50, scale: 0.5 }, 'layout: contain letterboxes');
  A.eq(ops.layout(200, 100, { x: 0, y: 0, width: 100, height: 100 }, 'cover', 'center'), { x: -50, y: 0, width: 200, height: 100, scale: 1 }, 'layout: cover fills and overflows');
  A.eq(ops.layout(200, 100, { x: 10, y: 10, width: 100, height: 100 }, 'contain', 'top').y, 10, 'layout: top anchor sits at the box top');
  A.eq(ops.layout(200, 100, { x: 10, y: 10, width: 100, height: 100 }, 'contain', 'bottom').y, 60, 'layout: bottom anchor sits at the box bottom');
  A.throws(() => ops.layout(1, 1, { x: 0, y: 0, width: 1, height: 1 }, 'stretch'), 'layout: there is no stretch mode');
  A.throws(() => ops.layout(1, 1, { x: 0, y: 0, width: 1, height: 1 }, 'contain', 'middle-ish'), 'layout: an unknown anchor is refused');

  // ---------- fit ----------
  const f = await ops.fit(t.buffer, { width: 300, height: 300 });
  A.eq([f.width, f.height], [300, 300], 'fit: the canvas is exactly the size asked for');
  A.eq(f.artRect, { x: 0, y: 75, width: 300, height: 150 }, 'fit: the art keeps its 2:1 shape, centred');
  const fp = await pixels(f.buffer);
  A.eq([fp.at(150, 10)[3], fp.at(150, 150)[3]], [0, 255], 'fit: letterbox bands are transparent');
  const fbg = await ops.fit(t.buffer, { width: 300, height: 300, background: '#000000', padding: 20 });
  A.eq((await pixels(fbg.buffer)).at(2, 2), [0, 0, 0, 255], 'fit: a background colour fills the canvas');
  A.eq(fbg.artRect.width, 260, 'fit: padding shrinks the art box');
  await refuses(() => ops.fit(t.buffer, { width: 0, height: 10 }), 'ART_BAD_SIZE', 'fit: a zero size is refused');
  await refuses(() => ops.fit(t.buffer, { width: 20000, height: 20000 }), 'ART_TOO_LARGE', 'fit: an absurd canvas is refused before it is allocated');

  // ---------- printCheck + place ----------
  const TEE = { widthPx: 1800, heightPx: 2400, dpi: 150, minDpi: 150, safeInsetPx: 0 };
  const bigArt = draw(1800, 1200, g => { g.fillStyle = '#ff00aa'; g.fillRect(0, 0, 1800, 1200); g.fillStyle = '#2040ff'; g.fillRect(0, 0, 10, 10); });
  const pc = ops.printCheck(1800, 1200, TEE, { anchor: 'top' });
  A.eq([pc.ok, pc.scale, pc.effectiveDpi], [true, 1, 150], 'printCheck: art that matches the print width prints at the nominal dpi');
  A.eq(pc.artRect, { x: 0, y: 0, width: 1800, height: 1200 }, 'printCheck: top anchor places it at the top of the print area');
  const pl = await ops.place(bigArt, TEE, { anchor: 'top' });
  A.eq([pl.width, pl.height], [1800, 2400], 'place: the print file is EXACTLY the placement size');
  A.eq(pl.upscaled, false, 'place: nothing was enlarged');
  const pb = await alphaBounds(pl.buffer);
  A.eq(pb, { x: 0, y: 0, width: 1800, height: 1200 }, 'place: the artwork landed where it said');
  A.eq((await pixels(pl.buffer)).at(900, 2000)[3], 0, 'place: the rest of the print area is transparent');

  // safe area: a 1000x1000 placement with a 100px inset leaves 800x800; a 1600x800 design fits at scale 0.5
  const SAFE = { widthPx: 1000, heightPx: 1000, dpi: 300, minDpi: 150, safeInsetPx: 100 };
  const wide = draw(1600, 800, g => { g.fillStyle = '#20a060'; g.fillRect(0, 0, 1600, 800); });
  const ps = await ops.place(wide, SAFE, {});
  const sb = await alphaBounds(ps.buffer);
  A.eq(sb, { x: 100, y: 300, width: 800, height: 400 }, 'place: the artwork fills the safe area\'s width and never crosses the inset');
  A.eq([ps.scale, ps.effectiveDpi, ps.upscaled], [0.5, 600, false], 'place: a larger source prints above nominal dpi and is reported');
  const half = await ops.place(wide, SAFE, { fill: 0.5 });
  A.eq(await alphaBounds(half.buffer), { x: 300, y: 400, width: 400, height: 200 }, 'place: fill 0.5 spans half the safe area, centred');
  const cov = await ops.place(wide, SAFE, { mode: 'cover' });
  A.eq(await alphaBounds(cov.buffer), { x: 100, y: 100, width: 800, height: 800 }, 'place: cover fills the safe area and is cropped AT the inset, never past it');

  // the too-small law: a 200x100 mark on that placement would print at 75 dpi (scale 4) — refused, with the numbers
  const small = ops.printCheck(200, 100, SAFE, {});
  A.eq([small.ok, small.scale, small.effectiveDpi, small.requiredDpi], [false, 4, 75, 150], 'printCheck: a too-small source is not ok, with the dpi it would print at');
  A.eq(small.maxFillAtMinDpi, 0.5, 'printCheck: and says how much of the area it COULD fill at minimum dpi');
  const e = await refuses(() => ops.place(t.buffer, SAFE, {}), 'ART_TOO_SMALL', 'place: refuses to enlarge past the minimum dpi');
  A.ok(e && /75 dpi/.test(e.message) && /50%/.test(e.message), 'place: the refusal carries the numbers a person needs (' + (e && e.message) + ')');
  A.ok(e && e.detail && e.detail.ok === false, 'place: and the full check as detail');
  const okSmall = await ops.place(t.buffer, SAFE, { fill: 0.5 });
  A.eq([okSmall.scale, okSmall.effectiveDpi, okSmall.upscaled], [2, 150, true], 'place: at the fill it suggested, the same art is accepted at exactly minimum dpi, and says it was enlarged');
  // a placement with no minDpi means "never enlarge at all"
  const STRICT = { widthPx: 1000, heightPx: 1000, dpi: 300, safeInsetPx: 0 };
  A.eq(ops.printCheck(999, 999, STRICT, {}).ok, false, 'printCheck: without a minDpi, any enlargement is refused');
  A.eq(ops.printCheck(1000, 1000, STRICT, {}).ok, true, 'printCheck: an exact-size source is fine');
  await refuses(() => ops.place(wide, { widthPx: 100, heightPx: 100, dpi: 300, safeInsetPx: 50 }, {}), 'ART_BAD_PLACEMENT', 'place: an inset that leaves no print area is refused');
  await refuses(() => ops.place(wide, { widthPx: 100, heightPx: 100 }, {}), 'ART_BAD_PLACEMENT', 'place: a placement without dpi is refused');
  A.throws(() => ops.printCheck(10, 10, STRICT, { fill: 0 }), 'printCheck: fill must be above zero');

  // ---------- fabric ----------
  const onBlack = await ops.fabricContrast(BLACK_MARK, '#000000');
  A.eq(onBlack.fabricIsDark, true, 'fabricContrast: black is a dark fabric');
  A.ok(Math.abs(onBlack.lowContrastShare - (80 * 40 - 20 * 20) / (80 * 40)) < 0.01, 'fabricContrast: the near-black part of the art is flagged on black fabric (' + onBlack.lowContrastShare + ')');
  const onWhite = await ops.fabricContrast(BLACK_MARK, '#ffffff');
  A.ok(onWhite.lowContrastShare < 0.01 + (20 * 20) / (80 * 40) && onWhite.lowContrastShare > 0.1, 'fabricContrast: on white only the yellow square is weak (' + onWhite.lowContrastShare + ')');
  await refuses(() => ops.fabricContrast(BLACK_MARK, 'black'), 'ART_BAD_COLOR', 'fabricContrast: a fabric must be a #rrggbb colour');

  const none = await ops.recolorForFabric(BLACK_MARK, { fabric: '#000000', strategy: 'none' });
  A.eq((await pixels(none.buffer)).at(25, 25), [5, 5, 5, 255], 'recolor none: unchanged');
  const sep = await ops.recolorForFabric(BLACK_MARK, { fabric: '#000000', strategy: 'separate' });
  const sp = await pixels(sep.buffer);
  A.ok(sp.at(25, 25)[0] > 40, 'recolor separate: near-black art is lifted off black fabric (' + sp.at(25, 25).join(',') + ')');
  A.eq(sp.at(45, 35), [255, 238, 0, 255], 'recolor separate: colours that already read are untouched');
  A.eq(sp.at(2, 2)[3], 0, 'recolor separate: transparency is untouched');
  A.ok(Math.abs(sep.changedShare - onBlack.lowContrastShare) < 0.01, 'recolor separate: it changed exactly the share that was flagged (' + sep.changedShare + ')');
  const after = await ops.fabricContrast(sep.buffer, '#000000');
  A.eq(after.lowContrastShare, 0, 'recolor separate: afterwards nothing is below the contrast floor');
  const sepW = await ops.recolorForFabric(BLACK_MARK, { fabric: '#ffffff', strategy: 'separate' });
  const swp = await pixels(sepW.buffer);
  A.eq(swp.at(25, 25), [5, 5, 5, 255], 'recolor separate on white: the black art is left alone');
  A.ok(swp.at(45, 35)[0] < 255, 'recolor separate on white: the pale yellow is darkened');

  const ol = await ops.recolorForFabric(BLACK_MARK, { fabric: '#000000', strategy: 'outline', width: 4 });
  A.eq([ol.width, ol.height], [128, 88], 'recolor outline: the canvas grows by the outline width on every side, so nothing is clipped');
  A.eq([ol.outlineColor, ol.note], ['#ffffff', null], 'recolor outline: white on dark fabric');
  const op = await pixels(ol.buffer);
  A.eq(op.at(4 + 20 - 3, 4 + 40), [255, 255, 255, 255], 'recolor outline: there is outline just outside the artwork');
  A.eq(op.at(4 + 25, 4 + 25), [5, 5, 5, 255], 'recolor outline: the artwork itself is drawn on top, unchanged');
  A.eq(op.at(4 + 20 - 8, 4 + 40)[3], 0, 'recolor outline: beyond the outline width it is still transparent');
  const olL = await ops.recolorForFabric(BLACK_MARK, { fabric: '#f0f0f0', strategy: 'outline' });
  A.eq(olL.outlineColor, '#111111', 'recolor outline: near-black on light fabric');
  const olR = await ops.recolorForFabric(BLEED, { fabric: '#000000', strategy: 'outline', width: 2 });
  A.ok(/rectangular edge/.test(String(olR.note)), 'recolor outline: on an image with no transparency it says the outline is just the rectangle');
  await refuses(() => ops.recolorForFabric(BLACK_MARK, { fabric: '#000000', strategy: 'glow' }), 'ART_BAD_OPTION', 'recolor: an unknown strategy is refused');

  // ---------- determinism ----------
  const again = await ops.place(wide, SAFE, { fill: 0.5 });
  A.ok(Buffer.compare(again.buffer, half.buffer) === 0, 'the same input and options give byte-identical output');

  /* ---- preview: the small copy an agent (or the Gallery) looks at ---- */
  {
    const big = C.createCanvas(4500, 5400); { const g = big.getContext('2d'); g.fillStyle = '#ff00aa'; g.fillRect(1000, 1000, 2500, 3400); }
    const src = big.toBuffer('image/png');
    const pv = await ops.preview(src, { backgroundHex: '#0B0B0B' });
    A.eq([pv.width, pv.height, pv.background], [1307, 1568, '#0b0b0b'], 'a print-size image is scaled down to a 1568 px long edge, proportions kept');
    A.ok(pv.buffer[0] === 0xff && pv.buffer[1] === 0xd8 && pv.buffer.length < 600000, 'it is a small JPEG (' + pv.buffer.length + ' bytes)');
    const back = await C.loadImage(pv.buffer), cv = C.createCanvas(back.width, back.height), g = cv.getContext('2d'); g.drawImage(back, 0, 0);
    const corner = g.getImageData(5, 5, 1, 1).data, mid = g.getImageData(650, 780, 1, 1).data;
    A.ok(corner[0] < 30 && corner[1] < 30 && corner[2] < 30, 'the transparent page is shown on the fabric colour asked for');
    A.ok(mid[0] > 230 && mid[1] < 40 && mid[2] > 140, 'the artwork is where it was');
    const small = C.createCanvas(300, 200).toBuffer('image/png');
    const sp = await ops.preview(small, {});
    A.eq([sp.width, sp.height, sp.scale, sp.background], [300, 200, 1, '#7f7f7f'], 'a small image is never enlarged; the default background is mid grey');
    A.ok(Buffer.compare(src, big.toBuffer('image/png')) === 0, 'the source bytes are untouched');
  }

  A.report('art-ops.test');
})().catch(e => { console.error(e); process.exit(1); });
