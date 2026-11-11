/* node test/art-tools.test.js — the art line's tools (sidecar/tools/builtin/art.js, Art Studio Phase 1d).
   Offline and deterministic: a real temp workspace on disk, designs drawn here pixel for pixel.
   Verifies: print files land in the JAILED workspace at the catalog's exact pixel size; the original design is
   byte-identical afterwards and can never be the output; the result states what was done and measured (dpi,
   steps, unverified specs); too-small art and unknown products are REFUSED with the numbers and write nothing;
   jail escapes are refused; and the CAP_REGISTRY / tool wiring agree (object = capability). */
'use strict';
const A = require('./_assert.js');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const C = require('@napi-rs/canvas');
const { makeArtTools } = require('../sidecar/tools/builtin/art.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');
const Products = require('../sidecar/art/products.js');

const ROOT = path.join(os.tmpdir(), 'starnet-art-tools-test-' + process.pid);
const WS = path.join(ROOT, 'agent');
const draw = (w, h, fn) => { const cv = C.createCanvas(w, h), g = cv.getContext('2d'); fn(g); return cv.toBuffer('image/png'); };
async function size(file) { const img = await C.loadImage(await fsp.readFile(file)); return [img.width, img.height]; }
async function alphaAt(file, x, y) { const img = await C.loadImage(await fsp.readFile(file)); const cv = C.createCanvas(img.width, img.height), g = cv.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(x, y, 1, 1).data[3]; }
function ctxOf() { const emitted = []; return { ctx: { agentId: 'agent', emit: (name, payload) => emitted.push({ name, payload }) }, emitted }; }
async function refuses(fn, re, msg) {
  try { await fn(); A.ok(false, msg + ' — it did not refuse'); }
  catch (e) { A.ok(re.test(String(e && e.message)), msg + ' — got: ' + String(e && e.message).slice(0, 220)); }
}

// a 3000x2000 design: neon block on a flat WHITE page (the usual export from a paint program)
const BIG = draw(3000, 2000, g => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 3000, 2000); g.fillStyle = '#ff00aa'; g.fillRect(300, 200, 2400, 1600); g.fillStyle = '#0b0b0b'; g.fillRect(600, 500, 600, 600); });
// a 300x200 thumbnail of the same thing — far too small for a shirt
const TINY = draw(300, 200, g => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 300, 200); g.fillStyle = '#ff00aa'; g.fillRect(30, 20, 240, 160); });
// a full-bleed picture (no background to remove)
const BLEED = draw(2700, 3600, g => { ['#102030', '#c04020', '#20a060', '#e0d040'].forEach((c, i) => { g.fillStyle = c; g.fillRect((i % 2) * 1350, (i >> 1) * 1800, 1350, 1800); }); });

