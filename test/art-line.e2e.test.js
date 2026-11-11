/* node test/art-line.e2e.test.js — THE ART LINE, end to end, against the REAL host (Art Studio Phase 5 acceptance).

   Boot pattern per routing.triggers.e2e.test.js: the real sidecar over real sockets, a scripted mock provider (zero
   real spend, no keys), HOME pointed at a scratch folder. The mock plays the four steps by emitting REAL tool calls —
   every print file, preview, mockup and record below is made by the product's own tools, not by the test.

   The floor is the shipped `art_line` blueprint, stamped with the shipped step instructions, crewed by ONE agent on
   all four steps (the simplest thing an owner does), deployed as the compiled plan.

   Locks (the plan's v1 promise: drop a PNG, it ends up in the Gallery):
     1. SETUP: /api/art/setup makes the two folders and trusts only the studio folder; the drop folder can be watched.
     2. AUTONOMY: with the one "art:write" grant and NO Full Access, an unattended folder-drop run may save print
        files and mockups. Without the grant the same run is refused and the design says why (no silent stall).
     3. THE LINE: a dropped PNG is copied (the original is never touched), planned, made into print files at the
        catalog's exact pixel sizes, checked — the INSPECTOR's "revise" really sends ONE product back to the DESIGNER
        and nowhere else — and mocked up; the design ends READY with real run ids on it.
     4. EYES: the steps could LOOK — image_analyze on the small previews worked inside an unattended run.
     5. GALLERY API: the list, the images, approve, rights, export (new files + a draft listing in the studio folder).
     6. RESTART: records and files survive; the same image dropped again is not taken twice; a new one still runs.
     7. BUDGET: the line carries its limits ($5/day, $2/design, 8 stages), and once the day's limit is reached a new
        drop is not worked — and says so. */
'use strict';
const A = require('./_assert.js');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const C = require('@napi-rs/canvas');
const { bootToken } = require('./_httpToken.js');
const WM = require('../frontend/app/worldmodel.js');
const Pipeline = require('../frontend/app/pipeline.js');
const WorkflowLine = require('../frontend/app/workflowline.js');
const { allocatePort, BIND_REFUSED } = require('./helpers/ports.js');

