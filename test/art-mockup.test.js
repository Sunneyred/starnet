/* node test/art-mockup.test.js — mockups: the print lands where the template says, and nothing is passed off as
   more than it is (Art Studio Phase 4). Real image library; a real owner pack on disk.

   Verifies: every catalog product has a drawn template; the print is mapped onto the print quad (corner colours
   land at the quad's corners, for an axis-aligned AND a skewed quad); fabric tint; masks cut the print but not the
   product; owner packs are validated (license required, a bad quad refused) and reported, never half-loaded; and
   the mockup_render tool records on the design and marks it READY only when the record agrees. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const C = require('@napi-rs/canvas');
const { makeMockups, validatePack, warpQuad, quadPoint, DRAWN_IDS, SIZE } = require('../sidecar/art/mockup.js');
const { loadCatalog } = require('../sidecar/art/products.js');
const { makeArtTools } = require('../sidecar/tools/builtin/art.js');
const { makeDesignStore } = require('../sidecar/art/design-store.js');

const ROOT = path.join(os.tmpdir(), 'starnet-art-mockup-test-' + process.pid);
const PACKS = path.join(ROOT, 'art-templates');
const draw = (w, h, fn) => { const cv = C.createCanvas(w, h), g = cv.getContext('2d'); fn(g); return cv.toBuffer('image/png'); };
async function px(buf) { const img = await C.loadImage(buf); const cv = C.createCanvas(img.width, img.height), g = cv.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data; return { w: img.width, h: img.height, at: (x, y) => Array.from(d.slice((Math.round(y) * img.width + Math.round(x)) * 4, (Math.round(y) * img.width + Math.round(x)) * 4 + 4)) }; }
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= (tol || 12));
async function refuses(fn, re, msg) { try { await fn(); A.ok(false, msg + ' — it did not refuse'); } catch (e) { A.ok(re.test(String(e && e.message)), msg + ' — got: ' + String(e && e.message).slice(0, 240)); } }
// a print file whose four quarters are four known colours: red TL, green TR, blue BR, yellow BL
const QUAD_PRINT = draw(600, 800, g => { [['#ff0000', 0, 0], ['#00ff00', 300, 0], ['#0000ff', 300, 400], ['#ffff00', 0, 400]].forEach(([c, x, y]) => { g.fillStyle = c; g.fillRect(x, y, 300, 400); }); });
const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], YELLOW = [255, 255, 0, 255];

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(PACKS, { recursive: true });
  const M = makeMockups({ canvas: C });
  A.throws(() => makeMockups({}), 'mockups refuse to exist without a canvas library');

  /* ---- coverage: every product in the catalog can be mocked up ---- */
  const cat = loadCatalog();
  for (const p of cat.list()) { const t = M.forProduct(p.id); A.ok(t && t.kind === 'drawn', p.id + ' has a drawn template (' + (t && t.id) + ')'); }
  A.eq(M.list().map(t => t.id), DRAWN_IDS, 'with no owner packs, the list is the built-in templates');
  A.ok(M.list().every(t => /drawn by this app/.test(t.license)), 'each built-in states it is drawn by the app, not a third-party image');
  A.eq(M.list('poster-18x24').map(t => t.id), ['poster-wall'], 'list filters by product');
  A.eq(M.get('nope'), null, 'an unknown template is null');

  /* ---- geometry ---- */
  A.eq(quadPoint([[0, 0], [10, 0], [10, 10], [0, 10]], 0.5, 0.5), [5, 5], 'quadPoint: the middle of a square');
  A.eq(quadPoint([[0, 0], [20, 0], [10, 10], [0, 10]], 1, 1), [10, 10], 'quadPoint: a corner of a skewed quad');

  /* ---- the print lands on the quad: axis-aligned (tee) ---- */
  const tee = await M.render(QUAD_PRINT, 'tee-flat', { fabricHex: '#0b0b0b' });
  A.eq([tee.width, tee.height, tee.kind, tee.warp], [SIZE, SIZE, 'drawn', 'rect'], 'a drawn mockup is 2000x2000 and says it is drawn');
  const tp = await px(tee.buffer);
  // tee-flat print quad: (670,600)-(1330,1480)
  A.ok(near(tp.at(690, 620), RED) && near(tp.at(1310, 620), GREEN) && near(tp.at(1310, 1460), BLUE) && near(tp.at(690, 1460), YELLOW), 'each corner of the print is at its corner of the print area');
  A.ok(near(tp.at(1000, 500), [11, 11, 11, 255], 40), 'above the print area is the shirt, in the fabric colour (' + tp.at(1000, 500).join(',') + ')');
  A.ok(!near(tp.at(60, 60), [11, 11, 11, 255], 40), 'the backdrop is not the shirt colour');
  const teeW = await px((await M.render(QUAD_PRINT, 'tee-flat', { fabricHex: '#ffffff' })).buffer);
  A.ok(teeW.at(1000, 500)[0] > 200, 'the same template tints to a white shirt');
  A.ok(teeW.at(60, 60)[0] < 140, 'and a white shirt gets a dark backdrop, so it is not lost against it');
  await refuses(() => M.render(QUAD_PRINT, 'tee-flat', { fabricHex: 'black' }), /#rrggbb/, 'a fabric must be a real colour');
  await refuses(() => M.render(QUAD_PRINT, 'nope'), /no mockup template "nope"\. Templates: tee-flat/, 'an unknown template is refused, listing the real ones');
  await refuses(() => M.render(Buffer.from('x'), 'tee-flat'), /print file is not a readable image/, 'a corrupt print file is refused');

  /* ---- a transparent print shows the product through it ---- */
  const holed = draw(600, 800, g => { g.fillStyle = '#ff0000'; g.fillRect(0, 0, 600, 400); });   // top half art, bottom half transparent
  const hp = await px((await M.render(holed, 'tee-flat', { fabricHex: '#ffffff' })).buffer);
  A.ok(near(hp.at(1000, 700), RED) && hp.at(1000, 1300)[0] > 200 && hp.at(1000, 1300)[1] > 200, 'where the print file is transparent, the shirt shows through');

  /* ---- masks and overlays: the phone case clips the print to its shape and draws the camera on top ---- */
  const full = draw(900, 1800, g => { g.fillStyle = '#00ff00'; g.fillRect(0, 0, 900, 1800); });
  const cp = await px((await M.render(full, 'phone-case-back')).buffer);
  A.ok(near(cp.at(1000, 1000), GREEN), 'the print covers the case');
  A.ok(!near(cp.at(653, 203), GREEN, 60), 'the rounded corner is cut by the mask (' + cp.at(653, 203).join(',') + ')');
  A.ok(cp.at(780, 330)[1] < 100, 'the camera is drawn over the print');

  /* ---- determinism ---- */
  const again = await M.render(QUAD_PRINT, 'tee-flat', { fabricHex: '#0b0b0b' });
  A.ok(Buffer.compare(again.buffer, tee.buffer) === 0, 'the same print and template give byte-identical output');

  /* ---- a skewed quad uses the triangle grid and still lands on its corners ---- */
  { const cv = C.createCanvas(400, 400), g = cv.getContext('2d'); const img = await C.loadImage(QUAD_PRINT);
    const q = [[80, 40], [330, 80], [300, 360], [50, 300]];
    A.eq(warpQuad(g, img, 600, 800, q, 16), 'grid', 'a non-rectangular quad is drawn as a triangle grid');
    const d = g.getImageData(0, 0, 400, 400).data, at = (x, y) => Array.from(d.slice((y * 400 + x) * 4, (y * 400 + x) * 4 + 4));
    const inset = (i, t) => { const c = quadPoint(q, 0.5, 0.5); return [Math.round(lerp(q[i][0], c[0], t)), Math.round(lerp(q[i][1], c[1], t))]; };
    function lerp(a, b, t) { return a + (b - a) * t; }
    const [a, b, c2, e] = [0, 1, 2, 3].map(i => at(...inset(i, 0.15)));
    A.ok(near(a, RED, 30) && near(b, GREEN, 30) && near(c2, BLUE, 30) && near(e, YELLOW, 30), 'each corner colour is at its corner of the skewed quad');
    A.eq(at(10, 10)[3], 0, 'outside the quad nothing is drawn');
    // no seams: every pixel well inside the quad is fully opaque (a hairline between triangles would show the product through the print)
    let thin = 0, checked = 0;
    for (let v = 0.06; v <= 0.94; v += 0.02) for (let u = 0.06; u <= 0.94; u += 0.02) { const p = quadPoint(q, u, v); checked++; if (at(Math.round(p[0]), Math.round(p[1]))[3] < 250) thin++; }   // 252-254 is rounding where two anti-aliased clips overlap: not a visible seam
    A.eq(thin, 0, 'no seams or holes between the triangles (' + checked + ' interior points checked)'); }

  /* ---- owner packs ---- */
  A.eq(validatePack({ id: 'my-tee', label: 'My tee', productIds: ['tee-front'], license: 'my own photo', base: 'base.png', printQuad: [[100, 100], [300, 100], [300, 400], [100, 400]] }), [], 'a complete pack is valid');
  const probs = validatePack({ id: 'My Tee', productIds: [], base: '../x.png', printQuad: [[100, 100], [300, 400], [300, 100], [100, 400]] });
  A.ok(probs.some(p => /license/.test(p)), 'a pack with no license is refused: the owner must state their rights to the photo');
  A.ok(probs.some(p => /id must be lower-case/.test(p)) && probs.some(p => /needs a label/.test(p)) && probs.some(p => /productIds/.test(p)) && probs.some(p => /base must be an image file name inside/.test(p)), 'id, label, products and an escaping base path are all caught');
  A.ok(probs.some(p => /clockwise/.test(p)), 'a bow-tie print quad is refused');

  const mkPack = (id, json, files) => { const dir = path.join(PACKS, id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'pack.json'), typeof json === 'string' ? json : JSON.stringify(json));
    for (const [n, b] of Object.entries(files || {})) fs.writeFileSync(path.join(dir, n), b); };
  mkPack('my-tee', { id: 'my-tee', label: 'My shirt photo', productIds: ['tee-front'], license: 'my own photo', source: 'shot at home', base: 'base.png', mask: 'mask.png', shading: 'shade.png', printQuad: [[100, 100], [300, 100], [300, 400], [100, 400]] }, {
    'base.png': draw(400, 500, g => { g.fillStyle = '#808080'; g.fillRect(0, 0, 400, 500); }),
    'mask.png': draw(400, 500, g => { g.fillStyle = '#000000'; g.fillRect(100, 100, 100, 300); }),            // only the LEFT half of the print area is printable
    'shade.png': draw(400, 500, g => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 400, 500); g.fillStyle = '#808080'; g.fillRect(0, 250, 400, 250); }) });   // the lower half is in shadow
  mkPack('no-license', { id: 'no-license', label: 'x', productIds: ['tee-front'], base: 'base.png', printQuad: [[1, 1], [9, 1], [9, 9], [1, 9]] }, { 'base.png': draw(10, 10, () => {}) });
  mkPack('broken', '{ not json');
  mkPack('wrong-name', { id: 'other', label: 'x', productIds: ['tee-front'], license: 'mine', base: 'base.png', printQuad: [[1, 1], [9, 1], [9, 9], [1, 9]] }, { 'base.png': draw(10, 10, () => {}) });
  mkPack('missing-file', { id: 'missing-file', label: 'x', productIds: ['tee-front'], license: 'mine', base: 'gone.png', printQuad: [[1, 1], [9, 1], [9, 9], [1, 9]] });
  mkPack('tee-flat', { id: 'tee-flat', label: 'x', productIds: ['tee-front'], license: 'mine', base: 'base.png', printQuad: [[1, 1], [9, 1], [9, 9], [1, 9]] }, { 'base.png': draw(10, 10, () => {}) });
  const MP = makeMockups({ canvas: C, fs, path, packsDir: PACKS });
  A.eq(MP.list().filter(t => t.kind === 'pack').map(t => t.id), ['my-tee'], 'only the valid pack is loaded');
  const errs = MP.loadErrors;
  A.ok(errs.some(e => /^no-license: .*license/.test(e)) && errs.some(e => /^broken: pack\.json could not be read/.test(e)) && errs.some(e => /^wrong-name: .*must match its folder name/.test(e)) &&
    errs.some(e => /^missing-file: .*gone\.png is missing/.test(e)) && errs.some(e => /^tee-flat: .*clashes with a built-in/.test(e)), 'every rejected pack is reported with its reason (' + errs.length + ')');
  A.eq(MP.forProduct('tee-front').id, 'my-tee', 'the owner\'s own pack becomes the default for its product');
  A.eq([MP.get('my-tee').license, MP.get('my-tee').kind], ['my own photo', 'pack'], 'and carries the license the owner stated');
  const pr = await MP.render(QUAD_PRINT, 'my-tee');
  A.eq([pr.width, pr.height, pr.kind, pr.license], [400, 500, 'pack', 'my own photo'], 'a pack mockup is the size of its photo and carries its stated license');
  const pp = await px(pr.buffer);
  A.ok(near(pp.at(110, 110), RED), 'the print is on the photo inside the mask');
  A.ok(near(pp.at(290, 110), [128, 128, 128, 255]), 'outside the mask the photo shows, not the print');
  A.ok(near(pp.at(110, 390), [128, 128, 0, 255], 14), 'the shading layer darkens the print (multiply): ' + pp.at(110, 390).join(','));

  /* ---- the tool: record + READY ---- */
  let clock = 9000, n = 0;
  const WS = path.join(ROOT, 'agent');
  const store = makeDesignStore({ fs, path, workspaces: ROOT, now: () => ++clock, newId: () => 'ef' + String(++n).padStart(6, '0') });
  const T = makeArtTools({ fsp, pathMod: path, root: ROOT, designStore: store, mockups: () => M });
  const ctx = { agentId: 'agent', runId: 'run-9', emit() {} }, emitted = []; ctx.emit = (n2, p2) => emitted.push(p2);
  const bytes = draw(3000, 3000, g => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 3000, 3000); g.fillStyle = '#ff00aa'; g.fillRect(300, 300, 2400, 2400); });
  let rec = await store.create({ originalName: 'sq.png', droppedPath: '/d/sq.png', projectRoot: WS, storedRel: 'designs/pending/original.png', sha256: 'b'.repeat(64), bytes: bytes.length, width: 3000, height: 3000 });
  const ID = rec.id, rel = 'designs/' + ID + '/original.png';
  await store._internals.setStoredRel(ID, rel); await fsp.mkdir(path.join(WS, 'designs', ID), { recursive: true }); await fsp.writeFile(path.join(WS, rel), bytes);
  await T.planTool.run({ design: ID, analysis: { summary: 'A magenta square on a white page, flat and graphic.', subjects: ['square'] },
    products: [{ productId: 'tee-front', fabricId: 'black', score: 80, why: 'A bold flat shape reads on a shirt front.' }, { productId: 'cover-art', score: 70, why: 'It is already square and reads at small size.' }] }, ctx);
  await refuses(() => T.mockupTool.run({ design: ID, product: 'tee-front' }, ctx), /has no print file for tee-front yet — a mockup needs one/, 'no mockup before the print file exists');
  await T.prepareTool.run({ design: ID, product: 'tee-front', fabric: 'black' }, ctx);
  await T.prepareTool.run({ design: ID, product: 'cover-art' }, ctx);
  await T.reviewTool.run({ design: ID, product: 'tee-front', verdict: 'redo', notes: 'Move the art higher on the chest and make it smaller.' }, ctx);
  await refuses(() => T.mockupTool.run({ design: ID, product: 'tee-front' }, ctx), /waiting on a redo/, 'a print file sent back for a redo is not mocked up');
  await T.prepareTool.run({ design: ID, product: 'tee-front', fabric: 'black', fill: 0.8 }, ctx);
  await T.reviewTool.run({ design: ID, product: 'tee-front', verdict: 'pass' }, ctx);
  await T.reviewTool.run({ design: ID, product: 'cover-art', verdict: 'pass' }, ctx);
  emitted.length = 0;
  const m1 = await T.mockupTool.run({ design: ID, product: 'tee-front' }, ctx);
  A.eq(m1.summary, 'mockup → designs/' + ID + '/mockups/tee-front-black--tee-flat.png', 'the mockup is saved beside the design');
  A.ok(/a simple DRAWN product, not a photograph/.test(m1.content) && /not a colour-accurate print proof/.test(m1.content), 'the result says what kind of picture it is');
  A.ok(/Not ready yet — no mockup yet for: cover-art\./.test(m1.content), 'and that the design is not ready, naming what is missing');
  A.eq(store.get(ID).status, 'mocking', 'the record agrees: not ready');
  A.eq(emitted.map(e => e.kind), ['image'], 'one image deliverable is emitted');
  A.ok(fs.existsSync(path.join(WS, 'designs', ID, 'mockups', 'tee-front-black--tee-flat.png')), 'the file is on disk');
  const m2 = await T.mockupTool.run({ design: ID, product: 'cover-art' }, ctx);
  A.ok(new RegExp('Design ' + ID + ' is now READY: every print file has a mockup\\. It is waiting for the owner in the Gallery\\.').test(m2.content), 'the last mockup makes the design READY, and the tool says so');
  rec = store.get(ID);
  A.eq([rec.status, rec.mockups.map(x => [x.productId, x.templateId, x.kind])], ['ready', [['tee-front', 'tee-flat', 'template'], ['cover-art', 'cover-square', 'template']]], 'the record holds both mockups and is ready');
  await refuses(() => T.mockupTool.run({ design: ID, product: 'tee-front', template: 'poster-wall' }, ctx), /template poster-wall shows poster-18x24, poster-12x16, not tee-front\. Templates for tee-front: tee-flat/, 'a template for another product is refused');
  await refuses(() => T.mockupTool.run({ design: ID, product: 'tee-front', template: 'nope' }, ctx), /no mockup template "nope"/, 'an unknown template is refused');
  await refuses(() => T.mockupTool.run({ product: 'tee-front' }, ctx), /give "design" .* or "path"/, 'without a design, a print file path is required');
  const loose = await T.mockupTool.run({ product: 'cover-art', path: 'designs/' + ID + '/print/cover-art.png', out: 'loose/cover' }, ctx);
  A.eq(loose.summary, 'mockup → loose/cover.png', 'without a design, any print file can be mocked up to a chosen name');
  A.eq(store.get(ID).mockups.length, 2, 'and nothing is recorded on a design for it');

  fs.rmSync(ROOT, { recursive: true, force: true });
  A.report('art-mockup.test');
})().catch(e => { console.error(e); process.exit(1); });