(async () => {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(path.join(WS, 'drops'), { recursive: true });
  await fsp.writeFile(path.join(WS, 'drops', 'Neon Statue.png'), BIG);
  await fsp.writeFile(path.join(WS, 'drops', 'tiny.png'), TINY);
  await fsp.writeFile(path.join(WS, 'drops', 'bleed.png'), BLEED);
  await fsp.writeFile(path.join(WS, 'drops', 'notes.txt'), 'not an image');
  await fsp.writeFile(path.join(WS, 'drops', 'broken.png'), 'definitely not png bytes');
  const T = makeArtTools({ fsp, pathMod: path, root: ROOT });

  /* ---- wiring: object = capability ---- */
  const grants = CAP_REGISTRY.studio.filter(g => ['product_catalog', 'art_inspect', 'art_prepare', 'mockup_render'].includes(g.tool));
  A.eq(grants.map(g => g.tool).sort(), ['art_inspect', 'art_prepare', 'mockup_render', 'product_catalog'], 'a STUDIO prop grants the four art tools');
  for (const t of T.tools) {
    const g = grants.find(x => x.tool === t.name);
    A.eq([t.capability, t.scope, t.requiresConsent], ['studio', g.scope, g.requiresConsent], t.name + ': the tool and its CAP_REGISTRY grant agree on scope and consent');
    A.eq(g.network, false, t.name + ': declared local — the art line never reaches the network');
  }
  A.eq(T.prepareTool.requiresConsent, true, 'art_prepare writes a file, so it is consent-gated');
  A.eq([T.catalogTool.requiresConsent, T.inspectTool.requiresConsent], [false, false], 'the two reads are consent-free');
  const reg = { names: [], register(t) { this.names.push(t.name); } };
  T.register(reg);
  A.eq(reg.names, ['product_catalog', 'art_inspect', 'art_prepare', 'mockup_render'], 'register() hands over exactly the four tools that need no design record');
  A.throws(() => makeArtTools({}), 'the tools refuse to exist without a workspace root');

  /* ---- product_catalog ---- */
  const cat = await T.catalogTool.run({}, ctxOf().ctx);
  A.ok(/tee-front — T-shirt \(front print\) \[apparel\] VERIFIED spec/.test(cat.content), 'the catalog names a verified product as verified');
  A.ok(/dad-hat-front[^\n]*UNVERIFIED planning spec/.test(cat.content) && /spec caveat:/.test(cat.content), 'and an unverified one as unverified, with its caveat');
  A.ok(/front 3600x4800px \(12x16in @300dpi, min 150/.test(cat.content), 'placements carry exact pixels, inches and dpi');
  A.ok(/fabrics: black \(dark #0b0b0b\)/.test(cat.content), 'fabrics carry their colour and kind');
  const wall = await T.catalogTool.run({ category: 'wall-art' }, ctxOf().ctx);
  A.ok(/poster-18x24/.test(wall.content) && !/tee-front/.test(wall.content), 'category filters the list');
  await refuses(() => T.catalogTool.run({ category: 'furniture' }, ctxOf().ctx), /unknown category/, 'catalog: an unknown category is refused');

  /* ---- art_inspect ---- */
  const ins = await T.inspectTool.run({ path: 'drops/Neon Statue.png' }, ctxOf().ctx);
  A.ok(/3000x2000 px/.test(ins.content) && /Background: flat #ffffff \(light\)/.test(ins.content), 'inspect reports size and the measured background');
  A.ok(/Artwork bounds: 2400x1600 px at \(300, 200\)/.test(ins.content), 'inspect reports the artwork bounds');
  const insP = await T.inspectTool.run({ path: 'drops/Neon Statue.png', product: 'tee-front' }, ctxOf().ctx);
  A.ok(/On tee-front\/front \(3600x4800 px\): prints at 200 dpi \(minimum 150\) — large enough \[measured on the artwork bounds\]/.test(insP.content), 'inspect answers "is it big enough" from the ARTWORK, with the dpi: ' + insP.content.split('\n').pop());
  const insT = await T.inspectTool.run({ path: 'drops/tiny.png', product: 'tee-front' }, ctxOf().ctx);
  A.ok(/TOO SMALL — would print at 20 dpi, below the minimum 150; it could fill at most 13% of the print area/.test(insT.content), 'inspect says too small, with numbers: ' + insT.content.split('\n').pop());
  const insU = await T.inspectTool.run({ path: 'drops/Neon Statue.png', product: 'sticker-4x4' }, ctxOf().ctx);
  A.ok(/UNVERIFIED spec/.test(insU.content), 'inspect flags an unverified product spec');
  await refuses(() => T.inspectTool.run({ path: 'drops/Neon Statue.png', product: 'mug' }, ctxOf().ctx), /unknown product "mug"/, 'inspect: an unknown product is refused');
  await refuses(() => T.inspectTool.run({ path: 'drops/notes.txt' }, ctxOf().ctx), /must be a PNG or JPEG/, 'inspect: a non-image file is refused');
  await refuses(() => T.inspectTool.run({ path: 'drops/broken.png' }, ctxOf().ctx), /could not inspect.*not a readable PNG or JPEG/, 'inspect: a corrupt image is refused, not guessed at');
  await refuses(() => T.inspectTool.run({ path: 'drops/nope.png' }, ctxOf().ctx), /design file not found/, 'inspect: a missing file is named');
  await refuses(() => T.inspectTool.run({ path: 'https://example.com/a.png' }, ctxOf().ctx), /not a URL/, 'inspect: a URL is refused');
  await refuses(() => T.inspectTool.run({ path: '../outside.png' }, ctxOf().ctx), /./, 'inspect: a path escaping the workspace is refused');
  await refuses(() => T.inspectTool.run({}, ctxOf().ctx), /path is required/, 'inspect: path is required');

  /* ---- art_prepare: the happy path ---- */
  const before = await fsp.readFile(path.join(WS, 'drops', 'Neon Statue.png'));
  const { ctx, emitted } = ctxOf();
  const r = await T.prepareTool.run({ path: 'drops/Neon Statue.png', product: 'tee-front', fabric: 'black' }, ctx);
  A.eq(r.summary, 'print file → art/neon-statue/tee-front-black.png', 'the default output name is art/<design>/<product>-<fabric>.png');
  const outFile = path.join(WS, 'art', 'neon-statue', 'tee-front-black.png');
  A.eq(await size(outFile), [3600, 4800], 'the print file on disk is EXACTLY the catalog placement size');
  A.ok((await fsp.readFile(path.join(WS, 'drops', 'Neon Statue.png'))).equals(before), 'the original design is byte-identical afterwards');
  A.ok(/removed the flat #ffffff background/.test(r.content) && /trimmed to the artwork \(2400x1600 px\)/.test(r.content), 'the result lists the steps it actually took');
  A.ok(/printing at 200 dpi \(minimum 150\) — ENLARGED 1\.5x/.test(r.content), 'the result states the print dpi and that it enlarged, within the minimum');
  A.ok(/The original drops\/Neon Statue\.png was not changed\./.test(r.content), 'the result says the original was not changed');
  A.ok(!/SPEC NOT VERIFIED/.test(r.content), 'a verified product carries no spec warning');
  A.ok(/On this fabric, \d+% of the artwork is nearly the fabric colour/.test(r.content), 'the result reports measured contrast on the chosen fabric');
  A.eq([r.data.width, r.data.height, r.data.effectiveDpi, r.data.verifiedSpec, r.data.fabric], [3600, 4800, 200, true, 'black'], 'the structured facts match');
  A.eq(r.data.artRect, { x: 0, y: 0, width: 3600, height: 2400 }, 'the art sits at the top of the shirt print area (the placement default), full width');
  A.eq([await alphaAt(outFile, 1800, 1200), await alphaAt(outFile, 1800, 4000)], [255, 0], 'artwork is opaque where it was placed; the rest of the print area is transparent');
  A.eq(emitted.map(e => [e.name, e.payload.kind, e.payload.title]), [['deliverable', 'image', 'art/neon-statue/tee-front-black.png']], 'exactly one image deliverable is emitted for the saved file');
  A.ok(!fs.readdirSync(path.dirname(outFile)).some(f => /pending/.test(f)), 'no staging file is left behind');

  // the dark block in the art vanishes on black fabric: measured, suggested, and fixable
  A.ok(r.data.lowContrastShare > 0.05, 'the near-black part of the art is measured as low-contrast on black (' + r.data.lowContrastShare + ')');
  const rs = await T.prepareTool.run({ path: 'drops/Neon Statue.png', product: 'tee-front', fabric: 'black', recolor: 'separate', out: 'art/sep.png' }, ctxOf().ctx);
  A.ok(/recoloured \d+% of the artwork away from the black fabric/.test(rs.content), 'recolor separate reports how much it changed');
  A.eq(rs.data.lowContrastShare, 0, 'afterwards nothing is nearly the fabric colour');
  const ro = await T.prepareTool.run({ path: 'drops/Neon Statue.png', product: 'tee-front', fabric: 'white', recolor: 'outline', out: 'art/outlined' }, ctxOf().ctx);
  A.ok(/added a \d+ px #111111 outline/.test(ro.content), 'recolor outline reports the outline it drew');
  A.eq(ro.summary, 'print file → art/outlined.png', 'an output name without an extension becomes .png');

  /* ---- a full-bleed design: nothing is cut out, and it says so ---- */
  const rb = await T.prepareTool.run({ path: 'drops/bleed.png', product: 'tee-front', fabric: 'white' }, ctxOf().ctx);
  A.ok(/full-bleed image with no flat background to remove — it will print as a rectangle/.test(rb.content), 'a photographic design is not cut out, and the result says it prints as a rectangle');
  const rp = await T.prepareTool.run({ path: 'drops/bleed.png', product: 'poster-12x16' }, ctxOf().ctx);
  A.eq(await size(path.join(WS, 'art', 'bleed', 'poster-12x16.png')), [3600, 4800], 'a poster print file is the poster\'s exact size');
  A.ok(/SPEC NOT VERIFIED:/.test(rp.content), 'an unverified product spec is flagged in the result');
  A.eq(rp.data.artRect, { x: 0, y: 0, width: 3600, height: 4800 }, 'a poster fills its sheet (cover is the placement default)');
  A.eq(rp.data.fabric, null, 'a poster has no fabric');

  /* ---- refusals: nothing is written ---- */
  const countFiles = d => fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter(f => /\.png$/.test(String(f))).length : 0;
  const artBefore = countFiles(path.join(WS, 'art'));
  await refuses(() => T.prepareTool.run({ path: 'drops/tiny.png', product: 'tee-front', fabric: 'black' }, ctxOf().ctx),
    /could not make tee-front from drops\/tiny\.png: .*would print at 20 dpi, below the minimum 150 dpi.*No file was written\./, 'prepare: too-small art is refused with the numbers');
  const okTiny = await T.prepareTool.run({ path: 'drops/tiny.png', product: 'tee-front', fabric: 'black', fill: 0.13, out: 'art/tiny-small.png' }, ctxOf().ctx);
  A.ok(okTiny.data.effectiveDpi >= 150, 'at the fill the refusal suggested, the same art is accepted (' + okTiny.data.effectiveDpi + ' dpi)');
  await refuses(() => T.prepareTool.run({ path: 'drops/Neon Statue.png', product: 'tee-front' }, ctxOf().ctx), /printed on fabric: choose one of black/, 'prepare: a fabric product needs a fabric');
  await refuses(() => T.prepareTool.run({ path: 'drops/Neon Statue.png', product: 'mug' }, ctxOf().ctx), /unknown product "mug"/, 'prepare: an unknown product is refused');
  await refuses(() => T.prepareTool.run({ path: 'drops/Neon Statue.png', product: 'tee-front', fabric: 'black', placement: 'sleeve' }, ctxOf().ctx), /no placement "sleeve"/, 'prepare: an unknown placement is refused');
  await refuses(() => T.prepareTool.run({ path: 'drops/bleed.png', product: 'poster-12x16', recolor: 'separate' }, ctxOf().ctx), /needs a fabric product/, 'prepare: recolour without a fabric is refused');
  await refuses(() => T.prepareTool.run({ path: 'drops/Neon Statue.png', product: 'poster-12x16', out: 'drops/Neon Statue.png' }, ctxOf().ctx), /would overwrite the original design.*Originals are never modified/, 'prepare: the original can never be the output');
  await refuses(() => T.prepareTool.run({ path: 'drops/Neon Statue.png', product: 'poster-12x16', out: '../../escape.png' }, ctxOf().ctx), /./, 'prepare: an output path escaping the workspace is refused');
  await refuses(() => T.prepareTool.run({ path: 'drops/broken.png', product: 'poster-12x16' }, ctxOf().ctx), /not a readable PNG or JPEG.*No file was written/, 'prepare: a corrupt design is refused');
  A.eq(countFiles(path.join(WS, 'art')), artBefore + 1, 'the refusals wrote nothing (only the accepted small-fill file was added)');
  A.ok(!fs.existsSync(path.join(ROOT, 'escape.png')) && !fs.existsSync(path.join(ROOT, '..', 'escape.png')), 'nothing was written outside the workspace');
  A.ok((await fsp.readFile(path.join(WS, 'drops', 'Neon Statue.png'))).equals(before), 'after everything, the original is still byte-identical');

  /* ---- the owner's catalog override reaches the tools ---- */
  const T2 = makeArtTools({ fsp, pathMod: path, root: ROOT, loadCatalog: () => Products.loadCatalog({
    fs: { existsSync: () => true, readFileSync: () => JSON.stringify({ products: [{ id: 'tee-front', enabled: false }] }) }, overridePath: 'x' }) });
  await refuses(() => T2.prepareTool.run({ path: 'drops/Neon Statue.png', product: 'tee-front', fabric: 'black' }, ctxOf().ctx), /switched off in the catalog/, 'a product the owner switched off cannot be made');
  A.ok(!/tee-front/.test((await T2.catalogTool.run({}, ctxOf().ctx)).content), 'and is not offered');

  await fsp.rm(ROOT, { recursive: true, force: true });
  A.report('art-tools.test');
})().catch(e => { console.error(e); process.exit(1); });