const HOST = '127.0.0.1';
const INDEX = path.resolve(__dirname, '..', 'sidecar', 'index.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROLES = ['STRATEGIST', 'DESIGNER', 'INSPECTOR', 'MOCKUP'];
const BRIEFS = {}; for (const r of ROLES) BRIEFS[r] = WorkflowLine.defaultBrief(r);
const AGENT = 'art-agent';

/* ---------- the scripted provider: plays each step with real tool calls ---------- */
function startMock(price) {
  const S = { requests: [], seen: [], vision: 0, passes: {}, toolsOffered: {}, toolErrors: [] };
  const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('\n') : '');
  // which step is this? A handed-on stage names its own instructions after "YOUR STANDING BRIEF FOR THIS STATION:" (a looped
  // stage's prompt also quotes earlier stages, so "anywhere in the prompt" is not enough); the entry stage carries its
  // instructions in its system prompt.
  const MARK = 'YOUR STANDING BRIEF FOR THIS STATION:';
  const roleOf = all => {
    const i = all.lastIndexOf(MARK), own = i >= 0 ? all.slice(i + MARK.length, i + MARK.length + 400) : all;
    return ROLES.find(r => own.indexOf(BRIEFS[r].does.slice(80, 170)) >= 0) || null;
  };
  function decide(body) {
    const msgs = (body && body.messages) || [];
    const all = msgs.map(m => textOf(m && m.content)).join('\n');
    let lastUser = -1; msgs.forEach((m, i) => { if (m && m.role === 'user') lastUser = i; });
    const done = msgs.slice(lastUser + 1).filter(m => m && m.role === 'tool');
    const offeredNames = ((body && body.tools) || []).map(t => (t.function && t.function.name) || t.name);
    // every stage first settles its Task Brief (the station's own rule for consequential work), then works
    const briefTool = offeredNames.find(n => /^brief[._]proceed$/.test(n));
    const step = done.length - (briefTool ? 1 : 0);
    if (process.env.ART_E2E_DEBUG && done.length) console.log('[mock] ' + (roleOf(all) || '?') + ' saw: ' + textOf(done[done.length - 1].content).replace(/\s+/g, ' ').slice(0, 400));
    for (const t of done) { const s = textOf(t.content); if (/^(error|refused|denied)|not permitted|needs your approval|was not approved/i.test(s)) S.toolErrors.push(s.slice(0, 300)); }
    const role = roleOf(all);
    const ids = all.match(/dsn_[a-z0-9]{6,40}/g) || [], id = ids[ids.length - 1] || '';
    if (role) S.toolsOffered[role] = offeredNames;
    S.seen.push({ role, id, step });
    if (process.env.ART_E2E_DUMP && step < 0) { S.dumpN = (S.dumpN || 0) + 1; fs.writeFileSync('/tmp/art-dump-' + S.dumpN + '.txt', msgs.map(m => '### ' + m.role + '\n' + textOf(m.content)).join('\n\n')); }
    const key = role + ':' + id, pass = S.passes[key] || 0;
    const end = text => { S.passes[key] = pass + 1; return { text }; };
    const tool = (name, args) => ({ tool: { name, args } });
    const redo = /\[Art redo:/.test(all);
    if (!role || !id) return { text: 'nothing to do' };
    if (step < 0) return tool(briefTool, { objective: role + ': do this step for design ' + id, deliverable: 'the step\'s result, recorded on the design' });
    if (role === 'STRATEGIST') {
      if (redo) return end('Art redo for ' + id + ': the plan stands. Remake tee-front following the owner\'s note. [Art redo: continuing] Design id: ' + id);
      const pv = (all.match(/Preview to LOOK at: (\S+)/) || [])[1];
      return [tool('design_get', { design: id }), tool('image_analyze', { image: pv, prompt: 'What is in this design?' }), tool('product_catalog', {}),
        tool('product_plan_submit', { design: id,
          analysis: { summary: 'A magenta block with a near-black square on a white page, flat and graphic.', subjects: ['block', 'square'], mood: 'bold', palette: ['magenta', 'black'], textInArt: '' },
          products: [{ productId: 'tee-front', fabricId: 'black', score: 88, why: 'A bold flat shape reads clearly across a shirt front.', titleIdeas: ['Magenta Block Tee'] },
            { productId: 'sticker-4x4', score: 71, why: 'A simple outline die-cuts cleanly at sticker size.' }],
          skipped: [{ productId: 'dad-hat-front', reason: 'The square composition is too tall for a cap front.' }] })][step]
        || end('Planned design ' + id + ': tee-front on black, then sticker-4x4. Design id: ' + id);
    }
    if (role === 'DESIGNER') {
      const first = [tool('art_prepare', { design: id, product: 'tee-front', fabric: 'black' }), tool('art_prepare', { design: id, product: 'sticker-4x4' })];
      const again = [tool('art_prepare', { design: id, product: 'tee-front', fabric: 'black', recolor: 'outline' })];
      return ((pass === 0 && !redo) ? first : again)[step] || end('Print files made for design ' + id + (redo ? ' [Art redo: continuing]' : '') + '. Design id: ' + id);
    }
    if (role === 'INSPECTOR') {
      const first = [tool('design_get', { design: id }), tool('image_analyze', { image: 'designs/' + id + '/print/tee-front-black.preview.jpg', prompt: 'Does the art stand out from the fabric?' }),
        tool('design_review', { design: id, product: 'tee-front', verdict: 'redo', notes: 'The near-black square vanishes into the black fabric: remake with recolor outline.' }),
        tool('design_review', { design: id, product: 'sticker-4x4', verdict: 'pass' })];
      const again = [tool('design_review', { design: id, product: 'tee-front', verdict: 'pass', notes: 'The outline separates it from the fabric now.' })];
      const firstLook = pass === 0 && !redo;
      return (firstLook ? first : again)[step]
        || end('Checked design ' + id + (redo ? ' [Art redo: continuing]' : '') + '. Design id: ' + id + '\n' + (firstLook ? 'tee-front: redo\nsticker-4x4: pass\nVERDICT: revise' : 'tee-front: pass\nVERDICT: approved'));
    }
    return [tool('design_get', { design: id }), tool('mockup_render', { design: id, product: 'tee-front', fabric: 'black' }), ...(redo ? [] : [tool('mockup_render', { design: id, product: 'sticker-4x4' })])][step]
      || end('Mockups rendered for design ' + id + '. It is waiting for the owner in the Gallery. Nothing was published.');
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.indexOf('/models') >= 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 200000, pricing: { prompt: String(price), completion: '0' }, supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } }] }));
      }
      if (req.url.indexOf('/chat/completions') < 0) { res.writeHead(404); return res.end(); }
      let raw = '';
      req.on('data', d => { raw += d; });
      req.on('end', () => {
        let body = null; try { body = JSON.parse(raw); } catch (_) { body = null; }
        S.requests.push(body);
        const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
        const isVision = ((body && body.messages) || []).some(m => Array.isArray(m && m.content) && m.content.some(p => p && p.type === 'image_url'));
        if (isVision || !(body && body.stream)) {
          if (isVision) S.vision++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A magenta rectangle with a small near-black square, on a plain background.' }, finish_reason: 'stop' }], usage }));
        }
        const turn = decide(body);
        if (process.env.ART_E2E_DEBUG) { const l = mock_last(S); console.log('[mock] -> ' + JSON.stringify(l) + ' ' + (turn.tool ? turn.tool.name : 'TEXT ' + String(turn.text).slice(0, 60))); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        if (turn.tool) {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + S.requests.length, type: 'function', function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage }) + '\n\n');
        } else {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: turn.text } }] }) + '\n\n');
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, HOST, () => resolve({ server, S, base: 'http://' + HOST + ':' + server.address().port + '/api/v1' }));
  });
}

