/* node test/gallery.test.js — the GALLERY's readings (frontend/app/gallery.js, Art Studio Phase 5).
   Real WorldModel + the Build Library's own placement on a brand-new station. Holds the page to the truthful-telemetry
   law: a setup step is done only on a fact; a design's state is its record's status; spend is said only when it came
   from real runs; a fit score is never called a forecast; every word from a file name or an agent is escaped. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const WM = require('../frontend/app/worldmodel.js');
const P = require('../frontend/app/pipeline.js');
const LE = require('../frontend/app/lineedit.js');
const W = require('../frontend/app/workflowline.js');
const G = require('../frontend/app/gallery.js');
const Places = require('../frontend/app/places.js');

/* ---- the line, on the floor a new owner really has ---- */
const st = WM.create(WM.starterDoc());
A.eq(G.artLines(st, P), [], 'a new station has no art line');
A.eq(G.artLines(null, P), [], 'no station: no lines, no throw');
let steps = G.setupSteps({ line: null, triggers: [], grants: { artWrite: false } });
A.eq(steps.map(s => [s.id, s.done, !!s.blocked]), [['line', false, false], ['crew', false, true], ['folders', false, true], ['grant', false, true], ['trigger', false, true]], 'with no line, only the first step is open; nothing is done');
A.eq(steps[0].act.id, 'place', 'and it offers to place the line');

const briefs = {}; for (const r of G.ART_ROLES) briefs[r] = W.defaultBrief(r);
const b = st.bounds();
const placed = LE.placeBlueprint(st, 'art_line', { x: (b.minTx + b.maxTx) >> 1, y: (b.minTy + b.maxTy) >> 1 }, { stamp: { briefs } });
A.ok(placed.ok, 'the art line fits on a brand-new station\'s floor (what PLACE THE ART LINE does): ' + JSON.stringify(placed).slice(0, 200));
let line = G.artLines(st, P)[0];
A.ok(line && line.name === 'ART DROP' && line.steps.map(s => s.role).join() === G.ART_ROLES.join(), 'it is found by its four roles');
A.eq(line.limits, { maxHops: 8, maxUsdPerMessage: 2, maxUsdPerDay: 5 }, 'carrying its budget');
A.ok(line.steps.every(s => s.hasBrief && !s.agentId) && !line.crewed && !line.canWork, 'every step has its instructions; none has an agent yet');
steps = G.setupSteps({ line, triggers: [], grants: { artWrite: false } });
A.eq([steps[0].done, steps[1].done, steps[1].act.id], [true, false, 'crew'], 'next: give every step an agent');

for (const id of placed.ids) { const p = st.propById(id); if (p.t === 'bay') A.ok(st.assignPropAgent(id, 'agent').ok, 'one agent takes ' + p.role); }
line = G.artLines(st, P)[0];
A.ok(line.crewed && line.canWork && line.steps.every(s => s.hasCompute && s.hasStudio), 'in the starter room one agent has a desk and the STUDIO: every step can work');
const plan = P.compileRoutingPlan(st.projectGeometry());
A.eq(plan.errors, [], 'the laid, crewed line compiles clean');
const gate = Object.values(plan.gateDocks)[0];
A.eq(st.propById(gate.backTo).role, 'DESIGNER', 'laid out by the engine, the gate still sends work back to the DESIGNER');
A.eq(Object.keys(plan.dockChains).map(k => st.propById(k).role + '>' + plan.dockChains[k].next.map(n => st.propById(n).role).join()), ['STRATEGIST>DESIGNER', 'DESIGNER>INSPECTOR', 'INSPECTOR>MOCKUP', 'MOCKUP>'], 'and runs in order');

