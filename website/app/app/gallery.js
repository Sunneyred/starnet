/* frontend/app/gallery.js — the GALLERY's readings (Art Studio Phase 5).

   The Gallery window (windows/gallery.js) shows the owner what the art line did with each dropped design and asks
   for their decision. Everything it SAYS is computed here, from two sources only:
     · the design records the sidecar serves (GET /api/art/designs — design-store.js), and
     · the live floor + the sidecar's own trigger / grant listings (for the setup checklist).
   No sentence here is a guess about work in progress: a design's state is its record's status, and "working now"
   is said only when the line's trigger reports it is running.

   PURE, zero-dep, UMD (the workflowline.js idiom): params in, plain data and HTML strings out, no DOM, no clock,
   no fetch — so test/gallery.test.js can hold every sentence to the truthful-telemetry law.

     artLines(station, Pipeline)     -> the art lines on the floor, each with what its steps can really do
     setupSteps(facts)               -> the ordered setup checklist; each step's done-ness is a fact, not a hope
     designView(design, products)    -> one design, grouped by product, in the words the card shows
     setupHtml / designHtml / pageHtml -> the markup (escaped; data-act attributes carry the actions) */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.Gallery = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ART_ROLES = ['STRATEGIST', 'DESIGNER', 'INSPECTOR', 'MOCKUP'];
  const ROLE_WORD = { STRATEGIST: 'picks the products', DESIGNER: 'makes the print files', INSPECTOR: 'checks them', MOCKUP: 'renders the mockups' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '$' + (Number(n) || 0).toFixed(2);

  /* ---------- the floor: which lines are art lines, and can their steps do the work? ----------
     An art line is a compiled line that has a step of each of the four art roles. For each step: who crews it, and
     whether that agent's room really grants COMPUTE (a workstation) and IMAGES (a STUDIO object) — the same
     station.bayObjects the sidecar's grants are built from. A step without a STUDIO cannot call one art tool. */
  function artLines(station, Pipeline) {
    if (!station || !Pipeline || typeof station.projectGeometry !== 'function') return [];
    let plan;
    try { plan = Pipeline.compileRoutingPlan(station.projectGeometry()); } catch (e) { return []; }
    const out = [];
    // crewed lines come compiled; an uncrewed art line is not a line of the plan yet, so the floor's own props are read too
    const props = typeof station.props === 'function' ? station.props() : [];
    const byId = {}; for (const p of props) byId[p.id] = p;
    const seen = {};
    const lines = (plan && Array.isArray(plan.lines)) ? plan.lines : [];
    for (const l of lines) {
      const mine = (l.propIds || []).map(id => byId[id]).filter(Boolean);
      const bays = mine.filter(p => p.t === 'bay');
      if (!ART_ROLES.every(r => bays.some(b => b.role === r))) continue;
      const intake = mine.find(p => p.t === 'intake'); if (!intake) continue;
      for (const p of mine) seen[p.id] = 1;
      out.push(describe(station, { lineId: String(l.lineId), intake, bays, limits: l.limits || intake.limits || null, projectRoot: l.projectRoot || intake.projectRoot || '', name: l.name || intake.label || 'ART LINE', compiled: true }));
    }
    // an art INBOX whose bays are not all crewed yet: found by its stamped roles sitting on the floor, uncompiled
    const looseBays = props.filter(p => p.t === 'bay' && !seen[p.id] && ART_ROLES.indexOf(p.role) >= 0);
    if (!out.length && ART_ROLES.every(r => looseBays.some(b => b.role === r))) {
      const intake = props.filter(p => p.t === 'intake' && !seen[p.id]).sort((a, b) => dist(a, looseBays[0]) - dist(b, looseBays[0]))[0];
      if (intake) out.push(describe(station, { lineId: String(intake.id), intake, bays: ART_ROLES.map(r => looseBays.find(b => b.role === r)), limits: intake.limits || null, projectRoot: intake.projectRoot || '', name: intake.label || 'ART LINE', compiled: false }));
    }
    return out;
  }
  const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  function describe(station, l) {
    const steps = ART_ROLES.map(role => {
      const b = l.bays.find(x => x && x.role === role) || null;
      let objects = [];
      if (b && b.agentId && typeof station.bayObjects === 'function') { try { objects = station.bayObjects(b.agentId, b.id) || []; } catch (e) { objects = []; } }
      return { role, bayId: b ? b.id : null, agentId: (b && b.agentId) || '', hasCompute: objects.indexOf('computer') >= 0, hasStudio: objects.indexOf('studio') >= 0, hasBrief: !!(b && b.brief) };
    });
    return { lineId: l.lineId, intakeId: l.intake.id, name: l.name, projectRoot: l.projectRoot, limits: l.limits, compiled: l.compiled, steps,
      crewed: steps.every(s => s.agentId), canWork: steps.every(s => s.agentId && s.hasCompute && s.hasStudio) };
  }

  /* ---------- setup: six facts, in the order they have to become true ----------
     facts = { line: artLines()[0] | null, triggers: GET /api/routing/triggers .triggers | null (null = not read),
               grants: GET /api/art/designs .grants | null, agentName: id -> name }
     Each step: { id, title, done, detail, act?: { id, label }, blocked?: bool }. `done` is only ever true on a fact. */
  function setupSteps(facts) {
    const f = facts || {}, line = f.line || null, nameOf = typeof f.agentName === 'function' ? f.agentName : (id => id);
    const steps = [];
    steps.push(line
      ? { id: 'line', title: 'The art line is on your floor', done: true, detail: line.name + ' — four steps: ' + ART_ROLES.map(r => r.toLowerCase()).join(' → ') + '.' }
      : { id: 'line', title: 'Put the art line on your floor', done: false, detail: 'Four steps in a row: one agent picks the products, one makes the print files, one checks them, one renders the mockups.', act: { id: 'place', label: 'PLACE THE ART LINE' } });
    if (!line) return steps.concat(later(['crew', 'folders', 'grant', 'trigger']));

    const unstaffed = line.steps.filter(s => !s.agentId), noDesk = line.steps.filter(s => s.agentId && !s.hasCompute), noStudio = line.steps.filter(s => s.agentId && !s.hasStudio);
    if (unstaffed.length) steps.push({ id: 'crew', title: 'Give every step an agent', done: false, detail: 'No agent yet on: ' + unstaffed.map(s => s.role).join(', ') + '. One agent can do all four.', act: { id: 'crew', label: 'USE MY MAIN AGENT FOR ALL FOUR' } });
    else if (noDesk.length) steps.push({ id: 'crew', title: 'Give the agent a workstation', done: false, detail: uniq(noDesk.map(s => nameOf(s.agentId))).join(', ') + ' has no desk, so it cannot run. ', act: { id: 'desk', label: 'GIVE IT A DESK' } });
    else if (noStudio.length) steps.push({ id: 'crew', title: 'Put a STUDIO in the agent\'s room', done: false, detail: 'The art tools come from a STUDIO object in the room where ' + uniq(noStudio.map(s => nameOf(s.agentId))).join(', ') + ' has its desk. That room has none, so these steps could not make a single file: ' + noStudio.map(s => s.role).join(', ') + '. Add a STUDIO there in Build Mode.', act: { id: 'build', label: 'OPEN BUILD MODE' } });
    else steps.push({ id: 'crew', title: 'Every step has an agent that can do it', done: true, detail: uniq(line.steps.map(s => nameOf(s.agentId))).join(', ') + ' — with a workstation and a STUDIO in reach.' });

    const trg = Array.isArray(f.triggers) ? f.triggers.filter(t => t && t.kind === 'folder' && String(t.lineId) === String(line.lineId) && t.config && t.config.intake === 'design') : null;
    const t = trg && trg[0];
    if (!line.projectRoot || (trg && !t)) steps.push({ id: 'folders', title: 'Choose where your art lives', done: false,
      detail: line.projectRoot ? 'The line works in ' + line.projectRoot + ', but nothing is watching a drop folder yet.' : 'Pick one folder. Two folders are made inside it: "Drop designs here" (your originals — never changed) and "Studio files" (copies, print files, mockups, exports).',
      act: { id: 'folders', label: 'CHOOSE A FOLDER' } });
    else if (!trg) steps.push({ id: 'folders', title: 'Choose where your art lives', done: false, detail: 'Checking the drop folder…', blocked: true });
    else steps.push({ id: 'folders', title: 'Your folders are set', done: true, detail: 'Drop designs in: ' + t.config.path + '\nThe line works in: ' + line.projectRoot });

    const g = f.grants;
    if (!g) steps.push({ id: 'grant', title: 'Let the line save its files', done: false, detail: 'Checking…', blocked: true });
    else if (g.artWrite) steps.push({ id: 'grant', title: 'The line may save print files and mockups on its own', done: true, detail: 'Only that. It cannot post, list, message, spend outside its budget, or run programs. You can take this back in Permissions.' });
    else steps.push({ id: 'grant', title: 'Let the line save its files', done: false, detail: 'When you are not watching, agents may not save files unless you say so. This allows ONE thing: saving print files and mockups into the studio folder. Nothing else — no posting, no listing, no messages.', act: { id: 'grant', label: 'ALLOW SAVING PRINT FILES AND MOCKUPS' } });

    if (!t) steps.push({ id: 'trigger', title: 'Switch the drop folder on', done: false, detail: 'Comes after the folders.', blocked: true });
    else if (t.blockedBy) steps.push({ id: 'trigger', title: 'The drop folder is blocked', done: false, detail: 'The station says: ' + t.blockedBy });
    else if (!t.enabled) steps.push({ id: 'trigger', title: 'Switch the drop folder on', done: false, detail: 'It is off: designs you drop will wait.', act: { id: 'enable', label: 'SWITCH IT ON', arg: t.id } });
    else steps.push({ id: 'trigger', title: 'The drop folder is on', done: true, detail: budgetWord(line.limits) + ' Files already in the folder when it was switched on are left alone.', act: { id: 'disable', label: 'PAUSE', arg: t.id, quiet: true } });
    return steps;
  }
  const later = ids => ids.map(id => ({ id, title: { crew: 'Give every step an agent', folders: 'Choose where your art lives', grant: 'Let the line save its files', trigger: 'Switch the drop folder on' }[id], done: false, detail: '', blocked: true }));
  const uniq = a => a.filter((v, i) => a.indexOf(v) === i);
  function budgetWord(lim) {
    if (!lim) return 'This line has NO spending limit of its own (the station defaults apply).';
    const parts = [];
    if (lim.maxUsdPerDay != null) parts.push(money(lim.maxUsdPerDay) + ' a day');
    if (lim.maxUsdPerMessage != null) parts.push(money(lim.maxUsdPerMessage) + ' a design');
    return 'Spending limit: ' + (parts.join(', ') || 'station defaults') + ' at most.';
  }
  const setupReady = steps => steps.every(s => s.done);
  function triggerOf(facts) {
    const line = facts && facts.line; if (!line || !Array.isArray(facts.triggers)) return null;
    return facts.triggers.find(t => t && t.kind === 'folder' && String(t.lineId) === String(line.lineId) && t.config && t.config.intake === 'design') || null;
  }

  /* ---------- one design ---------- */
  const STATUS = {
    'new': ['TAKEN', 'Copied in. No product plan recorded yet.'],
    planned: ['PLANNED', 'Products are chosen. No print file recorded yet.'],
    adapting: ['PRINT FILES', 'Print files are being made — some may be missing below.'],
    reviewing: ['CHECKING', 'Print files are made and being checked.'],
    mocking: ['MOCKUPS', 'Checked. Mockups are not all recorded yet.'],
    ready: ['READY FOR YOU', 'Every print file has a mockup. Your decision is next.'],
    approved: ['DECIDED', 'You have decided on every product.'],
    rejected: ['REJECTED', 'You rejected every product.'],
    failed: ['FAILED', 'The line could not finish this design.']
  };
  const REVIEW = { pass: 'checked: passed', redo: 'checked: sent back for a redo', 'needs-owner': 'checker was not satisfied after 2 redos — look closely' };
  /* designView -> { id, name, status:{word,says}, thumb, sizeWord, spendWord, analysis, products:[…], skipped:[…], errors:[…],
                     rightsConfirmed, canExport, exportWhy } — one row per PLANNED product, in the plan's rank order. */
  function designView(d, products) {
    const plist = Array.isArray(products) ? products : [];
    const label = id => { const p = plist.find(x => x.id === id); return (p && p.label) || id; };
    const verified = id => { const p = plist.find(x => x.id === id); return p ? p.verified === true : null; };
    const st = STATUS[d.status] || [String(d.status || '').toUpperCase(), ''];
    const rows = ((d.plan && d.plan.products) || []).map((p, i) => {
      const vs = (d.variants || []).filter(v => v.productId === p.productId);
      const v = vs[0] || null;
      const ms = (d.mockups || []).filter(m => m.productId === p.productId);
      const ap = (d.approvals || {})[p.productId] || null;
      return { productId: p.productId, label: label(p.productId), rank: i + 1, score: p.score, why: p.why || '', fabric: p.fabricId || (v && v.fabricId) || null,
        unverified: verified(p.productId) === false,
        print: v ? { path: v.path, preview: v.previewPath || null, sizeWord: v.width + ' × ' + v.height + ' px', dpiWord: v.effectiveDpi ? 'prints at ' + v.effectiveDpi + ' dpi' : '', upscaled: !!v.upscaled,
          review: v.review ? (REVIEW[v.review.verdict] || v.review.verdict) : 'not checked yet', reviewNotes: (v.review && v.review.notes) || '', needsOwner: !!(v.review && v.review.verdict === 'needs-owner'), steps: v.steps || [] } : null,
        mockups: ms.map(m => ({ path: m.path, templateId: m.templateId })),
        decision: ap ? ap.decision : null, decisionNote: ap ? ap.note || '' : '',
        canDecide: !!v };
    });
    const skipped = ((d.plan && d.plan.skipped) || []).map(k => ({ label: label(k.productId), by: k.by === 'designer' ? 'could not be made' : 'ruled out', reason: k.reason || '' }));
    const approved = rows.filter(r => r.decision === 'approved').length;
    const src = d.source || {};
    return { id: d.id, name: src.originalName || d.id, status: { key: d.status, word: st[0], says: st[1] }, thumb: src.previewRel || src.storedRel || null,
      sizeWord: (src.width || '?') + ' × ' + (src.height || '?') + ' px',
      // spend is said only when it was summed from real runs; otherwise the card says it is not known
      spendWord: d.spendFromRuns ? money(d.spendUsd) + ' spent on this design (' + d.runCount + ' run' + (d.runCount === 1 ? '' : 's') + ')' : (d.runCount ? 'spend not known yet' : 'no run has worked on this yet'),
      analysis: d.analysis ? d.analysis.summary || '' : '', basis: (d.plan && d.plan.basis) || '',
      products: rows, skipped, errors: (d.errors || []).slice(-3).map(e => ({ stage: e.stage, message: e.message })),
      rightsConfirmed: d.rightsConfirmed === true, approvedCount: approved,
      // stopped part-way (the record is not at a finished status). Whether the line is busy with it right now is the page's to say.
      stopped: ['new', 'planned', 'adapting', 'reviewing', 'mocking'].indexOf(d.status) >= 0,
      canExport: d.rightsConfirmed === true && approved > 0,
      exportWhy: approved === 0 ? 'Approve at least one product first.' : (d.rightsConfirmed === true ? '' : 'Tick the rights box first.') };
  }

  /* ---------- markup ---------- */
  const btn = (act, label, extra) => '<button type="button" class="bb sm' + ((extra && extra.cls) ? ' ' + extra.cls : '') + '" data-act="' + esc(act) + '"' +
    Object.keys((extra && extra.data) || {}).map(k => ' data-' + k + '="' + esc(extra.data[k]) + '"').join('') + ((extra && extra.disabled) ? ' disabled' : '') + ((extra && extra.pressed != null) ? ' aria-pressed="' + !!extra.pressed + '"' : '') + '>' + esc(label) + '</button>';
  const img = (design, path, alt, cls) => path ? '<span class="gal-img ' + (cls || '') + '" data-design="' + esc(design) + '" data-path="' + esc(path) + '" role="img" aria-label="' + esc(alt) + '"></span>' : '';

  function setupHtml(steps, msg, folderDraft) {
    const ready = setupReady(steps);
    const rows = steps.map((s, i) => '<li class="gal-step' + (s.done ? ' done' : '') + (s.blocked ? ' blocked' : '') + '" data-step="' + esc(s.id) + '">' +
      '<div class="gal-step-hd"><span class="gal-step-n">' + (s.done ? '✓' : String(i + 1)) + '</span><span class="gal-step-t">' + esc(s.title) + '</span></div>' +
      (s.detail ? '<div class="gal-step-d dim">' + esc(s.detail).replace(/\n/g, '<br>') + '</div>' : '') +
      (s.id === 'folders' && s.act ? '<div class="gal-row"><input type="text" class="gal-folder" id="gal-folder" placeholder="Full folder path, or use CHOOSE" value="' + esc(folderDraft || '') + '" aria-label="Folder path">' + btn('pick', 'CHOOSE…') + btn('folders', 'SET UP FOLDERS') + '</div>' : '') +
      (s.act && s.id !== 'folders' && !s.blocked ? '<div class="gal-row">' + btn(s.act.id, s.act.label, { data: s.act.arg ? { arg: s.act.arg } : {} }) + '</div>' : '') +
      '</li>').join('');
    return '<section class="gal-setup' + (ready ? ' ready' : '') + '"><div class="gx-sec"><span class="gx-title">' + (ready ? 'SET UP' : 'SET UP — ' + steps.filter(s => s.done).length + ' OF ' + steps.length + ' DONE') + '</span></div>' +
      '<ol class="gal-steps">' + rows + '</ol>' + (msg ? '<p class="gal-msg' + (msg.bad ? ' bad' : '') + '" role="status">' + esc(msg.text) + '</p>' : '') + '</section>';
  }

  function designHtml(v, st) {
    const s = st || {};
    const prod = p => {
      const dec = p.decision;
      return '<div class="gal-prod' + (dec ? ' ' + esc(dec) : '') + '" data-product="' + esc(p.productId) + '">' +
        '<div class="gal-prod-hd"><span class="gal-prod-n">#' + p.rank + ' ' + esc(p.label) + (p.fabric ? ' · ' + esc(p.fabric) : '') + '</span>' +
        '<span class="gx-tag" title="The agent\'s own judgement of how well this design suits the product. Not sales data.">FIT ' + esc(p.score) + '/100</span>' +
        (p.unverified ? '<span class="gx-tag warn" title="This product\'s print size is a planning figure that has not been checked against a print provider. Check it before you sell.">SIZE NOT VERIFIED</span>' : '') + '</div>' +
        (p.why ? '<div class="gal-why">' + esc(p.why) + '</div>' : '') +
        (p.print
          ? '<div class="gal-shots">' + img(v.id, p.print.preview || p.print.path, 'Print file for ' + p.label, 'print') + p.mockups.map(m => img(v.id, m.path, 'Mockup of ' + p.label, 'mock')).join('') + '</div>' +
            '<div class="dim gal-facts">Print file: ' + esc(p.print.sizeWord) + (p.print.dpiWord ? ', ' + esc(p.print.dpiWord) : '') + (p.print.upscaled ? ' (enlarged from your file)' : '') + ' · ' + esc(p.print.review) +
              (p.mockups.length ? '' : ' · no mockup recorded yet') + '</div>' +
            (p.print.reviewNotes ? '<div class="dim gal-facts">Checker\'s note: ' + esc(p.print.reviewNotes) + '</div>' : '') +
            '<div class="dim gal-facts">' + esc(p.print.path) + '</div>'
          : '<div class="dim gal-facts">No print file recorded for this product yet.</div>') +
        (p.canDecide
          ? '<div class="gal-row">' + btn('approve', dec === 'approved' ? '✓ APPROVED' : 'APPROVE', { data: { design: v.id, product: p.productId }, pressed: dec === 'approved' }) +
              btn('reject', dec === 'rejected' ? '✕ REJECTED' : 'REJECT', { data: { design: v.id, product: p.productId }, pressed: dec === 'rejected' }) +
              btn('redo', 'SEND BACK…', { data: { design: v.id, product: p.productId } }) + '</div>' +
            (s.redo === p.productId ? '<div class="gal-row"><input type="text" class="gal-note" id="gal-note-' + esc(v.id) + '" maxlength="400" placeholder="What should change? (the designer reads this)" aria-label="What should change">' +
              btn('redo-send', 'SEND BACK AND REDO', { data: { design: v.id, product: p.productId } }) + '</div><div class="dim gal-facts">Sending back runs the line again for this product, inside the line\'s spending limit.</div>' : '') +
            (dec === 'redo' ? '<div class="dim gal-facts">You sent this back' + (p.decisionNote ? ': “' + esc(p.decisionNote) + '”' : '') + '.</div>' : '')
          : '') +
        '</div>';
    };
    return '<article class="gal-card" data-design="' + esc(v.id) + '">' +
      '<header class="gal-card-hd">' + img(v.id, v.thumb, 'Your design ' + v.name, 'thumb') +
        '<div class="gal-card-meta"><div class="gal-name">' + esc(v.name) + '</div>' +
        '<div><span class="gx-tag st-' + esc(v.status.key) + '">' + esc(v.status.word) + '</span> <span class="dim">' + esc(v.status.says) + '</span></div>' +
        '<div class="dim gal-facts">' + esc(v.sizeWord) + ' · ' + esc(v.spendWord) + ' · ' + esc(v.id) + '</div>' +
        (v.analysis ? '<div class="gal-why">What the agent saw: ' + esc(v.analysis) + '</div>' : '') + '</div></header>' +
      (v.stopped && !s.lineBusy ? '<div class="gal-stopped"><span>This design stopped before it was finished, and the line is not working on anything now.</span>' +
        '<div class="gal-row">' + btn('resume', 'CARRY ON WITH THIS DESIGN', { data: { design: v.id } }) + '<span class="dim">Runs the line again for what is still missing, inside its spending limit.</span></div></div>' : '') +
      (v.errors.length ? '<div class="gal-errors">' + v.errors.map(e => '<div>⚠ ' + esc(e.stage) + ': ' + esc(e.message) + '</div>').join('') + '</div>' : '') +
      (v.products.length ? '<div class="dim gal-facts">Products are ranked by the agent\'s judgement of fit. It is not a sales forecast.</div>' : '') +
      v.products.map(prod).join('') +
      (v.skipped.length ? '<div class="dim gal-facts">Not made: ' + v.skipped.map(k => esc(k.label) + ' (' + esc(k.by) + ': ' + esc(k.reason) + ')').join('; ') + '</div>' : '') +
      (v.products.some(p => p.canDecide)
        ? '<footer class="gal-card-ft"><label class="gal-rights"><input type="checkbox" data-act="rights" data-design="' + esc(v.id) + '"' + (v.rightsConfirmed ? ' checked' : '') + '> I made this, or I have the commercial rights to everything in it.</label>' +
          '<div class="gal-row">' + btn('export', 'EXPORT APPROVED PRODUCTS', { data: { design: v.id }, disabled: !v.canExport }) + (v.exportWhy ? '<span class="dim">' + esc(v.exportWhy) + '</span>' : '') + '</div>' +
          (s.exported ? '<div class="gal-facts">Copied to ' + esc(s.exported.folder) + ' (' + s.exported.written.length + ' file' + (s.exported.written.length === 1 ? '' : 's') + '). Nothing was published or uploaded.' +
            (s.exported.problems.length ? ' Problems: ' + esc(s.exported.problems.join('; ')) : '') + '</div>' : '') +
          (s.msg ? '<p class="gal-msg' + (s.msg.bad ? ' bad' : '') + '" role="status">' + esc(s.msg.text) + '</p>' : '') + '</footer>'
        : (s.msg ? '<p class="gal-msg' + (s.msg.bad ? ' bad' : '') + '" role="status">' + esc(s.msg.text) + '</p>' : '')) +
      '</article>';
  }

  /* the whole page. state = { steps, setupMsg, folderDraft, designs:[record], products, cards:{id:{redo,exported,msg}}, trigger, loadError, showSetup } */
  function pageHtml(state) {
    const s = state || {}, steps = s.steps || [], ready = setupReady(steps);
    const t = s.trigger || null;
    const busy = !!(t && (t.running || t.queued));
    const list = (s.designs || []).map(d => designHtml(designView(d, s.products), Object.assign({ lineBusy: busy }, (s.cards || {})[d.id]))).join('');
    const live = t && t.running ? '<p class="gal-live" role="status">The line is working on a drop right now. This page updates as each step is recorded.</p>'
      : (t && t.queued ? '<p class="gal-live" role="status">' + esc(String(t.queued)) + ' drop' + (t.queued === 1 ? ' is' : 's are') + ' waiting for the line.</p>' : '');
    const last = t && t.lastError ? '<p class="gal-msg bad" role="status">Last drop: ' + esc(t.lastError) + '</p>' : '';
    return '<div class="gal">' +
      '<p class="dim">Drop a design in your drop folder. The art line picks products, makes print files, checks them and renders mockups — then it waits here for you. Nothing is posted or listed anywhere.</p>' +
      (s.loadError ? '<p class="gal-msg bad" role="alert">' + esc(s.loadError) + '</p>' : '') +
      ((!ready || s.showSetup) ? setupHtml(steps, s.setupMsg, s.folderDraft) : '<div class="gal-row gal-ready"><span class="gx-tag">SET UP ✓</span>' + btn('toggle-setup', 'SHOW SETUP') + btn('open-drop', 'WHERE DO I DROP FILES?') + '</div>' + (s.setupMsg ? '<p class="gal-msg' + (s.setupMsg.bad ? ' bad' : '') + '" role="status">' + esc(s.setupMsg.text) + '</p>' : '')) +
      live + last +
      '<div class="gx-sec"><span class="gx-title">YOUR DESIGNS</span> <span class="gx-tag">' + (s.designs || []).length + '</span></div>' +
      (list || '<p class="dim gal-empty">' + (ready ? 'Nothing here yet. Save a PNG or JPEG into your drop folder and it will appear.' : 'Finish the setup above, then drop your first design.') + '</p>') +
      '</div>';
  }

  return { ART_ROLES, ROLE_WORD, artLines, setupSteps, setupReady, triggerOf, budgetWord, designView, setupHtml, designHtml, pageHtml, STATUS, esc };
});
