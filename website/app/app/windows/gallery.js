/* windows/gallery.js — the GALLERY window (Art Studio Phase 5).

   Draws what app/gallery.js says, and carries the owner's clicks to the routes that already own each change:
     designs / images / approve / rights / export  -> /api/art/*            (sidecar/art/gallery-routes.js)
     the two folders                               -> POST /api/art/setup    (then the INBOX's own working-folder field)
     the drop folder trigger                       -> /api/routing/triggers  (the Workflow panel's own route)
     the one grant                                 -> POST /api/permissions/grant { key: 'art:write' }
     placing / crewing the line                    -> LineEdit.placeBlueprint + the station's own validated mutators
   It keeps no truth of its own: after every click it reads the facts again and repaints from them. A step is shown
   done only when the re-read says so; a click that was refused shows the refusal's own words.

   Loads AFTER stationui.js and app/gallery.js (see index.html); registers via StationUI.registerWindow. */
'use strict';
(() => {
  if (typeof StationUI === 'undefined' || !StationUI.registerWindow || typeof Gallery === 'undefined') return;
  const H = StationUI.h, G = Gallery;
  const POLL_MS = 4000;
  const S = { body: null, timer: null, designs: [], products: [], grants: null, triggers: null, loadError: '', setupMsg: null, folderDraft: '', cards: {}, showSetup: false, busy: false, urls: {}, lastHtml: '' };

  const stationOf = () => { try { return (typeof App !== 'undefined' && App.station) ? App.station() : null; } catch (_) { return null; } };
  const api = () => (typeof Harness !== 'undefined' && Harness.api) ? Harness.api : null;
  const sfx = n => { try { if (H.sfx) H.sfx(n); } catch (_) { /* sound is optional */ } };
  const agentName = id => { try { return (typeof App !== 'undefined' && App.agentName && App.agentName(id)) || id; } catch (_) { return id; } };
  const heroId = () => { try { return (typeof App !== 'undefined' && App.heroId) ? App.heroId() : 'agent'; } catch (_) { return 'agent'; } };
  const syncPlan = () => { try { if (typeof World !== 'undefined' && World.syncPlan) World.syncPlan(); } catch (_) { /* the floor syncs on its own timer too */ } };
  const lineNow = () => { const st = stationOf(); return (st && typeof Pipeline !== 'undefined') ? (G.artLines(st, Pipeline)[0] || null) : null; };
  const alive = () => !!(S.body && S.body.isConnected);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const errText = (r, fallback) => (r && r.j && (r.j.error || r.j.reason)) || fallback;

  /* ---------- reading the facts ---------- */
  function refresh() {
    const a = api(); if (!a) { S.loadError = 'The station is not reachable.'; paint(); return Promise.resolve(); }
    return Promise.all([
      a.get('/api/art/designs').then(j => { S.designs = j.designs || []; S.products = j.products || []; S.grants = j.grants || null; S.loadError = j.catalogOverrideError ? 'Your product list file has a problem, so the built-in list is in use: ' + j.catalogOverrideError : ''; },
        e => { S.loadError = 'The design list could not be read (' + String((e && e.message) || e) + ').'; }),
      a.get('/api/routing/triggers').then(j => { S.triggers = j.triggers || []; }, () => { S.triggers = null; })
    ]).then(paint);
  }
  function facts() { return { line: lineNow(), triggers: S.triggers, grants: S.grants, agentName }; }

  /* ---------- painting ---------- */
  function paint() {
    if (!alive()) return stop();
    const f = facts(), steps = G.setupSteps(f);
    const html = G.pageHtml({ steps, setupMsg: S.setupMsg, folderDraft: S.folderDraft, designs: S.designs, products: S.products, cards: S.cards, trigger: G.triggerOf(f), loadError: S.loadError, showSetup: S.showSetup });
    if (html === S.lastHtml) return;   // nothing changed: leave the page (and anything being typed) alone
    const a = document.activeElement, keep = (a && S.body.contains(a) && a.id) ? { id: a.id, v: a.value } : null;
    const scroller = S.body.closest('.term-body') || S.body, top = scroller.scrollTop;
    S.lastHtml = html; S.body.innerHTML = html;
    wire(); loadImages();
    scroller.scrollTop = top;
    if (keep) { const n = document.getElementById(keep.id); if (n) { n.value = keep.v; n.focus(); } }
  }
  // images ride the token-carrying fetch, then show as blobs (an <img src> to the sidecar would carry no launch token)
  function loadImages() {
    S.body.querySelectorAll('.gal-img').forEach(el => {
      const key = el.dataset.design + '|' + el.dataset.path;
      const show = url => { el.style.backgroundImage = 'url("' + url + '")'; el.classList.add('ready'); };
      if (S.urls[key]) return show(S.urls[key]);
      fetch('/api/art/file?design=' + encodeURIComponent(el.dataset.design) + '&path=' + encodeURIComponent(el.dataset.path), { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.blob(); })
        .then(b => { S.urls[key] = URL.createObjectURL(b); if (el.isConnected) show(S.urls[key]); })
        .catch(() => { el.classList.add('missing'); el.textContent = 'image not available'; });
    });
    S.body.querySelectorAll('.gal-img').forEach(el => { el.onclick = () => { const u = S.urls[el.dataset.design + '|' + el.dataset.path]; if (u) zoom(u, el.getAttribute('aria-label') || ''); }; });
  }
  function zoom(url, label) {
    const d = document.createElement('div'); d.className = 'gal-zoom'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', label);
    const i = document.createElement('img'); i.src = url; i.alt = label; d.appendChild(i);
    d.onclick = () => d.remove();
    document.body.appendChild(d);
  }

  /* ---------- the clicks ---------- */
  const card = id => (S.cards[id] = S.cards[id] || {});
  const say = (text, bad) => { S.setupMsg = { text, bad: !!bad }; sfx(bad ? 'bad' : 'click'); };
  function wire() {
    S.body.querySelectorAll('[data-act]').forEach(el => {
      const act = el.dataset.act, run = () => { if (S.busy) return; const fn = ACTS[act]; if (fn) Promise.resolve(fn(el)).then(() => { S.busy = false; paint(); }, e => { S.busy = false; say(String((e && e.message) || e), true); paint(); }); };
      if (el.tagName === 'INPUT' && el.type === 'checkbox') el.onchange = run; else el.onclick = run;
    });
    const fd = S.body.querySelector('#gal-folder'); if (fd) fd.oninput = () => { S.folderDraft = fd.value; };
  }
  const post = (path, body, method) => method
    ? fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json().catch(() => null).then(j => ({ ok: r.ok, status: r.status, j })))
    : api().post(path, body);

  const ACTS = {
    'toggle-setup': () => { S.showSetup = !S.showSetup; },
    'open-drop': () => { const t = G.triggerOf(facts()); say(t ? 'Save your designs (PNG or JPEG) into: ' + t.config.path : 'No drop folder is set yet.', !t); },

    /* the line: laid by the Build Library's own placement, with its shipped instructions; the budget rides in the blueprint */
    place: () => {
      const st = stationOf();
      if (!st || typeof LineEdit === 'undefined' || !LineEdit.placeBlueprint) return say('The floor is not ready yet. Try again in a moment.', true);
      const briefs = {}; if (typeof WorkflowLine !== 'undefined') for (const r of G.ART_ROLES) { const d = WorkflowLine.defaultBrief(r); if (d) briefs[r] = d; }
      let near = null; try { const b = st.bounds(); near = { x: (b.minTx + b.maxTx) >> 1, y: (b.minTy + b.maxTy) >> 1 }; } catch (_) { near = null; }
      const r = LineEdit.placeBlueprint(st, 'art_line', near, { stamp: { briefs } });
      if (!r || !r.ok) return say(r && r.error === 'NO_ROOM' ? 'There is no clear floor big enough for the art line' + (r.needs ? ' (it needs ' + r.needs.w + ' × ' + r.needs.h + ' tiles)' : '') + '. Add a room in Build Mode, then try again.' : 'The art line could not be placed: ' + ((r && (r.msg || r.error)) || 'no clear floor for it') + '.', true);
      crewAll(st, (r.ids || []).map(id => st.propById(id)).filter(p => p && p.t === 'bay'));
      syncPlan(); say('The art line is on your floor.');
    },
    crew: () => { const st = stationOf(), l = lineNow(); if (!st || !l) return; crewAll(st, l.steps.filter(s => !s.agentId).map(s => st.propById(s.bayId)).filter(Boolean)); syncPlan(); },
    desk: () => {
      const st = stationOf(), l = lineNow(); if (!st || !l) return;
      for (const s of l.steps) if (s.agentId && !s.hasCompute) { try { if (st.ensureWorkstation) st.ensureWorkstation(s.agentId); } catch (_) { /* the re-read below says whether it worked */ } }
      syncPlan();
      const again = lineNow();
      if (again && again.steps.some(s => s.agentId && !s.hasCompute)) say('A desk could not be placed automatically. Add one for this agent in Build Mode.', true);
    },
    build: () => { const l = lineNow(), s = l && l.steps.find(x => x.agentId && !x.hasStudio); if (H.placeGearForSkill) H.placeGearForSkill('studio', s ? agentName(s.agentId) : ''); else say('Open Build Mode and place a STUDIO in the agent\'s room.', true); },

    pick: () => { S.busy = true; say('Choose a folder in the window that just opened…');
      return fetch('/api/projects/pickfolder', { method: 'POST' }).then(r => r.json().catch(() => null)).then(j => {
        if (j && j.ok && j.path) { S.folderDraft = String(j.path); say('Folder chosen. Press SET UP FOLDERS.'); }
        else if (j && j.ok && j.cancelled) say('No folder chosen.');
        else say((j && j.reason) || 'No folder chooser is available here. Type the full folder path instead.', true);
      }, () => say('The station could not be reached.', true)); },

    /* the folders, the line's working folder, then the trigger — each step's real answer is what gets said */
    folders: async () => {
      const st = stationOf(), l = lineNow(), folder = String(S.folderDraft || '').trim();
      if (!st || !l) return say('Place the art line first.', true);
      if (!folder) return say('Choose a folder first (CHOOSE…), or type its full path.', true);
      S.busy = true;
      const su = await api().post('/api/art/setup', { folder });
      if (!su.ok || !su.j || !su.j.ok) return say(errText(su, 'The folders could not be set up.'), true);
      const pr = st.setPropProject(l.intakeId, su.j.studio);
      if (!pr || !pr.ok) return say('The folders were made, but the line could not be pointed at the studio folder: ' + ((pr && (pr.msg || pr.message)) || 'refused'), true);
      syncPlan();
      // the trigger is made against the DEPLOYED floor: give the plan a moment to arrive, and say so if it never does
      let made = null, lastErr = '';
      for (let i = 0; i < 8 && !made; i++) {
        await wait(i ? 900 : 300);
        const now = lineNow(); if (!now) break;
        const r = await api().post('/api/routing/triggers', { kind: 'folder', lineId: now.lineId, name: 'ART DROP', config: { path: su.j.drop, intake: 'design' } });
        if (r.ok && r.j && r.j.ok) made = r.j.trigger; else lastErr = errText(r, 'refused');
        if (r.status === 400 && r.j && r.j.code) break;   // a folder-policy refusal will not change by waiting
      }
      await refresh();
      if (!made) return say('The folders are ready, but the drop folder could not be switched on: ' + lastErr, true);
      say('Folders ready. Drop designs in: ' + su.j.drop);
    },
    grant: async () => { S.busy = true; const r = await api().post('/api/permissions/grant', { key: 'art:write' }); await refresh(); if (!r.ok || !r.j || !r.j.ok) say('That could not be allowed: ' + errText(r, 'refused'), true); else say('Allowed. You can take it back in Permissions.'); },
    enable: el => setEnabled(el.dataset.arg, true),
    disable: el => setEnabled(el.dataset.arg, false),

    /* the owner's decisions */
    approve: el => decide(el, 'approved'),
    reject: el => decide(el, 'rejected'),
    redo: el => { const c = card(el.dataset.design); c.redo = c.redo === el.dataset.product ? null : el.dataset.product; },
    'redo-send': async el => {
      const id = el.dataset.design, c = card(id), note = (document.getElementById('gal-note-' + id) || {}).value || '';
      if (String(note).trim().length < 3) { c.msg = { text: 'Say what should change, so the designer knows.', bad: true }; return; }
      S.busy = true;
      const r = await api().post('/api/art/designs/approve', { design: id, product: el.dataset.product, decision: 'redo', note });
      c.redo = null;
      if (!r.ok || !r.j || !r.j.ok) c.msg = { text: 'Not sent back: ' + errText(r, 'refused'), bad: true };
      else if (r.j.rerun && r.j.rerun.ok) c.msg = { text: 'Sent back. The line has been asked to redo it.' };
      else c.msg = { text: 'Your note is saved, but the line did not start again: ' + ((r.j.rerun && r.j.rerun.error) || 'unknown reason'), bad: true };
      await refresh();
    },
    resume: async el => {
      S.busy = true; const id = el.dataset.design, c = card(id), r = await api().post('/api/art/designs/resume', { design: id });
      c.msg = (r.j && r.j.ok) ? { text: 'The line has been asked to carry on with this design.' } : { text: 'The line did not start: ' + errText(r, 'refused'), bad: true };
      await refresh();
    },
    rights: async el => { S.busy = true; const id = el.dataset.design, r = await api().post('/api/art/designs/rights', { design: id, confirmed: el.checked === true }); if (!r.ok) card(id).msg = { text: 'Not saved: ' + errText(r, 'refused'), bad: true }; await refresh(); },
    export: async el => {
      S.busy = true; const id = el.dataset.design, c = card(id), r = await api().post('/api/art/designs/export', { design: id });
      if (r.j && r.j.ok) { c.exported = { folder: r.j.folder, written: r.j.written || [], problems: r.j.problems || [] }; c.msg = null; sfx('chime'); }
      else c.msg = { text: 'Not exported: ' + errText(r, 'refused') + ((r.j && r.j.problems && r.j.problems.length) ? ' ' + r.j.problems.join('; ') : ''), bad: true };
    }
  };
  function crewAll(st, bays) { const who = heroId(); for (const b of bays) { try { st.assignPropAgent(b.id, who); } catch (_) { /* the re-read shows any step still unstaffed */ } } }
  async function decide(el, decision) {
    S.busy = true; const id = el.dataset.design, c = card(id);
    const r = await api().post('/api/art/designs/approve', { design: id, product: el.dataset.product, decision });
    c.msg = (r.ok && r.j && r.j.ok) ? null : { text: 'Not saved: ' + errText(r, 'refused'), bad: true };
    await refresh();
  }
  async function setEnabled(id, on) {
    S.busy = true; const r = await post('/api/routing/triggers/' + encodeURIComponent(id), { enabled: on }, 'PATCH');
    await refresh();
    if (!r.ok || !r.j || !r.j.ok) say('That did not change: ' + errText(r, 'refused'), true);
  }

  /* ---------- window ---------- */
  function stop() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }
  function build(body) {
    stop(); S.body = body; S.lastHtml = '';
    body.innerHTML = '<div class="gal"><p class="dim">Loading your designs…</p></div>';
    refresh();
    S.timer = setInterval(() => { if (!alive()) return stop(); if (!S.busy) refresh(); }, POLL_MS);
  }
  StationUI.registerWindow('gallery', 'GALLERY', build, {});
})();