// no STUDIO in the agent's room: the page must say the steps cannot make a file — never show the line as ready
{
  const s2 = WM.create(WM.starterDoc());
  const studio = s2.props().find(p => p.t === 'studio'); A.ok(s2.removeProp(studio.id).ok, 'fixture: the STUDIO is removed');
  const r2 = LE.placeBlueprint(s2, 'art_line', null, { stamp: { briefs } });
  for (const id of r2.ids) { const p = s2.propById(id); if (p.t === 'bay') s2.assignPropAgent(id, 'agent'); }
  const l2 = G.artLines(s2, P)[0];
  A.ok(l2.crewed && !l2.canWork && l2.steps.every(s => s.hasCompute && !s.hasStudio), 'crewed, but no step has a STUDIO');
  const c = G.setupSteps({ line: l2, triggers: [], grants: { artWrite: true }, agentName: () => 'NOVA' }).find(s => s.id === 'crew');
  A.ok(!c.done && /STUDIO/.test(c.title) && /NOVA/.test(c.detail) && /could not make a single file/.test(c.detail) && c.act.id === 'build', 'the step says so, names the agent, and points at Build Mode');
}

/* ---- folders, grant, trigger: each done only on the server's word ---- */
const T = (o) => Object.assign({ id: 'trg_1', kind: 'folder', lineId: line.lineId, enabled: true, blockedBy: null, config: { path: '/home/me/Art/Drop designs here', intake: 'design' } }, o || {});
const withRoot = Object.assign({}, line, { projectRoot: '/home/me/Art/Studio files' });
const by = (ss, id) => ss.find(s => s.id === id);
steps = G.setupSteps({ line, triggers: [], grants: { artWrite: false } });
A.ok(!by(steps, 'folders').done && by(steps, 'folders').act.id === 'folders' && /never changed/.test(by(steps, 'folders').detail), 'no folder yet: it explains the two folders and that originals are never changed');
steps = G.setupSteps({ line: withRoot, triggers: null, grants: null });
A.ok(!by(steps, 'folders').done && by(steps, 'folders').blocked && !by(steps, 'grant').done && by(steps, 'grant').blocked, 'facts not read yet: nothing is claimed either way');
steps = G.setupSteps({ line: withRoot, triggers: [], grants: { artWrite: false } });
A.ok(!by(steps, 'folders').done && /nothing is watching/.test(by(steps, 'folders').detail), 'a working folder with no drop trigger is NOT done');
steps = G.setupSteps({ line: withRoot, triggers: [T({ lineId: 'other' }), T({ config: { path: '/x' } })], grants: { artWrite: false } });
A.ok(!by(steps, 'folders').done, 'another line\'s trigger, or a plain folder trigger, does not count as the art drop');
steps = G.setupSteps({ line: withRoot, triggers: [T()], grants: { artWrite: false } });
A.ok(by(steps, 'folders').done && by(steps, 'folders').detail.indexOf('/home/me/Art/Drop designs here') >= 0 && by(steps, 'folders').detail.indexOf('/home/me/Art/Studio files') >= 0, 'done: it names both folders');
A.ok(!by(steps, 'grant').done && by(steps, 'grant').act.id === 'grant' && /ONE thing/.test(by(steps, 'grant').detail) && /no posting, no listing/.test(by(steps, 'grant').detail), 'the grant step says exactly what is allowed and what is not');
A.ok(!G.setupReady(steps), 'not ready without the grant');
steps = G.setupSteps({ line: withRoot, triggers: [T()], grants: { artWrite: true } });
A.ok(G.setupReady(steps) && /\$5\.00 a day, \$2\.00 a design/.test(by(steps, 'trigger').detail), 'all five done: ready, and the budget is stated');
A.eq(by(steps, 'trigger').act.id, 'disable', 'a running drop folder can be paused');
steps = G.setupSteps({ line: withRoot, triggers: [T({ enabled: false })], grants: { artWrite: true } });
A.ok(!by(steps, 'trigger').done && by(steps, 'trigger').act.id === 'enable' && !G.setupReady(steps), 'a switched-off drop folder is not ready');
steps = G.setupSteps({ line: withRoot, triggers: [T({ blockedBy: 'the line has no agent on its first step' })], grants: { artWrite: true } });
A.ok(!by(steps, 'trigger').done && /the line has no agent on its first step/.test(by(steps, 'trigger').detail), 'a blocked drop folder shows the station\'s own reason');
A.ok(/NO spending limit/.test(G.budgetWord(null)), 'a line with no budget of its own is said to have none');
A.eq(G.triggerOf({ line: withRoot, triggers: [T({ lineId: 'x' }), T({ id: 'trg_2' })] }).id, 'trg_2', 'triggerOf finds this line\'s art drop');