const mock_last = S => S.seen[S.seen.length - 1];
function boot(port, env, attemptsLeft) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [INDEX], { env: Object.assign({}, process.env, env, { SKYNET_PORT: String(port), STARNET_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', settled = false;
    const onData = d => {
      out += d.toString();
      if (!settled && out.indexOf('http://' + HOST + ':' + port) >= 0) { settled = true; resolve({ child, port, log: () => out }); }
      else if (!settled && BIND_REFUSED.test(out)) {
        settled = true; try { child.kill(); } catch (_) {}
        if (attemptsLeft > 0) resolve(allocatePort().then(next => boot(next, env, attemptsLeft - 1))); else reject(new Error('no free port'));
      }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('error', e => { if (!settled) { settled = true; reject(e); } });
    setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} reject(new Error('boot timeout:\n' + out)); } }, 30000);
  });
}
function stop(child) { return new Promise(r => { if (!child || child.exitCode != null) return r(); child.once('exit', () => r()); try { child.kill(); } catch (_) { r(); } }); }

/* the shipped blueprint, stamped with the shipped instructions, one agent on every step, working in `studio` */
function artFloor(studio, limits) {
  const s = WM.create();
  A.ok(s.addRoom({ kind: 'hab', rect: { x1: 30, y1: 0, x2: 69, y2: 14 } }).ok, 'fixture: a deck for the line');
  const r = s.stampBlueprint('art_line', 32, 2, Object.assign({ briefs: BRIEFS }, limits ? { limits } : {}));
  A.ok(r.ok, 'the ART LINE blueprint stamps');
  const props = r.ids.map(id => s.propById(id)), intake = props.find(p => p.t === 'intake');
  for (const b of props.filter(p => p.t === 'bay')) A.ok(s.assignPropAgent(b.id, AGENT).ok, 'one agent crews ' + b.role);
  A.ok(s.setPropProject(intake.id, studio).ok, 'the line works in the studio folder');
  const plan = Pipeline.compileRoutingPlan(s.projectGeometry());
  A.eq(plan.errors.length, 0, 'the crewed line compiles clean: ' + JSON.stringify(plan.errors));
  for (const b of plan.bays.concat(plan.dockBays)) b.objects = ['computer', 'studio'];   // what a desk + a STUDIO in the agent's room grant
  return plan;
}
function designPng(seed) {   // 3000x3000 white page, magenta block, a near-black square; `seed` makes the bytes differ
  const cv = C.createCanvas(3000, 3000), g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 3000, 3000);
  g.fillStyle = '#ff00aa'; g.fillRect(400, 300, 2200, 2400);
  g.fillStyle = '#0b0b0b'; g.fillRect(900 + seed * 40, 900, 700, 700);
  return cv.toBuffer('image/png');
}
async function sizeOf(file) { const img = await C.loadImage(fs.readFileSync(file)); return [img.width, img.height]; }

