/* node test/art-design-store.test.js — the design record is a ledger that cannot lie (Art Studio Phase 2a).
   Real temp dir, injected clock and ids. Verifies: durable round-trip (a fresh store instance reads what the last
   one wrote), sha dedupe, forward-only status, every precondition (no variant without a plan, no mockup without a
   print file, no "ready" with work outstanding), the redo cap, owner approvals, visible failure, and that
   concurrent writers never lose an update. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeDesignStore, DesignError, MAX_REVIEW_ROUNDS } = require('../sidecar/art/design-store.js');

const DIR = path.join(os.tmpdir(), 'starnet-art-designs-test-' + process.pid);
fs.rmSync(DIR, { recursive: true, force: true }); fs.mkdirSync(DIR, { recursive: true });
let clock = 1000, n = 0;
const mk = () => makeDesignStore({ fs, path, workspaces: DIR, now: () => ++clock, newId: () => 'ab' + String(++n).padStart(6, '0') });
const sha = c => c.repeat(64);
const src = (c, over) => Object.assign({ originalName: 'Neon ' + c + '.png', droppedPath: '/drops/' + c + '.png', projectRoot: '/proj', storedRel: 'designs/x/original.png',
  sha256: sha(c), bytes: 1234, width: 3000, height: 2000, lineId: 'L1', triggerId: 'trg_1', facts: { background: { kind: 'flat', color: '#ffffff' } } }, over || {});
async function refuses(fn, code, msg) {
  try { await fn(); A.ok(false, msg + ' — it did not refuse'); }
  catch (e) { A.ok(e instanceof DesignError && e.code === code, msg + ' — got ' + (e && (e.code || e.message))); return e; }
}
const PLAN = { basis: 'fit-judgement', products: [{ productId: 'tee-front', placementId: 'front', fabricId: 'black', score: 90, why: 'bold shape reads on a shirt', titleIdeas: [], verifiedSpec: true },
  { productId: 'poster-18x24', placementId: 'full', fabricId: null, score: 80, why: 'full collage reads at poster size', titleIdeas: [], verifiedSpec: false }], skipped: [] };
const VAR = (productId, fabricId, over) => Object.assign({ productId, placementId: productId === 'tee-front' ? 'front' : 'full', fabricId, path: 'designs/d/print/' + productId + '.png',
  width: 3600, height: 4800, effectiveDpi: 200, requiredDpi: 150, upscaled: true, verifiedSpec: true, steps: ['trimmed'], lowContrastShare: 0.1 }, over || {});

(async () => {
  A.throws(() => makeDesignStore({ fs, path, workspaces: DIR }), 'the store refuses to exist without an injected clock and id source');
  const S = mk();

  /* ---- create + dedupe + durability ---- */
  const d = await S.create(src('a'));
  A.ok(/^dsn_[a-z0-9]{6,40}$/.test(d.id), 'a design gets a dsn_ id (' + d.id + ')');
  A.eq([d.status, d.plan, d.variants, d.mockups, d.rightsConfirmed, d.spendUsd], ['new', null, [], [], false, 0], 'a new record starts empty and unapproved');
  A.eq(d.history.map(h => h.event), ['dropped'], 'its history starts with the drop');
  const dupErr = await refuses(() => S.create(src('a', { originalName: 'copy.png' })), 'DESIGN_DUPLICATE', 'the same bytes are refused a second record');
  A.eq(dupErr && dupErr.existingId, d.id, 'and the refusal names the existing design');
  await refuses(() => S.create(src('b', { sha256: 'nope' })), 'DESIGN_BAD_SOURCE', 'a record needs a real sha256');
  await refuses(() => S.create(src('b', { width: 0 })), 'DESIGN_BAD_SOURCE', 'a record needs its pixel size');
  A.eq(S.findBySha(sha('a')).id, d.id, 'findBySha finds it');
  A.eq(mk().get(d.id).source.originalName, 'Neon a.png', 'a FRESH store instance reads it back from disk');
  A.ok(fs.existsSync(path.join(DIR, 'art-designs.json')), 'the record file is art-designs.json in the workspaces root');
  const got = S.get(d.id); got.status = 'ready'; A.eq(S.get(d.id).status, 'new', 'a caller cannot change the record through a returned copy');
  A.eq(S.get('dsn_missing0'), null, 'an unknown id is null');

  /* ---- preconditions before a plan ---- */
  await refuses(() => S.addVariant(d.id, VAR('tee-front', 'black')), 'DESIGN_NOT_PLANNED', 'no print file before a plan');
  await refuses(() => S.setPlan(d.id, null, { products: [] }), 'DESIGN_BAD_PLAN', 'an empty plan is refused');
  await refuses(() => S.setPlan('dsn_missing0', null, PLAN), 'DESIGN_NOT_FOUND', 'a plan for an unknown design is refused');

  /* ---- plan -> variants ---- */
  let r = await S.setPlan(d.id, { summary: 'a neon statue' }, PLAN, { agentId: 'strat', model: 'm1' });
  A.eq([r.status, r.plan.agentId, r.plan.basis, r.analysis.summary], ['planned', 'strat', 'fit-judgement', 'a neon statue'], 'the plan is recorded with who made it, as a fit judgement');
  r = await S.setPlan(d.id, null, Object.assign({}, PLAN, { products: PLAN.products.slice(0, 2) }), {});
  A.eq(r.status, 'planned', 'a plan may be replaced before any print file exists');
  await refuses(() => S.addVariant(d.id, VAR('sticker-4x4', null)), 'DESIGN_NOT_IN_PLAN', 'a print file for an unplanned product is refused');
  await refuses(() => S.addVariant(d.id, VAR('tee-front', 'black', { path: '' })), 'DESIGN_BAD_VARIANT', 'a print file row needs the path that was written');
  r = await S.addVariant(d.id, VAR('tee-front', 'black'));
  A.eq([r.status, r.variants.length, r.variants[0].review, r.variants[0].effectiveDpi], ['adapting', 1, null, 200], 'the first print file moves the design to adapting');
  await refuses(() => S.setPlan(d.id, null, PLAN, {}), 'DESIGN_PLAN_LOCKED', 'the plan is locked once a print file exists');
  r = await S.skipProduct(d.id, 'poster-18x24', 'would print at 60 dpi');
  A.eq(r.plan.skipped.map(k => [k.productId, k.by]), [['poster-18x24', 'designer']], 'a product that could not be made is recorded as skipped, by whom');
  r = await S.addVariant(d.id, VAR('poster-18x24', null, { verifiedSpec: false }));
  A.eq([r.variants.length, r.plan.skipped.length], [2, 0], 'making it after all clears the skip');

  /* ---- review, with the redo cap ---- */
  await refuses(() => S.setReview(d.id, { productId: 'sticker-4x4' }, { verdict: 'pass' }), 'DESIGN_NO_VARIANT', 'a review of a file that does not exist is refused');
  await refuses(() => S.setReview(d.id, { productId: 'tee-front' }, { verdict: 'needs-owner' }), 'DESIGN_BAD_REVIEW', 'an agent cannot set needs-owner itself');
  r = await S.setReview(d.id, { productId: 'tee-front' }, { verdict: 'redo', notes: 'subject cropped at the top' });
  A.eq([r.status, r.variants[0].review.verdict, r.variants[0].reviewRounds], ['reviewing', 'redo', 1], 'redo round 1 is recorded');
  await refuses(() => S.markReady(d.id), 'DESIGN_NOT_READY', 'not ready while a redo is outstanding');
  r = await S.addVariant(d.id, VAR('tee-front', 'black', { path: 'designs/d/print/tee-v2.png' }));
  A.eq([r.variants.length, r.variants[0].path, r.variants[0].review, r.variants[0].reviewRounds], [2, 'designs/d/print/tee-v2.png', null, 1], 'a remade file replaces its row, clears the old verdict and KEEPS the round count');
  r = await S.setReview(d.id, { productId: 'tee-front' }, { verdict: 'redo', notes: 'still cropped' });
  A.eq(r.variants[0].reviewRounds, 2, 'redo round 2');
  A.eq(MAX_REVIEW_ROUNDS, 2, 'the cap is two rounds');
  r = await S.addVariant(d.id, VAR('tee-front', 'black', { path: 'designs/d/print/tee-v3.png' }));
  r = await S.setReview(d.id, { productId: 'tee-front' }, { verdict: 'redo', notes: 'no' });
  A.eq([r.variants[0].review.verdict, r.variants[0].review.cappedFrom, r.variants[0].reviewRounds], ['needs-owner', 'redo', 2], 'a third redo is capped: the file goes to the owner, the count does not grow');
  A.eq(r.status, 'reviewing', 'still reviewing: the poster has no verdict yet');
  r = await S.setReview(d.id, { productId: 'poster-18x24' }, { verdict: 'pass' });
  A.eq(r.status, 'mocking', 'once every file has a final verdict the design moves on to mockups');

  /* ---- mockups -> ready ---- */
  await refuses(() => S.addMockup(d.id, { productId: 'sticker-4x4', path: 'm.png' }), 'DESIGN_NO_VARIANT', 'no mockup without a print file');
  await refuses(() => S.addMockup(d.id, { productId: 'tee-front', fabricId: 'black', path: '' }), 'DESIGN_BAD_MOCKUP', 'a mockup row needs the path that was written');
  r = await S.addMockup(d.id, { productId: 'tee-front', fabricId: 'black', templateId: 'tee-flat', path: 'designs/d/mockups/tee.png', width: 2000, height: 2000 });
  const e = await refuses(() => S.markReady(d.id), 'DESIGN_NOT_READY', 'not ready while a print file has no mockup');
  A.ok(e && /poster-18x24/.test(e.message), 'and it names the product still missing one');
  r = await S.addMockup(d.id, { productId: 'poster-18x24', templateId: 'poster-wall', path: 'designs/d/mockups/poster.png', width: 2000, height: 2000 });
  r = await S.markReady(d.id);
  A.eq(r.status, 'ready', 'with every print file mocked up, the design is ready');
  r = await S.addVariant(d.id, VAR('poster-18x24', null, { path: 'designs/d/print/poster-v2.png' }));
  A.eq([r.status, r.mockups.map(m => m.productId)], ['ready', ['tee-front']], 'remaking a print file drops ITS stale mockup; the status never moves backwards');

  /* ---- the owner ---- */
  await refuses(() => S.setApproval(d.id, 'tee-front', 'maybe'), 'DESIGN_BAD_APPROVAL', 'an approval must be approved, rejected or redo');
  await refuses(() => S.setApproval(d.id, 'sticker-4x4', 'approved'), 'DESIGN_NO_VARIANT', 'an approval needs a print file');
  r = await S.setApproval(d.id, 'tee-front', 'approved');
  A.eq(r.status, 'ready', 'one of two decided: still ready');
  r = await S.setApproval(d.id, 'poster-18x24', 'rejected', 'too busy');
  A.eq([r.status, r.approvals['poster-18x24'].note], ['approved', 'too busy'], 'all decided with at least one approved: approved');
  r = await S.setApproval(d.id, 'poster-18x24', 'redo', 'try a smaller fill');
  A.eq(r.status, 'ready', 'a redo reopens it');
  r = await S.setRights(d.id, true);
  A.eq(r.rightsConfirmed, true, 'the owner\'s rights confirmation is recorded');
  A.ok(r.history.some(h => h.event === 'rights') && r.history.some(h => h.event === 'owner-redo'), 'owner actions are in the history');

  /* ---- runs, spend, failure ---- */
  r = await S.addRun(d.id, 'run-1', 0.0123); r = await S.addRun(d.id, 'run-1', 0.01); r = await S.addRun(d.id, 'run-2', 0);
  A.eq([r.runIds, r.spendUsd], [['run-1', 'run-2'], 0.0223], 'runs are noted once each and spend adds up');
  const d2 = await S.create(src('c'));
  r = await S.recordError(d2.id, 'designer', 'tee refused');
  A.eq([r.status, r.errors.length], ['new', 1], 'a recorded problem does not fail the design');
  r = await S.fail(d2.id, 'strategist', 'the model refused the image');
  A.eq([r.status, r.errors[1].stage], ['failed', 'strategist'], 'a failed stage marks the design failed, with the reason');
  await refuses(() => S.setPlan(d2.id, null, PLAN, {}), 'DESIGN_FAILED', 'a failed design takes no plan');
  A.ok(S.get(d2.id), 'a failed design is still on record — it never disappears');

  /* ---- list ---- */
  A.eq(S.list().map(x => x.id), [d2.id, d.id], 'list is newest first');
  A.eq(S.list({ status: 'failed' }).map(x => x.id), [d2.id], 'list filters by status');
  A.eq(S.list({ lineId: 'nope' }).length, 0, 'list filters by line');

  /* ---- concurrency: 25 writers, nothing lost ---- */
  const d3 = await S.create(src('d'));
  await Promise.all(Array.from({ length: 25 }, (_, i) => S.addRun(d3.id, 'run-' + i, 0.01)));
  const after = mk().get(d3.id);
  A.eq([after.runIds.length, after.spendUsd], [25, 0.25], '25 concurrent writers: every update is in the record on disk');

  fs.rmSync(DIR, { recursive: true, force: true });
  A.report('art-design-store.test');
})().catch(e => { console.error(e); process.exit(1); });