/* ---- one design ---- */
const products = [{ id: 'tee-front', label: 'T-shirt (front)', verified: true }, { id: 'sticker-4x4', label: 'Sticker 4×4', verified: false }];
const rec = { id: 'dsn_abc123', status: 'ready', spendUsd: 0.31, spendFromRuns: true, runCount: 6, rightsConfirmed: false,
  source: { originalName: '<img src=x onerror=alert(1)>.png', storedRel: 'designs/dsn_abc123/original.png', previewRel: 'designs/dsn_abc123/preview.jpg', width: 3000, height: 3000 },
  analysis: { summary: 'A neon angel <b>statue</b>.' },
  plan: { basis: 'fit-judgement', products: [{ productId: 'tee-front', fabricId: 'black', score: 88, why: 'Reads "boldly" on a shirt.' }, { productId: 'sticker-4x4', score: 70, why: 'Die-cuts cleanly.' }, { productId: 'poster-18x24', score: 40, why: 'Maybe.' }],
    skipped: [{ productId: 'dad-hat-front', by: 'strategist', reason: 'too tall' }, { productId: 'poster-18x24', by: 'designer', reason: 'too small to print' }] },
  variants: [{ productId: 'tee-front', fabricId: 'black', path: 'designs/dsn_abc123/print/tee-front-black.png', previewPath: 'designs/dsn_abc123/print/tee-front-black.preview.jpg', width: 4500, height: 5400, effectiveDpi: 300, upscaled: true, review: { verdict: 'needs-owner', notes: 'still dark' }, steps: [] },
    { productId: 'sticker-4x4', fabricId: null, path: 'designs/dsn_abc123/print/sticker-4x4.png', previewPath: null, width: 1200, height: 1200, effectiveDpi: 300, review: { verdict: 'pass' }, steps: [] }],
  mockups: [{ productId: 'tee-front', fabricId: 'black', templateId: 'tee-flat', path: 'designs/dsn_abc123/mockups/tee.png' }],
  approvals: { 'tee-front': { decision: 'approved', note: '' } }, errors: [{ stage: 'intake', message: 'no <preview>' }] };
let v = G.designView(rec, products);
A.eq([v.status.word, v.thumb, v.products.length, v.approvedCount, v.canExport, v.exportWhy], ['READY FOR YOU', 'designs/dsn_abc123/preview.jpg', 3, 1, false, 'Tick the rights box first.'], 'the card reads the record: ready, one approved, export waits for the rights box');
A.eq(v.spendWord, '$0.31 spent on this design (6 runs)', 'spend from real runs is stated');
A.eq(G.designView(Object.assign({}, rec, { spendFromRuns: false }), products).spendWord, 'spend not known yet', 'spend NOT from runs is never shown as a number');
A.eq(G.designView(Object.assign({}, rec, { spendFromRuns: false, runCount: 0 }), products).spendWord, 'no run has worked on this yet', 'no runs: says so');
const tee = v.products[0], sticker = v.products[1], poster = v.products[2];
A.ok(tee.print.preview && tee.print.upscaled && tee.print.needsOwner && /not satisfied after 2 redos/.test(tee.print.review) && tee.decision === 'approved' && !tee.unverified, 'tee: its preview, enlarged, checker unsatisfied, approved by the owner');
A.ok(sticker.unverified && sticker.print.review === 'checked: passed' && sticker.mockups.length === 0 && sticker.canDecide, 'sticker: unverified size is flagged; passed; no mockup recorded');
A.ok(!poster.print && !poster.canDecide, 'a planned product with no print file cannot be decided on');
A.eq(v.skipped.map(k => k.by), ['ruled out', 'could not be made'], 'skipped products say who dropped them');
A.eq(G.designView(Object.assign({}, rec, { rightsConfirmed: true }), products).canExport, true, 'rights + an approval: export opens');
A.eq(G.designView(Object.assign({}, rec, { approvals: {}, rightsConfirmed: true }), products).exportWhy, 'Approve at least one product first.', 'nothing approved: says what is missing');
for (const k of ['new', 'planned', 'adapting', 'reviewing', 'mocking']) A.ok(!/ready|done|finished/i.test(G.STATUS[k][0] + G.STATUS[k][1].replace(/not all recorded/, '')), 'status "' + k + '" never reads as finished: ' + G.STATUS[k].join(' — '));
A.eq(G.designView({ id: 'dsn_x', status: 'weird', source: {} }, []).status.word, 'WEIRD', 'an unknown status is shown as it is, not mapped to a guess');