(async () => {
  const PRICE = 0.0001;   // $ per prompt token: every model call costs a cent, so spend is real and countable
  const mock = await startMock(PRICE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-art-e2e-'));
  const home = path.join(root, 'home'), ws = path.join(root, 'ws'), chosen = path.join(home, 'Art Station');
  for (const d of [home, ws, chosen, path.join(root, 'hermes')]) fs.mkdirSync(d, { recursive: true });
  const env = {
    SKYNET_WORKSPACES: ws, STARNET_WORKSPACES: ws, STARNET_DEV: '', SKYNET_DEV: '',
    HOME: home, USERPROFILE: home, HERMES_HOME: path.join(root, 'hermes'),
    SKYNET_OPENROUTER_BASE: mock.base, SKYNET_OPENROUTER_KEY: 'sk-or-v1-art-fake', SKYNET_DEFAULT_MODEL: 'test/model',
    STARNET_TRIGGER_POLL_MS: '300', STARNET_TRIGGER_SETTLE_MS: '200'
  };
  let { child, port, log } = await boot(await allocatePort(), env, 20);
  let B = 'http://' + HOST + ':' + port;
  try {
    let token = await bootToken(B, B);
    let headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const api = (p, method, body) => fetch(B + p, { method: method || 'GET', headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(r => r.json().catch(() => null).then(j => ({ status: r.status, j })));
    const triggers = async () => ((await api('/api/routing/triggers')).j || {}).triggers || [];
    const designs = async () => ((await api('/api/art/designs')).j || {}).designs || [];
    const waitFor = async (pred, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(250); } A.ok(false, 'timed out waiting for ' + what + '\n--- sidecar log tail ---\n' + log().slice(-3000)); return null; };

    /* ---- 1. SETUP ---- */
    A.eq((await fetch(B + '/api/art/designs', { headers: { Origin: B } })).status, 403, 'the Gallery API sits behind the launch token');
    const su = await api('/api/art/setup', 'POST', { folder: chosen });
    A.ok(su.status === 200 && su.j.ok, 'setup made the folders: ' + JSON.stringify(su.j));
    const drop = su.j.drop, studio = su.j.studio;
    A.ok(fs.statSync(drop).isDirectory() && fs.statSync(studio).isDirectory() && path.dirname(drop) === path.dirname(studio), 'two sibling folders inside the one the owner chose');
    const plan = artFloor(studio);
    A.eq(plan.lines[0].limits, { maxHops: 8, maxUsdPerMessage: 2, maxUsdPerDay: 5 }, 'the stamped line carries its budget: $5 a day, $2 a design, 8 stages');
    A.eq((await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(plan) })).status, 200, 'the art floor deploys');
    const lineId = Pipeline.lineOf(plan, AGENT);
    const inside = await api('/api/routing/triggers', 'POST', { kind: 'folder', lineId, config: { path: path.join(studio), intake: 'design' } });
    A.ok(inside.status === 400 && inside.j.code === 'lineoutput', 'the studio folder itself cannot be the drop folder (the line would feed on its own output)');
    const ct = await api('/api/routing/triggers', 'POST', { kind: 'folder', lineId, name: 'ART DROP', config: { path: drop, intake: 'design' } });
    A.ok(ct.status === 200 && ct.j.trigger.blockedBy === null && ct.j.trigger.config.intake === 'design', 'the ART DROP trigger is armed on the drop folder: ' + JSON.stringify(ct.j));
    const tid = ct.j.trigger.id;

    /* ---- 2a. WITHOUT the grant: an unattended run may not save files, and the design says so ---- */
    const g0 = await api('/api/art/designs');
    A.eq([g0.j.designs.length, g0.j.grants && g0.j.grants.artWrite], [0, false], 'an empty gallery; the art grant is off and reported off');
    const bytes0 = designPng(0);
    fs.writeFileSync(path.join(drop, 'Ungranted.png'), bytes0);
    const t0 = await waitFor(async () => { const t = (await triggers()).find(x => x.id === tid); return t && t.fires === 1 && t.lastOutcome && !t.running ? t : null; }, 90000, 'the ungranted drop to finish');
    let d0 = (await designs()).find(d => d.source.originalName === 'Ungranted.png');
    A.ok(d0 && d0.plan && d0.plan.products.length === 2, 'the design was taken and planned (planning writes no files)');
    A.eq(d0.variants.length, 0, 'but NO print file was saved without the owner\'s grant');
    A.ok(mock.S.toolErrors.length > 0, 'the tool refusals reached the agent (silence is not consent): ' + JSON.stringify(mock.S.toolErrors.slice(0, 1)));
    A.ok(d0.status !== 'ready', 'and the design is not shown as ready: ' + d0.status);
    const printDir0 = path.join(studio, 'designs', d0.id, 'print');
    A.ok(!fs.existsSync(printDir0) || fs.readdirSync(printDir0).length === 0, 'nothing was written to the print folder');
    void t0;

    /* ---- 2b. the ONE grant (never Full Access) ---- */
    const gr = await api('/api/permissions/grant', 'POST', { key: 'art:write' });
    A.ok(gr.status === 200 && gr.j.ok, 'the owner grants "save print files and mockups": ' + JSON.stringify(gr.j));
    A.eq((await api('/api/art/designs')).j.grants.artWrite, true, 'the Gallery reads the grant back as on');
    const perms = (await api('/api/permissions')).j || {};
    A.ok(!perms.bypass && !(perms.fullBypass), 'Full Access stays OFF: ' + JSON.stringify({ bypass: perms.bypass, fullBypass: perms.fullBypass }));

    /* ---- 3. THE LINE ---- */
    mock.S.toolErrors.length = 0; mock.S.seen.length = 0;
    const bytes1 = designPng(1), dropped1 = path.join(drop, 'Neon Block.png');
    fs.writeFileSync(dropped1, bytes1);
    const t1 = await waitFor(async () => { const t = (await triggers()).find(x => x.id === tid); return t && t.fires === 2 && t.lastOutcome && !t.running ? t : null; }, 120000, 'the design to ride the whole line');
    A.ok(t1 && t1.lastOutcome.ok === true, 'the fire finished cleanly: ' + JSON.stringify(t1 && t1.lastOutcome) + ' err=' + (t1 && t1.lastError));
    A.eq(t1 && t1.lastOutcome.runs, 6, 'six real runs: STRATEGIST, DESIGNER, INSPECTOR, (sent back) DESIGNER, INSPECTOR, MOCKUP');
    A.eq(mock.S.toolErrors, [], 'no tool call was refused');
    const order = []; for (const s of mock.S.seen) if (s.role && order[order.length - 1] !== s.role) order.push(s.role);
    A.eq(order, ['STRATEGIST', 'DESIGNER', 'INSPECTOR', 'DESIGNER', 'INSPECTOR', 'MOCKUP'], 'the INSPECTOR\'s "revise" went back to the DESIGNER — not the STRATEGIST — and "approved" went on to MOCKUP');
    for (const r of ROLES) A.ok(['art_prepare', 'mockup_render', 'design_get', 'design_review', 'product_plan_submit', 'product_catalog', 'image_analyze'].every(n => (mock.S.toolsOffered[r] || []).indexOf(n) >= 0), r + ' was offered the art tools by its STUDIO object in an unattended run');
    A.ok(!(mock.S.toolsOffered.DESIGNER || []).some(n => /^shell|shell\.exec/.test(n)), 'and no shell: a folder-drop run is locked down');
    const d1 = (await designs()).find(d => d.source.originalName === 'Neon Block.png');
    A.ok(d1, 'the design is in the Gallery list');
    const ID = d1.id, at = rel => path.join(studio, rel);
    A.eq([d1.status, d1.source.projectRoot, d1.source.storedRel, d1.source.previewRel, d1.source.triggerId], ['ready', studio, 'designs/' + ID + '/original.png', 'designs/' + ID + '/preview.jpg', tid], 'READY, recorded in the studio folder');
    A.ok(fs.readFileSync(dropped1).equals(bytes1), 'the ORIGINAL in the drop folder is byte-identical — never touched');
    A.ok(fs.readFileSync(at(d1.source.storedRel)).equals(bytes1), 'the line worked on its own copy');
    A.eq(d1.plan.products.map(p => [p.productId, p.fabricId || null, p.score]), [['tee-front', 'black', 88], ['sticker-4x4', null, 71]], 'the plan is ranked, with reasons');
    A.ok(d1.plan.basis === 'fit-judgement' && d1.plan.products.every(p => p.why.length > 10) && d1.plan.skipped.some(k => k.productId === 'dad-hat-front'), 'and is labelled a fit judgement, with what was ruled out');
    const catalog = require('../sidecar/art/products.js').loadCatalog({ fs });
    A.eq(d1.variants.map(v => v.productId).sort(), ['sticker-4x4', 'tee-front'], 'two print files');
    for (const v of d1.variants) {
      const pl = catalog.resolve(v.productId, null, v.fabricId).placement;
      A.eq(await sizeOf(at(v.path)), [pl.widthPx, pl.heightPx], v.productId + ': the print file on disk is exactly the catalog size ' + pl.widthPx + 'x' + pl.heightPx);
      A.ok(v.previewPath && fs.statSync(at(v.previewPath)).size < 1500000, v.productId + ': with a small look-at preview');
      A.eq(v.review && v.review.verdict, 'pass', v.productId + ': checked and passed');
    }
    const tee = d1.variants.find(v => v.productId === 'tee-front');
    A.ok(tee.reviewRounds === 1 && tee.steps.some(s => /outline/.test(s)), 'the tee was sent back once and remade with the outline the INSPECTOR asked for: ' + JSON.stringify(tee.steps));
    A.eq(d1.variants.find(v => v.productId === 'sticker-4x4').reviewRounds, 0, 'the sticker passed first time and was left alone');
    A.eq(d1.mockups.map(m => m.productId).sort(), ['sticker-4x4', 'tee-front'], 'a mockup for each');
    for (const m of d1.mockups) A.ok(fs.statSync(at(m.path)).size > 1000, 'mockup on disk: ' + m.path);
    A.ok(d1.runCount === 6 && d1.spendFromRuns === true && d1.spendUsd > 0.1, 'six run ids on the record; spend is summed from those real runs: $' + d1.spendUsd + ' over ' + d1.runCount);
    /* ---- 4. EYES ---- */
    A.ok(mock.S.vision >= 2, 'image_analyze really sent pictures to the model (' + mock.S.vision + ' vision calls)');
    const visionBody = mock.S.requests.filter(b => ((b && b.messages) || []).some(m => Array.isArray(m && m.content) && m.content.some(p => p && p.type === 'image_url'))).pop();
    const dataUrl = visionBody.messages[0].content.find(p => p.type === 'image_url').image_url.url;
    A.ok(/^data:image\/jpeg;base64,/.test(dataUrl) && dataUrl.length < 2500000, 'what the INSPECTOR looked at was the small JPEG preview, not the full print file (' + dataUrl.length + ' chars)');

    /* ---- 5. GALLERY API ---- */
    const img = await fetch(B + '/api/art/file?design=' + ID + '&path=' + encodeURIComponent(d1.mockups[0].path), { headers });
    A.ok(img.status === 200 && img.headers.get('content-type') === 'image/png' && (await img.arrayBuffer()).byteLength > 1000, 'a mockup is served to the Gallery');
    A.eq((await fetch(B + '/api/art/file?design=' + ID + '&path=' + encodeURIComponent('../../' + path.basename(drop) + '/Neon Block.png'), { headers })).status, 404, 'the file route will not leave the design');
    A.eq((await api('/api/art/designs/export', 'POST', { design: ID })).j.code, 'RIGHTS_NOT_CONFIRMED', 'export waits for the rights confirmation');
    A.ok((await api('/api/art/designs/rights', 'POST', { design: ID, confirmed: true })).j.design.rightsConfirmed, 'rights confirmed by the owner');
    A.eq((await api('/api/art/designs/approve', 'POST', { design: ID, product: 'tee-front', decision: 'approved' })).status, 200, 'the owner approves the tee');
    A.eq((await api('/api/art/designs/approve', 'POST', { design: ID, product: 'sticker-4x4', decision: 'rejected', note: 'not this one' })).j.design.status, 'approved', 'and rejects the sticker: the design is decided');
    const ex = await api('/api/art/designs/export', 'POST', { design: ID });
    A.ok(ex.status === 200 && ex.j.ok && ex.j.products.join() === 'tee-front' && ex.j.problems.length === 0, 'export copied the approved product: ' + JSON.stringify(ex.j));
    A.ok(ex.j.folder.indexOf(path.join(studio, 'export')) === 0 && ex.j.written.every(w => fs.statSync(at(w)).size > 0) && ex.j.written.some(w => /listing\.txt$/.test(w)), 'into the studio folder: print file, mockup and a draft listing');

    /* ---- 6. RESTART ---- */
    await stop(child);
    ({ child, port, log } = await boot(port, env, 20));
    B = 'http://' + HOST + ':' + port;
    token = await bootToken(B, B);
    headers = { 'Content-Type': 'application/json', 'X-StarNet-Token': token, Origin: B };
    const after = (await designs()).find(d => d.id === ID);
    A.ok(after && after.status === 'approved' && after.variants.length === 2 && after.mockups.length === 2 && after.rightsConfirmed && after.approvals['tee-front'].decision === 'approved', 'after a restart the design, its files and the owner\'s decisions are all still there');
    A.ok(after.spendFromRuns && Math.abs(after.spendUsd - d1.spendUsd) < 1e-9, 'and its spend still reads from the same runs');
    A.eq((await api('/api/art/designs')).j.grants.artWrite, true, 'the grant survived the restart');
    fs.writeFileSync(path.join(drop, 'Neon Block copy.png'), bytes1);   // the same image under another name
    const dupSeen = await waitFor(async () => { const t = (await triggers()).find(x => x.id === tid); return t && /same image as design/.test(String(t.lastError || '') + JSON.stringify(t.lastOutcome || {}) + JSON.stringify(t.lastSkip || {})) ? t : null; }, 20000, 'the duplicate to be declined');
    A.ok(dupSeen, 'the same image dropped again is declined, with the reason');
    A.eq((await designs()).filter(d => d.source.sha256 === d1.source.sha256).length, 1, 'and is not taken twice');
    mock.S.toolErrors.length = 0;
    fs.writeFileSync(path.join(drop, 'Second.png'), designPng(2));
    const d2 = await waitFor(async () => { const d = (await designs()).find(x => x.source.originalName === 'Second.png'); return d && d.status === 'ready' ? d : null; }, 120000, 'a design dropped after the restart to reach READY');
    A.ok(d2 && d2.variants.length === 2 && d2.mockups.length === 2 && mock.S.toolErrors.length === 0, 'a design dropped after the restart rides the whole line too');

    /* ---- owner redo: recorded, and the line really restarts for that product only ---- */
    await waitFor(async () => { const t = (await triggers()).find(x => x.id === tid); return t && !t.running && !t.queued ? t : null; }, 30000, 'the line to be idle');
    const firesBefore = (await triggers()).find(x => x.id === tid).fires;
    const rd = await api('/api/art/designs/approve', 'POST', { design: d2.id, product: 'tee-front', decision: 'redo', note: 'Make the outline thicker.' });
    A.ok(rd.status === 200 && rd.j.rerun && rd.j.rerun.ok === true, 'the owner\'s redo is recorded and the line reports that it restarted: ' + JSON.stringify(rd.j.rerun));
    const d2b = await waitFor(async () => { const t = (await triggers()).find(x => x.id === tid); const d = (await designs()).find(x => x.id === d2.id); return t && t.fires === firesBefore + 1 && !t.running && d && d.status === 'ready' ? d : null; }, 120000, 'the redo to finish');
    A.ok(d2b && d2b.plan.createdAt === d2.plan.createdAt, 'the redo did not re-plan the design');
    A.ok(d2b && d2b.variants.find(v => v.productId === 'tee-front').madeAt > d2.variants.find(v => v.productId === 'tee-front').madeAt && d2b.variants.find(v => v.productId === 'sticker-4x4').madeAt === d2.variants.find(v => v.productId === 'sticker-4x4').madeAt, 'only the tee was remade; the sticker\'s file is the same one');
    A.eq(d2b && d2b.mockups.length, 2, 'and it is mocked up again');

    /* ---- 7. BUDGET: the day's limit stops new work, and says so ---- */
    const spentToday = (await designs()).reduce((n, d) => n + (d.spendUsd || 0), 0);
    A.ok(spentToday > 0.3, 'fixture: the line has really spent today ($' + spentToday.toFixed(2) + ')');
    const tight = artFloor(studio, { maxUsdPerDay: 0.05 });
    A.eq(tight.lines[0].limits.maxUsdPerDay, 0.05, 'the owner lowers the day limit to 5 cents');
    A.eq((await fetch(B + '/api/routing', { method: 'POST', headers, body: JSON.stringify(tight) })).status, 200, 'and redeploys');
    const callsBefore = mock.S.requests.length;
    fs.writeFileSync(path.join(drop, 'Over budget.png'), designPng(3));
    const blocked = await waitFor(async () => { const t = (await triggers()).find(x => x.id === tid); const s = JSON.stringify([t && t.lastError, t && t.lastOutcome, t && t.blockedBy]); return /daily limit|budget|limit/i.test(s) && !/Second|redo/i.test(String(t.lastOutcome && t.lastOutcome.source)) ? t : null; }, 30000, 'the over-budget drop to be stopped');
    A.ok(blocked, 'the drop was stopped by the line\'s daily limit: ' + JSON.stringify(blocked && [blocked.lastError, blocked.lastOutcome, blocked.blockedBy]));
    await sleep(1500);
    A.ok(mock.S.requests.length - callsBefore <= 1, 'and no further model calls were paid for (' + (mock.S.requests.length - callsBefore) + ')');
    const ob = (await designs()).find(d => d.source.originalName === 'Over budget.png');
    A.ok(!ob || ob.variants.length === 0, 'no print file was made for it');
  } finally {
    await stop(child);
    try { mock.server.close(); } catch (_) {}
    await sleep(150);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  A.report('art-line.e2e.test');
})().catch(e => { console.log('FAIL: art-line.e2e.test threw - ' + (e && e.stack || e)); process.exit(1); });
