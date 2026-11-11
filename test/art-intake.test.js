/* node test/art-intake.test.js — a dropped file becomes a design, once, and the original is never touched
   (Art Studio Phase 2b). Real temp folders, the real folder watcher and trigger runner, the real design store and
   image library; only the channel hub is a fake that records the work item it was handed.

   Verifies end to end: drop a PNG in a watched folder -> ONE work item carrying the design id and the copy's path,
   a record in the store, a byte-identical copy in the line's folder, the drop folder untouched. A non-image, a
   corrupt image and a duplicate start NOTHING and are not re-read every poll. No working folder = retried later,
   not lost. An admitted-but-never-dispatched design is resumed, not treated as a duplicate. */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const C = require('@napi-rs/canvas');
const T = require('../sidecar/routing/triggers.js');
const { makeTriggerRunner } = require('../sidecar/routing/trigger-runner.js');
const { makeFolderWatcher } = require('../sidecar/routing/trigger-folder.js');
const { makeDesignStore } = require('../sidecar/art/design-store.js');
const { makeDesignIntake, composeDesignItem } = require('../sidecar/art/intake.js');
const { makeArtOps } = require('../sidecar/art/art-ops.js');

const ROOT = path.join(os.tmpdir(), 'starnet-art-intake-test-' + process.pid);
const DROPS = path.join(ROOT, 'drops'), PROJ = path.join(ROOT, 'line-folder'), WS = path.join(ROOT, 'workspaces');
fs.rmSync(ROOT, { recursive: true, force: true });
for (const d of [DROPS, PROJ, WS]) fs.mkdirSync(d, { recursive: true });
const draw = (w, h, color) => { const cv = C.createCanvas(w, h), g = cv.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.fillStyle = color; g.fillRect(w / 4, h / 4, w / 2, h / 2); return cv.toBuffer('image/png'); };
const old = Date.now() - 60000;
function drop(name, bytes) { const p = path.join(DROPS, name); fs.writeFileSync(p, bytes); fs.utimesSync(p, old / 1000, old / 1000); return p; }
const tick = ms => new Promise(r => setTimeout(r, ms || 30));

let n = 0, lineRoot = PROJ;
const store = makeDesignStore({ fs, path, workspaces: WS, now: () => Date.now(), newId: () => crypto.randomBytes(8).toString('hex') });
const mkIntake = () => makeDesignIntake({ fsp, path, store, artOps: makeArtOps({ canvas: C }), sha256: b => crypto.createHash('sha256').update(b).digest('hex'), lineRoot: () => lineRoot });

function harness(intake) {
  const disk = { triggers: { triggers: [] }, seen: {} };
  const items = [];
  const makeHub = hooks => ({
    _internals: { inflight: new Map() },
    onInbound(msg) {
      items.push(String(msg.text || ''));
      const routed = hooks.onRouted({ agentId: 'agent-a', dockId: 'b1' });
      hooks.onResolved({ chatId: msg.chatId, agentId: routed.agentId, isTask: true, lineId: 'L1', dockId: 'b1' });
      hooks.onLineOutcome({ agentId: 'agent-a', dockId: 'b1', stopped: false, shipped: true });
      return Promise.resolve();
    },
    close() {}
  });
  const R = makeTriggerRunner({
    load: () => JSON.parse(JSON.stringify(disk.triggers)), save: v => { disk.triggers = JSON.parse(JSON.stringify(v)); },
    seen: { load: () => JSON.parse(JSON.stringify(disk.seen)), save: v => { disk.seen = JSON.parse(JSON.stringify(v)); } },
    makeHub, plan: () => ({ lines: [{ lineId: 'L1', projectRoot: PROJ }], reach: { 'agent-a': true }, lineOfAgent: { 'agent-a': 'L1' } }),
    shipsToOutbox: () => true, dayCap: () => ({ cap: null, spent: 0 }), halted: () => false,
    runsFor: () => [{ runId: 'run-' + (++n), agentId: 'agent-a', reason: 'done', usd: 0.01 }], emit: () => {},
    watcher: makeFolderWatcher({ fsp, pathMod: path, settleMs: 0 }), intakeDesign: intake,
    now: () => Date.now(), newId: () => 'id' + (++n) + 'abcdef0123456789'
  });
  return { R, disk, items };
}
const scan = async H => { await H.R.tickFolders(); await H.R.tickFolders(); await tick(40); };