/* ---- a design that stopped part-way ---- */
{
  const stuck = G.designView(Object.assign({}, rec, { status: 'planned', variants: [], mockups: [], approvals: {} }), products);
  A.ok(stuck.stopped && !v.stopped, 'a design below READY is "stopped"; a ready one is not');
  const idle = G.designHtml(stuck, { lineBusy: false }), busy = G.designHtml(stuck, { lineBusy: true });
  A.ok(/CARRY ON WITH THIS DESIGN/.test(idle) && /inside its spending limit/.test(idle), 'when the line is idle it offers to carry on, and says it spends inside the limit');
  A.ok(!/CARRY ON WITH THIS DESIGN/.test(busy) && !/stopped before it was finished/.test(busy), 'while the line is working, a mid-way design is NOT called stopped');
  A.ok(!/CARRY ON/.test(G.designHtml(G.designView(Object.assign({}, rec, { status: 'failed' }), products), {})), 'a failed design is not offered a restart it cannot use');
  A.ok(!/CARRY ON/.test(G.pageHtml({ steps: [], designs: [Object.assign({}, rec, { status: 'adapting' })], products, trigger: { running: true } })), 'the page passes the trigger\'s "running" through');
  A.ok(/CARRY ON/.test(G.pageHtml({ steps: [], designs: [Object.assign({}, rec, { status: 'adapting' })], products, trigger: { running: false, queued: 0 } })), 'and its idle state');
}

