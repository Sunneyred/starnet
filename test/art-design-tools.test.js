/* node test/art-design-tools.test.js — the art line's record tools, in the order the line uses them
   (Art Studio Phases 2-3): design_get, product_plan_submit, art_prepare with a design, design_review.
   Real temp workspace, real design store, real image library. Verifies that what each tool SAYS is what the record
   then HOLDS; that a bad plan is refused whole with every problem listed; that print files can only be made for
   planned products; that a too-small product is recorded as skipped with its reason; and that the review loop is
   capped at two redo rounds and says so. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const C = require('@napi-rs/canvas');
const { makeArtTools } = require('../sidecar/tools/builtin/art.js');
const { makeDesignStore } = require('../sidecar/art/design-store.js');
const { CAP_REGISTRY } = require('../sidecar/capability/registry.js');

const ROOT = path.join(os.tmpdir(), 'starnet-art-design-tools-test-' + process.pid);
const WS = path.join(ROOT, 'agent');
let clock = 5000, n = 0;
const ctx = { agentId: 'agent', runId: 'run-42', model: 'test-model', emit() {} };
async function refuses(fn, re, msg) {
  try { await fn(); A.ok(false, msg + ' — it did not refuse'); }
  catch (e) { A.ok(re.test(String(e && e.message)), msg + ' — got: ' + String(e && e.message).slice(0, 260)); return e; }
}
const PLAN = designId => ({ design: designId,
  analysis: { summary: 'A magenta block with a near-black square on a white page, bold and graphic.', subjects: ['abstract block'], mood: 'bold', palette: ['magenta', 'black'], textInArt: '' },
  products: [{ productId: 'tee-front', fabricId: 'black', score: 88, why: 'A bold flat shape reads clearly on a shirt front.' },
    { productId: 'poster-18x24', score: 60, why: 'Works full-bleed but the source is small for this size.' }],
  skipped: [{ productId: 'dad-hat-front', reason: 'Too wide and short an area for this composition.' }] });

(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const store = makeDesignStore({ fs, path, workspaces: ROOT, now: () => ++clock, newId: () => 'cd' + String(++n).padStart(6, '0') });
  const T = makeArtTools({ fsp, pathMod: path, root: ROOT, designStore: store });

  /* ---- wiring ---- */
  A.eq(T.tools.map(t => t.name), ['product_catalog', 'art_inspect', 'art_prepare', 'mockup_render', 'design_get', 'product_plan_submit', 'design_review'], 'with a design store, seven tools are offered');
  A.eq(makeArtTools({ fsp, pathMod: path, root: ROOT }).tools.length, 4, 'without one, only the four that need no record');
  for (const t of [T.designGetTool, T.planTool, T.reviewTool]) {
    const g = CAP_REGISTRY.studio.find(x => x.tool === t.name);
    A.ok(g, t.name + ' is granted by the STUDIO object');
    A.eq([t.capability, t.scope, t.requiresConsent, g.scope, g.requiresConsent, g.network], ['studio', g.scope, false, t.scope, false, false], t.name + ': tool and grant agree; record-only writes are not consent-gated and never touch the network');
  }

  /* ---- a dropped design (what intake leaves behind): 3000x2000, artwork 2400x1600 on white ---- */
  const design = C.createCanvas(3000, 2000); { const g = design.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 3000, 2000); g.fillStyle = '#ff00aa'; g.fillRect(300, 200, 2400, 1600); g.fillStyle = '#0b0b0b'; g.fillRect(600, 500, 600, 600); }
  const bytes = design.toBuffer('image/png');
  let rec = await store.create({ originalName: 'Block.png', droppedPath: '/drops/Block.png', projectRoot: WS, storedRel: 'designs/pending/original.png', sha256: 'a'.repeat(64), bytes: bytes.length, width: 3000, height: 2000,
    lineId: 'L1', facts: { background: { kind: 'flat', color: '#ffffff' }, bbox: { x: 300, y: 200, width: 2400, height: 1600 }, coverage: 0.64, dominantColors: [{ hex: '#ff00aa', share: 0.9 }] } });
  const rel = 'designs/' + rec.id + '/original.png';
  await store._internals.setStoredRel(rec.id, rel);
  await fsp.mkdir(path.join(WS, 'designs', rec.id), { recursive: true });
  await fsp.writeFile(path.join(WS, rel), bytes);
  const ID = rec.id;

  /* ---- design_get before anything ---- */
  let g = await T.designGetTool.run({ design: ID }, ctx);
  A.ok(new RegExp('Design ' + ID + ' — status: new').test(g.content) && /Plan: none submitted yet\./.test(g.content) && /Print files: none yet\./.test(g.content), 'design_get reports a fresh design truthfully');
  A.ok(/Measured: background flat #ffffff; artwork 2400x1600 px covering 64%/.test(g.content), 'with the measurements taken at intake');
  await refuses(() => T.designGetTool.run({ design: 'dsn_nope0000' }, ctx), /no design dsn_nope0000 on record/, 'design_get: an unknown id is refused');
  await refuses(() => T.designGetTool.run({ design: 'Block.png' }, ctx), /is not a design id/, 'design_get: something that is not an id is refused, with what an id looks like');
  await refuses(() => T.designGetTool.run({}, ctx), /design is required/, 'design_get: the id is required');

  /* ---- no print file before a plan ---- */
  await refuses(() => T.prepareTool.run({ design: ID, product: 'tee-front', fabric: 'black' }, ctx), /has no product plan yet — a plan must be submitted/, 'art_prepare with a design refuses before a plan exists');
  A.ok(!fs.existsSync(path.join(WS, 'designs', ID, 'print')), 'and wrote nothing');

  /* ---- product_plan_submit: refused whole, every problem named ---- */
  const bad = PLAN(ID); bad.products[0].productId = 'mug'; bad.products[1].score = 140; delete bad.analysis.subjects;
  const e = await refuses(() => T.planTool.run(bad, ctx), /the plan was NOT recorded\. Fix these and submit again:/, 'a bad plan is refused');
  A.ok(e && /unknown product "mug"/.test(e.message) && /score must be a whole number/.test(e.message) && /subjects must list/.test(e.message), 'and all three problems are listed at once');
  A.eq(store.get(ID).plan, null, 'nothing of it was recorded');

  const p = await T.planTool.run(PLAN(ID), ctx);
  A.ok(new RegExp('Plan recorded on design ' + ID + ' \\(status: planned\\): tee-front/black 88, poster-18x24 60\\.').test(p.content), 'the result states what was recorded: ' + p.content.split('\n')[0]);
  A.ok(/Skipped: dad-hat-front\./.test(p.content) && /print specs of poster-18x24 are unverified/.test(p.content) && /fit judgements, not sales data/.test(p.content), 'and flags skipped products, unverified specs, and that scores are not sales data');
  rec = store.get(ID);
  A.eq([rec.status, rec.plan.basis, rec.plan.agentId, rec.plan.model, rec.plan.products.map(x => x.productId), rec.runIds],
    ['planned', 'fit-judgement', 'agent', 'test-model', ['tee-front', 'poster-18x24'], ['run-42']], 'the record holds exactly that, with who planned it and the run noted');

  /* ---- art_prepare with a design ---- */
  await refuses(() => T.prepareTool.run({ design: ID, product: 'sticker-4x4' }, ctx), /sticker-4x4 is not in design .* plan \(tee-front, poster-18x24\)/, 'a product outside the plan is refused');
  const r = await T.prepareTool.run({ design: ID, product: 'tee-front', fabric: 'black' }, ctx);
  A.eq(r.summary, 'print file → designs/' + ID + '/print/tee-front-black.png', 'the print file goes beside the design, with no path given (the recorded file was used)');
  A.ok(new RegExp('Recorded on design ' + ID + '\\.').test(r.content), 'the result says it was recorded');
  A.ok(fs.existsSync(path.join(WS, 'designs', ID, 'print', 'tee-front-black.png')), 'the file is on disk');
  A.ok(fs.readFileSync(path.join(WS, rel)).equals(bytes), 'the design\'s own copy is unchanged');
  rec = store.get(ID);
  A.eq([rec.status, rec.variants.length, rec.variants[0].path, rec.variants[0].width, rec.variants[0].effectiveDpi, rec.variants[0].verifiedSpec],
    ['adapting', 1, 'designs/' + ID + '/print/tee-front-black.png', 3600, 200, true], 'the record holds the print file with its measured facts');

  // the poster is too small: refused with numbers AND recorded as skipped; a smaller fill then works and clears the skip
  const small = await refuses(() => T.prepareTool.run({ design: ID, product: 'poster-18x24' }, ctx), /would print at .* dpi, below the minimum 150 dpi.*No file was written\..*Recorded on design .* as skipped for now/, 'a too-small product is refused, and the refusal says it was recorded');
  rec = store.get(ID);
  A.eq(rec.plan.skipped.filter(k => k.by === 'designer').map(k => k.productId), ['poster-18x24'], 'the record holds the skip');
  A.ok(/dpi/.test(rec.plan.skipped.find(k => k.by === 'designer').reason), 'with the measured reason');
  const pct = Number((/fill up to (\d+)%/.exec(small.message) || [])[1]) / 100;
  A.ok(pct > 0 && pct < 1, 'the refusal offers a fill that would work (' + pct + ')');
  await T.prepareTool.run({ design: ID, product: 'poster-18x24', fill: pct, mode: 'contain' }, ctx);
  rec = store.get(ID);
  A.eq([rec.variants.length, rec.plan.skipped.filter(k => k.by === 'designer').length], [2, 0], 'made at that fill: recorded, and the skip is cleared');

  /* ---- design_review: verdicts, notes, and the cap ---- */
  await refuses(() => T.reviewTool.run({ design: ID, product: 'tee-front', verdict: 'redo', notes: 'bad' }, ctx), /a "redo" needs notes that tell the Designer exactly what to change/, 'a redo without usable notes is refused');
  await refuses(() => T.reviewTool.run({ design: ID, product: 'tee-front', verdict: 'fine' }, ctx), /verdict must be "pass" or "redo"/, 'an unknown verdict is refused');
  await refuses(() => T.reviewTool.run({ design: ID, product: 'sticker-4x4', verdict: 'pass' }, ctx), /review was NOT recorded: .*no print file for "sticker-4x4"/, 'a review of a file that does not exist is refused');
  let v = await T.reviewTool.run({ design: ID, product: 'tee-front', verdict: 'redo', notes: 'The near-black square vanishes on black fabric; use recolor separate.' }, ctx);
  A.ok(/tee-front — REDO \(redo round 1 of 2\)/.test(v.content) && /Still to review or waiting on a redo: tee-front, poster-18x24\./.test(v.content), 'redo round 1 is reported, with what is still outstanding');
  await T.prepareTool.run({ design: ID, product: 'tee-front', fabric: 'black', recolor: 'separate' }, ctx);
  A.eq([store.get(ID).variants.find(x => x.productId === 'tee-front').review, store.get(ID).variants.find(x => x.productId === 'tee-front').reviewRounds], [null, 1], 'the remade file has no verdict yet but keeps its round count');
  v = await T.reviewTool.run({ design: ID, product: 'tee-front', verdict: 'redo', notes: 'Still too close to the fabric; try the white fabric instead.' }, ctx);
  A.ok(/redo round 2 of 2/.test(v.content), 'redo round 2');
  await T.prepareTool.run({ design: ID, product: 'tee-front', fabric: 'black', recolor: 'outline' }, ctx);
  v = await T.reviewTool.run({ design: ID, product: 'tee-front', verdict: 'redo', notes: 'I would still like another pass at this one please.' }, ctx);
  A.ok(/tee-front — NEEDS-OWNER\. The redo limit \(2 rounds\) was already used, so this print file is NOT being sent back again/.test(v.content), 'a third redo is capped and the tool says so plainly: ' + v.content.split('\n')[0].slice(0, 160));
  A.eq(v.data.verdict, 'needs-owner', 'the recorded verdict is needs-owner');
  v = await T.reviewTool.run({ design: ID, product: 'poster-18x24', verdict: 'pass' }, ctx);
  A.ok(/poster-18x24 — PASS\./.test(v.content) && /Every print file has a final verdict\./.test(v.content), 'a pass is recorded; nothing is outstanding');
  A.eq(store.get(ID).status, 'mocking', 'the design has moved on to mockups');

  /* ---- design_get now tells the whole story ---- */
  g = await T.designGetTool.run({ design: ID }, ctx);
  A.ok(/status: mocking/.test(g.content) && /Plan \(fit judgement, ranked\):/.test(g.content) && /88 {2}tee-front\/front on black/.test(g.content), 'design_get shows the plan as a fit judgement');
  A.ok(/poster-18x24\/full \[unverified spec\]/.test(g.content), 'and flags the unverified spec');
  A.ok(/tee-front on black -> .* review: needs-owner .*\[redo rounds used: 2\]/.test(g.content) && /poster-18x24 -> .* review: pass/.test(g.content), 'and each print file with its verdict and rounds used');
  A.ok(/skipped dad-hat-front \(strategist\)/.test(g.content), 'and what the Strategist ruled out');

  /* ---- a station with no design store: the id cannot be used, and says so ---- */
  const bare = makeArtTools({ fsp, pathMod: path, root: ROOT });
  await refuses(() => bare.prepareTool.run({ design: ID, product: 'cover-art', path: rel }, ctx), /keeps no design records/, 'art_prepare with a design id but no store refuses instead of quietly not recording');

  fs.rmSync(ROOT, { recursive: true, force: true });
  A.report('art-design-tools.test');
})().catch(e => { console.error(e); process.exit(1); });