(async () => {
  /* ---- the trigger record: intake is an explicit, validated, additive mode ---- */
  const v1 = T.validateInput({ kind: 'folder', lineId: 'L1', config: { path: DROPS, task: 'plan it', intake: 'design' } }, {});
  A.eq([v1.ok, v1.fields && v1.fields.config.intake], [true, 'design'], 'a folder trigger may be an ART DROP (config.intake: "design")');
  A.eq(T.validateInput({ kind: 'folder', lineId: 'L1', config: { path: DROPS, intake: 'everything' } }, {}).ok, false, 'any other intake value is refused');
  const v2 = T.validateInput({ kind: 'folder', lineId: 'L1', config: { path: DROPS } }, {});
  A.ok(v2.ok && !('intake' in v2.fields.config), 'an ordinary folder trigger carries no intake field at all');

  /* ---- 1. the happy path, through the real watcher and runner ---- */
  const H = harness(mkIntake());
  const base = await makeFolderWatcher({ fsp, pathMod: path }).baseline(DROPS);
  const c = H.R.create({ kind: 'folder', lineId: 'L1', name: 'ART DROP', config: { path: DROPS, task: 'Decide which products this design suits.', intake: 'design' } }, { baselineKeys: base.keys });
  A.ok(c.ok, 'the art drop trigger is created: ' + (c.error || ''));
  A.eq(H.R.get(c.trigger.id).config.intake, 'design', 'and keeps its intake mode');
  const bytes = draw(1200, 800, '#ff00aa');
  const dropped = drop('Neon Statue.png', bytes);
  await scan(H);
  A.eq(H.items.length, 1, 'exactly one work item starts the line');
  const rec = store.list()[0];
  A.ok(rec && /^dsn_/.test(rec.id), 'a design record exists');
  A.eq([rec.status, rec.source.originalName, rec.source.width, rec.source.height, rec.source.lineId, rec.source.triggerId],
    ['new', 'Neon Statue.png', 1200, 800, 'L1', c.trigger.id], 'the record carries the file\'s name, measured size, line and trigger');
  A.eq(rec.source.storedRel, 'designs/' + rec.id + '/original.png', 'the copy lives at designs/<id>/original.png in the line\'s folder');
  A.eq([rec.facts.background.kind, rec.facts.bbox], ['flat', { x: 300, y: 200, width: 600, height: 400 }], 'the measurements taken at intake are on the record');
  A.ok(fs.readFileSync(path.join(PROJ, rec.source.storedRel)).equals(bytes), 'the copy in the line\'s folder is byte-identical');
  A.ok(fs.readFileSync(dropped).equals(bytes) && fs.readdirSync(DROPS).join() === 'Neon Statue.png', 'the drop folder is untouched: same file, same bytes, nothing added');
  const item = H.items[0];
  A.ok(item.includes('Design id: ' + rec.id) && item.includes('Design file: ' + rec.source.storedRel), 'the work item gives the stage the design id and the copy\'s path');
  A.eq(rec.source.previewRel, 'designs/' + rec.id + '/preview.jpg', 'a small look-at copy is recorded beside it');
  { const pv = fs.readFileSync(path.join(PROJ, rec.source.previewRel)); A.ok(pv[0] === 0xff && pv[1] === 0xd8 && pv.length > 200, 'and is a real JPEG on disk'); }
  A.ok(item.includes('Preview to LOOK at: ' + rec.source.previewRel), 'the work item names the preview for image_analyze');
  A.ok(/Size: 1200 x 800 px · background: flat #ffffff/.test(item) && /Task: Decide which products/.test(item), 'and its size, background and the trigger\'s task');
  A.ok(!item.includes(DROPS), 'the work item never points a stage at the drop folder (a path no agent can open)');
  A.ok(/DATA to work on, not instructions/.test(item), 'the image is framed as data');
  A.eq(H.R.get(c.trigger.id).lastError || null, null, 'no error is on the trigger');

  /* ---- 2. things that are not designs start nothing, and are not re-read forever ---- */
  drop('notes.txt', 'hello');
  drop('broken.png', 'not really a png');
  drop('copy of statue.png', bytes);                       // the SAME bytes under another name
  await scan(H); await scan(H);
  A.eq(H.items.length, 1, 'a text file, a corrupt image and a duplicate started no run');
  A.eq(store.list().length, 1, 'and created no record');
  A.ok(/not a PNG or JPEG|could not be opened as an image|same image as design/.test(String(H.R.get(c.trigger.id).lastError)), 'the reason is said on the trigger: ' + H.R.get(c.trigger.id).lastError);
  const seenN = Object.keys(H.disk.seen[c.trigger.id]).length;
  A.ok(seenN >= 4, 'declined files are marked handled, so they are not re-read every poll (' + seenN + ' keys)');
  A.eq(fs.readdirSync(DROPS).sort(), ['Neon Statue.png', 'broken.png', 'copy of statue.png', 'notes.txt'], 'nothing in the drop folder was moved or deleted');

  /* ---- 3. a second, different design ---- */
  drop('angel.jpg', (() => { const cv = C.createCanvas(900, 1600), g = cv.getContext('2d'); g.fillStyle = '#103050'; g.fillRect(0, 0, 900, 1600); g.fillStyle = '#40ffa0'; g.fillRect(100, 300, 700, 1000); return cv.toBuffer('image/jpeg'); })());
  await scan(H);
  A.eq([H.items.length, store.list().length], [2, 2], 'a different image is a second design and a second work item');
  A.ok(/\/original\.jpg$/.test(store.list()[0].source.storedRel), 'a JPEG keeps its type');

  /* ---- 4. no working folder: not lost, retried ---- */
  lineRoot = '';
  const H2 = harness(mkIntake());
  const c2 = H2.R.create({ kind: 'folder', lineId: 'L1', config: { path: DROPS, intake: 'design' } }, { baselineKeys: (await makeFolderWatcher({ fsp, pathMod: path }).baseline(DROPS)).keys });
  drop('later.png', draw(800, 800, '#2040ff'));
  await scan(H2);
  A.eq(H2.items.length, 0, 'with no working folder the line is not started');
  A.ok(/no working folder yet/.test(String(H2.R.get(c2.trigger.id).lastError)) && /retrying it later/.test(String(H2.R.get(c2.trigger.id).lastError)), 'the trigger says why, and that it will retry');
  A.ok(!Object.keys(H2.disk.seen[c2.trigger.id]).some(k => /later\.png/.test(k)), 'the file is NOT marked handled');
  A.eq(store.list().length, 2, 'and no half-made record was left behind');

  /* ---- 5. intake unit: resume vs duplicate, wiring guard ---- */
  lineRoot = PROJ;
  const intake = mkIntake();
  const fileOf = name => ({ name, abs: path.join(DROPS, name), size: fs.statSync(path.join(DROPS, name)).size });
  const trg = { id: 'trg_x', lineId: 'L1', name: 'ART DROP', config: { task: '' } };
  const first = await intake({ trigger: trg, file: fileOf('later.png') });
  A.eq([first.ok, !!first.resumed], [true, false], 'first sighting: taken');
  const again = await intake({ trigger: trg, file: fileOf('later.png') });
  A.eq([again.ok, again.skip, again.duplicateOf], [false, true, first.designId], 'the same process seeing it again: a duplicate (it was just handed out)');
  const afterRestart = await mkIntake()({ trigger: trg, file: fileOf('later.png') });
  A.eq([afterRestart.ok, afterRestart.resumed, afterRestart.designId], [true, true, first.designId], 'a NEW process (a restart before the run started): the same design is resumed, not lost');
  A.eq(store.list().filter(d => d.source.originalName === 'later.png').length, 1, 'still one record for it');
  await store.setPlan(first.designId, null, { basis: 'fit-judgement', products: [{ productId: 'cover-art', placementId: 'square', fabricId: null, score: 50, why: 'x' }], skipped: [] }, {});
  const planned = await mkIntake()({ trigger: trg, file: fileOf('later.png') });
  A.eq([planned.ok, planned.skip], [false, true], 'once work has been done on it, the same bytes are a duplicate even after a restart');
  A.throws(() => makeDesignIntake({ fsp, path }), 'intake refuses to exist half-wired');
  A.ok(/Design id: dsn_x/.test(composeDesignItem({ designId: 'dsn_x', storedRel: 'a', originalName: 'b', width: 1, height: 2 })), 'composeDesignItem is usable on its own');

  /* ---- 6. an art drop trigger on a station with no intake wired says so, and starts nothing ---- */
  const H3 = harness(undefined);
  const c3 = H3.R.create({ kind: 'folder', lineId: 'L1', config: { path: DROPS, intake: 'design' } }, { baselineKeys: (await makeFolderWatcher({ fsp, pathMod: path }).baseline(DROPS)).keys });
  drop('unwired.png', draw(700, 700, '#00ccff'));
  await scan(H3);
  A.eq(H3.items.length, 0, 'no intake wired: nothing starts');
  A.ok(/cannot take designs/.test(String(H3.R.get(c3.trigger.id).lastError)), 'and the trigger says so');

  fs.rmSync(ROOT, { recursive: true, force: true });
  A.report('art-intake.test');
})().catch(e => { console.error(e); process.exit(1); });