/* ---- markup ---- */
const html = G.designHtml(v, { redo: 'sticker-4x4' });
A.ok(html.indexOf('<img src=x') < 0 && html.indexOf('&lt;img src=x onerror=alert(1)&gt;.png') >= 0, 'a file name is escaped');
A.ok(html.indexOf('<b>statue</b>') < 0 && html.indexOf('no <preview>') < 0 && html.indexOf('Reads &quot;boldly&quot;') >= 0, 'agent words and errors are escaped');
A.ok(/FIT 88\/100/.test(html) && /Not sales data/.test(html) && /It is not a sales forecast/.test(html), 'the score is labelled a fit judgement, twice, never a forecast');
A.ok(/SIZE NOT VERIFIED/.test(html) && (html.match(/SIZE NOT VERIFIED/g) || []).length === 1, 'only the unverified product carries the size warning');
A.ok(/data-act="approve"[^>]*data-product="tee-front"[^>]*aria-pressed="true"/.test(html.replace(/data-design="[^"]*" /g, '')) || /✓ APPROVED/.test(html), 'the approved product\'s key reads approved');
A.ok(/gal-note-dsn_abc123/.test(html) && /inside the line's spending limit/.test(html), 'the open send-back row asks what should change and says it runs inside the budget');
A.ok(/data-act="export"[^>]*disabled/.test(html) && /I made this, or I have the commercial rights/.test(html), 'export is disabled until the rights box is ticked');
A.ok((html.match(/class="gal-img/g) || []).length === 4, 'four pictures: the design, two print previews (one full file when no preview exists), one mockup');
A.ok(/data-path="designs\/dsn_abc123\/print\/sticker-4x4\.png"/.test(html), 'a print file with no preview falls back to the file itself');
const exported = G.designHtml(v, { exported: { folder: '/home/me/Art/Studio files/export/x', written: ['a', 'b', 'c'], problems: [] } });
A.ok(/Copied to \/home\/me\/Art\/Studio files\/export\/x \(3 files\)\. Nothing was published or uploaded\./.test(exported), 'after export it says where, how many, and that nothing was published');

const page = st2 => G.pageHtml(st2);
const ready = G.setupSteps({ line: withRoot, triggers: [T()], grants: { artWrite: true } });
let pg = page({ steps: ready, designs: [rec], products, trigger: T({ running: true }) });
A.ok(/SET UP ✓/.test(pg) && !/gal-steps/.test(pg) && /working on a drop right now/.test(pg) && /Nothing is posted or listed anywhere/.test(pg), 'set up and running: the checklist folds away; "working now" is said because the trigger says so');
pg = page({ steps: ready, designs: [], products, trigger: T() });
A.ok(!/working on a drop/.test(pg) && /Nothing here yet/.test(pg), 'idle and empty: no "working" claim');
pg = page({ steps: ready, designs: [], products, trigger: T({ lastError: 'x.png is the same image as design dsn_1 — not taken twice' }) });
A.ok(/Last drop: x\.png is the same image as design dsn_1/.test(pg), 'the last drop\'s refusal is shown in its own words');
pg = page({ steps: G.setupSteps({ line: null, triggers: [], grants: null }), designs: [], products });
A.ok(/SET UP — 0 OF 5 DONE/.test(pg) && /PLACE THE ART LINE/.test(pg) && /Finish the setup above/.test(pg), 'not set up: the checklist leads');
pg = page({ steps: ready, showSetup: true, designs: [], products, setupMsg: { text: 'Folders <ready>', bad: false }, loadError: 'list <broken>' });
A.ok(/gal-steps/.test(pg) && /Folders &lt;ready&gt;/.test(pg) && /list &lt;broken&gt;/.test(pg), 'the checklist can be reopened; messages are escaped');

/* ---- wiring: the window is reachable and loads after what it needs ---- */
const index = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const at = s => index.indexOf(s);
A.ok(at('app/gallery.js') > at('app/stationui.js') && at('app/windows/gallery.js') > at('app/gallery.js') && at('app/gallery.js') > at('app/workflowline.js') && at('css/gallery.css') > 0, 'index.html loads the Gallery after stationui and its readings');
A.ok(Places.PLACES.some(p => p.id === 'gallery' && /GALLERY/.test(p.label || p.name || JSON.stringify(p))), 'the Gallery is a known place');
const ui = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'stationui.js'), 'utf8');
A.ok(/id: 'gallery', k: 'gallery', label: 'GALLERY'/.test(ui), 'and a tab under MY WORK');
const win = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'gallery.js'), 'utf8');
A.ok(/registerWindow\('gallery', 'GALLERY'/.test(win) && !/innerHTML\s*=\s*[^;]*\+\s*(?:r\.j|j\.)/.test(win), 'the window registers itself and never writes a server string into the page unescaped');
for (const route of ['/api/art/designs', '/api/art/designs/resume', '/api/art/setup', '/api/art/designs/approve', '/api/art/designs/rights', '/api/art/designs/export', '/api/routing/triggers', '/api/permissions/grant'])
  A.ok(win.indexOf("'" + route) >= 0, 'the window uses ' + route);
A.ok(!/permissions\/bypass/.test(win), 'the Gallery never touches Full Access');

A.report('gallery.test');
