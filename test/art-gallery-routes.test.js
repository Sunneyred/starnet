/* node test/art-gallery-routes.test.js — the Gallery's API (Art Studio Phase 5).
   Real temp line folder, real design store, real tools to make the files. Verifies: the list is the record plus spend
   summed from real runs; /api/art/file serves ONLY files the record names, inside the line folder (no traversal, no
   symlink escape, no non-images); approvals are the owner's and are recorded exactly; a redo is recorded and the
   rerun's REAL outcome reported; export refuses without the rights confirmation or an approval, then copies new
   files and a DRAFT listing built only from the record — and never touches the originals. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const C = require('@napi-rs/canvas');
const { makeArtTools } = require('../sidecar/tools/builtin/art.js');
const { makeDesignStore } = require('../sidecar/art/design-store.js');
const { makeArtRoutes } = require('../sidecar/art/gallery-routes.js');
const { loadCatalog } = require('../sidecar/art/products.js');

const ROOT = path.join(os.tmpdir(), 'starnet-art-gallery-test-' + process.pid);
const WS = path.join(ROOT, 'agent');   // the tools' working folder for agent "agent"
let clock = 9000, n = 0;
const ctx = { agentId: 'agent', runId: 'run-7', model: 'test-model', emit() {} };

/* a minimal req/res pair: what the handlers actually use */
function call(handler, { url = '/', body } = {}) {
  return new Promise((resolve, reject) => {
    const res = { headersSent: false, status: 0, headers: {}, json: null, buf: null,
      writeHead(code, h) { this.status = code; this.headers = h || {}; this.headersSent = true; },
      end(b) { this.buf = b || null; resolve(this); } };
    Promise.resolve(handler({ url, _body: body }, res)).catch(reject);
  });
}
const respondJson = (res, code, obj) => { res.status = code; res.json = obj; res.headersSent = true; res.end(); };
const readBody = async req => (req._body === undefined ? '' : (typeof req._body === 'string' ? req._body : JSON.stringify(req._body)));

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const store = makeDesignStore({ fs, path, workspaces: ROOT, now: () => ++clock, newId: () => 'ga' + String(++n).padStart(6, '0') });
  const T = makeArtTools({ fsp, pathMod: path, root: ROOT, designStore: store });
  const catalog = loadCatalog({ fs });
  const reruns = [];
  let rerunResult = { ok: true, queued: true };
  const R = makeArtRoutes({ store, fs, fsp, path, respondJson, readBody, catalog: () => catalog,
    spendOf: ids => ({ usd: ids.length * 0.0125 }), grantState: () => ({ artWrite: true }),
    rerun: async (rec, product, note) => { reruns.push([rec.id, product, note]); if (rerunResult instanceof Error) throw rerunResult; return rerunResult; } });

  A.throws(() => makeArtRoutes({ store }), /fs is required/, 'the routes refuse to be built without their dependencies');

  /* ---- empty ---- */
  let r = await call(R.designs);
  A.eq([r.status, r.json.ok, r.json.designs.length, r.json.grants], [200, true, 0, { artWrite: true }], 'an empty gallery is an empty list, with the grant state as the sidecar reports it');
  A.ok(r.json.products.some(p => p.id === 'tee-front' && p.verified === true) && r.json.products.some(p => p.verified === false && p.sourceNote), 'the product list carries each spec\'s verified flag and source note');

  /* ---- a design taken through the line with the real tools ---- */
  const art = C.createCanvas(3000, 2000); { const g = art.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 3000, 2000); g.fillStyle = '#ff00aa'; g.fillRect(300, 200, 2400, 1600); }
  const bytes = art.toBuffer('image/png');
  let rec = await store.create({ originalName: 'Neon Angel!.png', droppedPath: '/drops/Neon Angel!.png', projectRoot: WS, storedRel: 'designs/pending/original.png', sha256: 'b'.repeat(64), bytes: bytes.length, width: 3000, height: 2000, lineId: 'L1',
    facts: { background: { kind: 'flat', color: '#ffffff' }, bbox: { x: 300, y: 200, width: 2400, height: 1600 }, coverage: 0.64, dominantColors: [{ hex: '#ff00aa', share: 1 }] } });
  const ID = rec.id, orig = 'designs/' + ID + '/original.png';
  await store._internals.setStoredRel(ID, orig);
  await fsp.mkdir(path.join(WS, 'designs', ID), { recursive: true });
  await fsp.writeFile(path.join(WS, orig), bytes);
  const origBefore = fs.readFileSync(path.join(WS, orig));
  await T.planTool.run({ design: ID, analysis: { summary: 'A magenta block on white, flat and graphic.', subjects: ['block'], mood: 'bold', palette: ['magenta'] },
    products: [{ productId: 'tee-front', fabricId: 'black', score: 90, why: 'A flat bold shape reads well on a shirt front.', titleIdeas: ['Magenta Block Tee'] },
      { productId: 'sticker-4x4', score: 70, why: 'A simple shape die-cuts cleanly.' }], skipped: [] }, ctx);
  await T.prepareTool.run({ design: ID, product: 'tee-front', fabric: 'black' }, ctx);
  await T.prepareTool.run({ design: ID, product: 'sticker-4x4' }, ctx);
  await T.mockupTool.run({ design: ID, product: 'tee-front' }, ctx);
  await T.mockupTool.run({ design: ID, product: 'sticker-4x4' }, ctx);
  await store.addRun(ID, 'run-7', 0); await store.addRun(ID, 'run-8', 0);
  rec = store.get(ID);
  A.ok(rec.variants.length === 2 && rec.mockups.length === 2, 'fixture: two print files and two mockups on the record');

  /* ---- list ---- */
  r = await call(R.designs);
  const d0 = r.json.designs[0];
  A.eq([r.json.designs.length, d0.id, d0.runCount, d0.spendUsd, d0.spendFromRuns], [1, ID, 2, 0.025, true], 'the list shows the design with spend summed from its real runs');
  const noSpend = makeArtRoutes({ store, fs, fsp, path, respondJson, readBody });
  r = await call(noSpend.designs);
  A.eq([r.json.designs[0].spendFromRuns, r.json.products, r.json.grants], [false, [], null], 'without a run store it says the spend is NOT from runs, and invents no products or grants');

  /* ---- file ---- */
  const q = (design, p) => '/api/art/file?design=' + encodeURIComponent(design) + '&path=' + encodeURIComponent(p);
  r = await call(R.file, { url: q(ID, orig) });
  A.ok(r.status === 200 && r.headers['Content-Type'] === 'image/png' && r.headers['X-Content-Type-Options'] === 'nosniff' && Buffer.compare(r.buf, bytes) === 0, 'the design\'s own copy is served byte-for-byte as a PNG');
  r = await call(R.file, { url: q(ID, rec.variants[0].path) });
  A.ok(r.status === 200 && r.buf.length > 100, 'a print file on the record is served');
  r = await call(R.file, { url: q(ID, rec.variants[0].previewPath) });
  A.ok(r.status === 200 && r.headers['Content-Type'] === 'image/jpeg', 'its small preview is served as a JPEG');
  r = await call(R.file, { url: q(ID, rec.mockups[0].path) });
  A.ok(r.status === 200, 'a mockup on the record is served');
  await fsp.writeFile(path.join(WS, 'designs', ID, 'secret.png'), bytes);
  await fsp.writeFile(path.join(ROOT, 'outside.png'), bytes);
  for (const [p, why] of [['designs/' + ID + '/secret.png', 'a real file in the folder that the record does not name'], ['../outside.png', 'a traversal'], [path.join(ROOT, 'outside.png'), 'an absolute path'], ['', 'an empty path']]) {
    r = await call(R.file, { url: q(ID, p) });
    A.eq([r.status, r.json && r.json.ok], [404, false], 'refused: ' + why);
  }
  r = await call(R.file, { url: q('nope', orig) });
  A.eq(r.status, 404, 'an unknown design is a 404');
  // a recorded path that has been swapped for a link pointing outside the line folder is not followed
  const linkRel = rec.mockups[1].path, linkAbs = path.join(WS, linkRel), keep = fs.readFileSync(linkAbs);
  let linked = false;
  try { fs.unlinkSync(linkAbs); fs.symlinkSync(path.join(ROOT, 'outside.png'), linkAbs); linked = true; } catch (e) { A.ok(true, 'symlinks unavailable here (' + e.code + ') — escape check skipped'); }
  if (linked) { r = await call(R.file, { url: q(ID, linkRel) }); A.eq(r.status, 404, 'a recorded path that now links outside the line folder is refused'); fs.unlinkSync(linkAbs); }
  fs.writeFileSync(linkAbs, keep);
  // recorded but gone
  const gone = rec.variants[1].path, goneAbs = path.join(WS, gone), goneKeep = fs.readFileSync(goneAbs);
  fs.unlinkSync(goneAbs);
  r = await call(R.file, { url: q(ID, gone) });
  A.eq(r.status, 404, 'a recorded file that is no longer on disk is a 404, not a blank image');

  /* ---- export refuses first ---- */
  r = await call(R.exportDesign, { body: { design: ID } });
  A.eq([r.status, r.json.code], [409, 'RIGHTS_NOT_CONFIRMED'], 'export refuses without the rights confirmation');
  r = await call(R.rights, { body: { design: ID, confirmed: 'yes' } });
  A.eq(r.json.design.rightsConfirmed, false, 'only a literal true confirms rights');
  r = await call(R.rights, { body: { design: ID, confirmed: true } });
  A.eq([r.status, r.json.design.rightsConfirmed], [200, true], 'the owner\'s confirmation is recorded');
  r = await call(R.exportDesign, { body: { design: ID } });
  A.eq([r.status, r.json.code], [409, 'NOTHING_APPROVED'], 'export refuses with nothing approved');
  A.ok(!fs.existsSync(path.join(WS, 'export')), 'and a refused export wrote nothing');

  /* ---- approvals ---- */
  r = await call(R.approve, { body: '{not json' });
  A.eq(r.status, 400, 'bad JSON is a 400');
  r = await call(R.approve, { body: { design: ID, product: 'tee-front', decision: 'maybe' } });
  A.eq(r.status, 409, 'an unknown decision is refused');
  r = await call(R.approve, { body: { design: ID, product: 'poster-18x24', decision: 'approved' } });
  A.eq(r.status, 409, 'a product with no print file cannot be approved');
  r = await call(R.approve, { body: { design: 'nope', product: 'tee-front', decision: 'approved' } });
  A.eq(r.status, 404, 'an unknown design is a 404');
  r = await call(R.approve, { body: { design: ID, product: 'tee-front', decision: 'approved' } });
  A.eq([r.status, r.json.design.approvals['tee-front'].decision, r.json.rerun, reruns.length], [200, 'approved', null, 0], 'an approval is recorded and starts nothing');
  r = await call(R.approve, { body: { design: ID, product: 'sticker-4x4', decision: 'redo', note: 'Make it bigger on the sticker.' } });
  A.eq([r.json.design.approvals['sticker-4x4'].decision, r.json.rerun, reruns], ['redo', { ok: true, queued: true }, [[ID, 'sticker-4x4', 'Make it bigger on the sticker.']]], 'a redo is recorded, the line is asked to run again with the note, and its answer is passed on');
  rerunResult = new Error('the line is paused');
  r = await call(R.approve, { body: { design: ID, product: 'sticker-4x4', decision: 'redo', note: 'Again.' } });
  A.eq([r.status, r.json.ok, r.json.rerun], [200, true, { ok: false, error: 'the line is paused' }], 'when the rerun fails the redo is still recorded and the failure is reported as a failure');
  r = await call(noSpend.approve, { body: { design: ID, product: 'sticker-4x4', decision: 'redo' } });
  A.ok(r.json.rerun.ok === false && /cannot restart the line/.test(r.json.rerun.error), 'with no way to rerun it says so instead of implying a restart');

  /* ---- export ---- */
  r = await call(R.exportDesign, { body: { design: ID } });
  const dirRel = 'export/neon-angel-' + ID;
  A.eq([r.status, r.json.ok, r.json.products, r.json.problems, r.json.folder], [200, true, ['tee-front'], [], path.join(WS, dirRel)], 'export copies only the approved product and says where');
  A.eq(r.json.written.slice().sort(), [dirRel + '/tee-front/listing.txt', dirRel + '/tee-front/mockup-black-tee-flat.png', dirRel + '/tee-front/print-black.png'].sort(), 'print file, mockup and a listing');
  for (const w of r.json.written) A.ok(fs.statSync(path.join(WS, w)).size > 0, 'really on disk: ' + w);
  A.ok(/Nothing was published or uploaded/.test(r.json.note), 'and it says nothing was published');
  const listing = fs.readFileSync(path.join(WS, dirRel, 'tee-front', 'listing.txt'), 'utf8');
  A.ok(/^DRAFT LISTING/.test(listing) && /Magenta Block Tee/.test(listing) && /A magenta block on white/.test(listing) && /fit judgement, not sales data/.test(listing) && /not colour-accurate print proofs/.test(listing), 'the listing is labelled a draft and is built from the record\'s own words');
  A.ok(!/CHECK BEFORE SELLING/.test(listing), 'a verified product carries no unverified-size warning');
  A.ok(!fs.existsSync(path.join(WS, dirRel, 'sticker-4x4')), 'the product awaiting a redo was not exported');
  // an unverified product, approved while its print file is missing: the export says so rather than pretending
  await call(R.approve, { body: { design: ID, product: 'sticker-4x4', decision: 'approved' } });
  r = await call(R.exportDesign, { body: { design: ID } });
  A.ok(r.status === 200 && r.json.problems.some(p => /sticker-4x4: the print file .* is missing/.test(p)), 'a missing print file is reported as a problem');
  A.ok(/CHECK BEFORE SELLING: this product's print size is an unverified planning figure/.test(fs.readFileSync(path.join(WS, dirRel, 'sticker-4x4', 'listing.txt'), 'utf8')), 'an unverified product\'s listing carries the warning');
  fs.writeFileSync(goneAbs, goneKeep);
  A.eq(store.get(ID).status, 'approved', 'with every made product decided and one approved, the design is approved');
  A.ok(Buffer.compare(fs.readFileSync(path.join(WS, orig)), origBefore) === 0, 'the design\'s original copy is byte-identical after everything');

  /* ---- resume: carry on with a design that stopped part-way ---- */
  {
    const asked = []; let answer = { ok: true };
    const RS = makeArtRoutes({ store, fs, fsp, path, respondJson, readBody, resume: async r0 => { asked.push(r0.id); if (answer instanceof Error) throw answer; return answer; } });
    r = await call(RS.resume, { body: { design: ID } });
    A.ok(r.status === 409 && r.json.code === 'NOT_RESUMABLE' && /send back/.test(r.json.error) && asked.length === 0, 'a finished design is refused, and pointed at "send back"');
    const stuck = await store.create({ originalName: 'Stuck.png', droppedPath: '/drops/Stuck.png', projectRoot: WS, storedRel: 'designs/pending/original.png', sha256: 'c'.repeat(64), bytes: 10, width: 100, height: 100, lineId: 'L1' });
    r = await call(RS.resume, { body: { design: stuck.id } });
    A.eq([r.status, r.json.ok, r.json.error, asked], [200, true, null, [stuck.id]], 'a design that stopped is handed back to the line');
    answer = { ok: false, error: 'the line reached its $5.00 daily limit' };
    r = await call(RS.resume, { body: { design: stuck.id } });
    A.eq([r.status, r.json.ok, r.json.error], [200, false, 'the line reached its $5.00 daily limit'], 'when the line refuses, its own reason is passed on — never "started"');
    answer = new Error('boom');
    r = await call(RS.resume, { body: { design: stuck.id } });
    A.eq([r.json.ok, r.json.error], [false, 'boom'], 'a thrown restart is reported as not started');
    r = await call(noSpend.resume, { body: { design: stuck.id } });
    A.eq(r.status, 501, 'a station that cannot restart the line says so');
    A.eq((await call(RS.resume, { body: { design: 'nope' } })).status, 404, 'an unknown design is a 404');
    await store.fail(stuck.id, 'intake', 'copy failed');
    r = await call(RS.resume, { body: { design: stuck.id } });
    A.ok(r.status === 409 && /drop the file again/.test(r.json.error), 'a failed design is refused with what to do instead');
  }

  /* ---- setup: two folders inside the one the owner chose ---- */
  {
    const chosen = path.join(ROOT, 'Art Station'); fs.mkdirSync(chosen, { recursive: true });
    const blessed = []; let dropAnswer = p => ({ ok: true, path: p }), blessAnswer = p => ({ ok: true, root: p });
    const S = makeArtRoutes({ store, fs, fsp, path, respondJson, readBody, checkDropFolder: async p => dropAnswer(p), blessProject: async p => { blessed.push(p); return blessAnswer(p); } });
    r = await call(S.setup, { body: { folder: 'relative/path' } });
    A.eq(r.status, 400, 'a relative path is refused');
    r = await call(S.setup, { body: { folder: path.join(ROOT, 'nope') } });
    A.ok(r.status === 400 && /does not exist/.test(r.json.error), 'a folder that does not exist is refused (setup never invents the owner\'s folder)');
    r = await call(S.setup, { body: { folder: path.join(WS, orig) } });
    A.ok(r.status === 400 && /is a file/.test(r.json.error), 'a file is refused');
    r = await call(noSpend.setup, { body: { folder: chosen } });
    A.eq(r.status, 501, 'a station without the folder policy says it cannot set up, instead of half doing it');
    dropAnswer = () => ({ ok: false, code: 'outside', error: 'only folders inside your home folder or a project you added can be watched.' });
    r = await call(S.setup, { body: { folder: chosen } });
    A.ok(r.status === 400 && r.json.code === 'outside' && /cannot be watched/.test(r.json.error) && blessed.length === 0, 'when the drop folder may not be watched it stops BEFORE trusting anything, and says why');
    dropAnswer = p => ({ ok: true, path: p });
    blessAnswer = () => ({ ok: false, reason: 'that folder is protected' });
    r = await call(S.setup, { body: { folder: chosen } });
    A.ok(r.status === 400 && /could not be trusted.*that folder is protected/.test(r.json.error), 'a refused trust is reported with its reason');
    blessAnswer = p => ({ ok: true, root: p });
    r = await call(S.setup, { body: { folder: chosen } });
    A.eq([r.status, r.json.ok, r.json.drop, r.json.studio], [200, true, path.join(chosen, 'Drop designs here'), path.join(chosen, 'Studio files')], 'setup answers the two folders');
    A.ok(fs.statSync(r.json.drop).isDirectory() && fs.statSync(r.json.studio).isDirectory(), 'both really exist');
    A.eq(blessed[blessed.length - 1], path.join(chosen, 'Studio files'), 'only the STUDIO folder is trusted — the drop folder (the originals) never is');
    A.ok(!blessed.some(p => /Drop designs here/.test(p)), 'the drop folder was never offered for trust');
    r = await call(S.setup, { body: { folder: chosen } });
    A.eq(r.status, 200, 'running setup again on the same folder is harmless');
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  A.report('art-gallery-routes.test.js');
})().catch(e => { console.error(e); process.exit(1); });
