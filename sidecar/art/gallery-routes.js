/* sidecar/art/gallery-routes.js — the Gallery's API (Art Studio Phase 5).

   The Gallery is where the owner sees what the art line did and decides. Every byte it shows comes from the design
   record (design-store.js) or from a file that record names — these handlers add no state of their own.

     GET  /api/art/designs                       every design, newest first, with real spend summed from its runs
     GET  /api/art/file?design=<id>&path=<rel>   one image OF THAT DESIGN (its copy, a print file, a mockup)
     POST /api/art/designs/approve  { design, product, decision: approved|rejected|redo, note? }
     POST /api/art/designs/rights   { design, confirmed }
     POST /api/art/designs/export   { design }   copy approved products to <line folder>/export/…, with a DRAFT listing
     POST /api/art/setup            { folder }   make the two folders an art line needs inside a folder the owner chose

   THE LAWS
   · /api/art/file serves ONLY a path the record lists, resolved inside the design's own line folder (realpath
     checked). It is not a general file reader.
   · Export requires the owner's rights confirmation on that design and at least one approved product. The app
     cannot check image rights; it asks, records the answer, and refuses without it.
   · Nothing here publishes anything. Export writes files into the line's folder and says where.
   · An owner "redo" is recorded first; re-running the line is a separate, reported step (`rerun`), never implied.

   · Setup only makes two folders inside the folder the owner picked and trusts ONE of them (the studio folder the
     line writes to). The drop folder is never trusted for agent writes: originals stay the owner's.

   makeArtRoutes({ store, fs, fsp, path, respondJson, readBody, spendOf?, rerun?, catalog?, grantState?, blessProject?, checkDropFolder? })
     -> { designs, file, approve, rights, exportDesign, setup } */
'use strict';

const { DesignError } = require('./design-store.js');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const slug = s => String(s || '').toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design';

/* the paths a design's record names — the only ones /api/art/file will serve */
function recordPaths(rec) {
  const out = new Set();
  if (rec.source && rec.source.storedRel) out.add(rec.source.storedRel);
  if (rec.source && rec.source.previewRel) out.add(rec.source.previewRel);
  for (const v of rec.variants || []) { if (v.path) out.add(v.path); if (v.previewPath) out.add(v.previewPath); }
  for (const m of rec.mockups || []) if (m.path) out.add(m.path);
  return out;
}

/* A DRAFT listing, composed only from what is on the record (the Strategist's own analysis and reasons). It is a
   starting point for the owner to edit — labelled as such, with the unverified-spec and fit-judgement caveats kept. */
function draftListing(rec, productId, catalog) {
  const p = (rec.plan && rec.plan.products.find(x => x.productId === productId)) || {};
  const cp = catalog ? catalog.get(productId) : null;
  const v = (rec.variants || []).find(x => x.productId === productId) || {};
  const a = rec.analysis || {};
  const lines = ['DRAFT LISTING — written by the art line from its own notes. Edit before you publish anything.', '',
    'Product: ' + ((cp && cp.label) || productId) + (v.fabricId ? ' (' + v.fabricId + ')' : ''),
    'Design: ' + rec.source.originalName + '  [' + rec.id + ']', ''];
  if (p.titleIdeas && p.titleIdeas.length) { lines.push('Title ideas:'); for (const t of p.titleIdeas) lines.push('  - ' + t); lines.push(''); }
  if (a.summary) lines.push('About the design:', '  ' + a.summary, '');
  if (a.subjects && a.subjects.length) lines.push('Subjects / tag ideas: ' + a.subjects.concat(a.palette || []).concat(a.mood ? [a.mood] : []).join(', '), '');
  if (p.why) lines.push('Why this product (the agent\'s fit judgement, not sales data): ' + p.why, '');
  lines.push('Print file: print.png — ' + (v.width || '?') + ' x ' + (v.height || '?') + ' px' + (v.effectiveDpi ? ', prints at ' + v.effectiveDpi + ' dpi' : ''));
  if (cp && !cp.verified) lines.push('CHECK BEFORE SELLING: this product\'s print size is an unverified planning figure. ' + cp.sourceNote);
  lines.push('Mockups are simple pictures for a listing, not colour-accurate print proofs.');
  return lines.join('\n') + '\n';
}

function makeArtRoutes(deps) {
  const d = deps || {};
  for (const k of ['store', 'fs', 'fsp', 'path', 'respondJson', 'readBody']) if (!d[k]) throw new Error('makeArtRoutes: ' + k + ' is required');
  const { store, fs, fsp, respondJson } = d, P = d.path;
  const fail = (res, code, error, extra) => respondJson(res, code, Object.assign({ ok: false, error }, extra || {}));
  const statusOf = e => (e instanceof DesignError ? (e.code === 'DESIGN_NOT_FOUND' ? 404 : 409) : 500);
  async function body(req, res) {
    try { const raw = await d.readBody(req, 1 << 14, res); return raw && raw.trim() ? JSON.parse(raw) : {}; }
    catch (e) { if (!res.headersSent) fail(res, 400, 'bad json'); return null; }
  }
  function view(rec) {
    let spendUsd = rec.spendUsd || 0, spendKnown = false;
    if (typeof d.spendOf === 'function' && rec.runIds.length) { const s = d.spendOf(rec.runIds); if (s && Number.isFinite(s.usd)) { spendUsd = s.usd; spendKnown = true; } }
    return Object.assign({}, rec, { spendUsd: Math.round(spendUsd * 1e6) / 1e6, spendFromRuns: spendKnown, runCount: rec.runIds.length });
  }
  /* resolve a record-listed relative path inside the design's line folder; null when it is not listed or escapes */
  function resolveFile(rec, rel) {
    if (!recordPaths(rec).has(rel)) return null;
    const root = rec.source.projectRoot;
    if (!root) return null;
    const abs = P.resolve(root, rel);
    let rootReal, absReal;
    try { rootReal = fs.realpathSync(root); absReal = fs.realpathSync(abs); } catch (_) { return null; }
    const relBack = P.relative(rootReal, absReal);
    if (!relBack || relBack.startsWith('..') || P.isAbsolute(relBack)) return null;
    return absReal;
  }

  async function designs(req, res) {
    let list;
    try { list = store.list({ limit: 500 }).map(view); } catch (e) { return fail(res, 500, 'the design records could not be read: ' + String((e && e.message) || e)); }
    const cat = typeof d.catalog === 'function' ? d.catalog() : null;
    respondJson(res, 200, { ok: true, designs: list,
      products: cat ? cat.list({ includeDisabled: true }).map(p => ({ id: p.id, label: p.label, verified: p.verified, enabled: p.enabled, sourceNote: p.sourceNote })) : [],
      catalogOverrideError: cat ? cat.overrideError : null,
      grants: typeof d.grantState === 'function' ? d.grantState() : null });
  }

  async function file(req, res) {
    let u; try { u = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return fail(res, 400, 'bad url'); }
    const rec = store.get(String(u.searchParams.get('design') || ''));
    if (!rec) return fail(res, 404, 'no such design');
    const rel = String(u.searchParams.get('path') || '');
    const abs = resolveFile(rec, rel);
    if (!abs) return fail(res, 404, 'that file is not part of this design');
    const mime = MIME[P.extname(abs).toLowerCase()];
    if (!mime) return fail(res, 415, 'not an image');
    let buf; try { buf = await fsp.readFile(abs); } catch (e) { return fail(res, 404, 'the file is recorded but is no longer on disk'); }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  }

  async function approve(req, res) {
    const b = await body(req, res); if (!b) return;
    let rec;
    try { rec = await store.setApproval(String(b.design || ''), String(b.product || ''), String(b.decision || ''), b.note); }
    catch (e) { return fail(res, statusOf(e), String((e && e.message) || e)); }
    // a redo is RECORDED above. Starting the line again is separate, and its real outcome is reported, not assumed.
    let rerun = null;
    if (b.decision === 'redo') {
      if (typeof d.rerun !== 'function') rerun = { ok: false, error: 'the redo is recorded, but this station cannot restart the line from here' };
      else { try { rerun = await d.rerun(rec, String(b.product), String(b.note || '')); } catch (e) { rerun = { ok: false, error: String((e && e.message) || e) }; } }
    }
    respondJson(res, 200, { ok: true, design: view(rec), rerun });
  }

  async function rights(req, res) {
    const b = await body(req, res); if (!b) return;
    try { respondJson(res, 200, { ok: true, design: view(await store.setRights(String(b.design || ''), b.confirmed === true)) }); }
    catch (e) { fail(res, statusOf(e), String((e && e.message) || e)); }
  }

  async function exportDesign(req, res) {
    const b = await body(req, res); if (!b) return;
    const rec = store.get(String(b.design || ''));
    if (!rec) return fail(res, 404, 'no such design');
    if (!rec.rightsConfirmed) return fail(res, 409, 'confirm that you have commercial rights to everything in this design before exporting it', { code: 'RIGHTS_NOT_CONFIRMED' });
    const approved = Object.keys(rec.approvals).filter(p => rec.approvals[p].decision === 'approved');
    if (!approved.length) return fail(res, 409, 'nothing is approved yet — approve at least one product first', { code: 'NOTHING_APPROVED' });
    const cat = typeof d.catalog === 'function' ? d.catalog() : null;
    const root = rec.source.projectRoot, dirRel = 'export/' + slug(rec.source.originalName) + '-' + rec.id;
    const written = [], problems = [];
    for (const productId of approved) {
      const pdir = P.join(root, dirRel, productId);
      try { await fsp.mkdir(pdir, { recursive: true }); } catch (e) { problems.push(productId + ': could not create ' + pdir + ' (' + String((e && e.message) || e) + ')'); continue; }
      for (const v of rec.variants.filter(x => x.productId === productId)) {
        const src = resolveFile(rec, v.path), name = 'print' + (v.fabricId ? '-' + v.fabricId : '') + '.png';
        if (!src) { problems.push(productId + ': the print file ' + v.path + ' is missing'); continue; }
        try { await fsp.copyFile(src, P.join(pdir, name)); written.push(dirRel + '/' + productId + '/' + name); } catch (e) { problems.push(productId + ': ' + String((e && e.message) || e)); }
      }
      for (const m of rec.mockups.filter(x => x.productId === productId)) {
        const src = resolveFile(rec, m.path), name = 'mockup-' + (m.fabricId ? m.fabricId + '-' : '') + m.templateId + '.png';
        if (!src) { problems.push(productId + ': the mockup ' + m.path + ' is missing'); continue; }
        try { await fsp.copyFile(src, P.join(pdir, name)); written.push(dirRel + '/' + productId + '/' + name); } catch (e) { problems.push(productId + ': ' + String((e && e.message) || e)); }
      }
      try { await fsp.writeFile(P.join(pdir, 'listing.txt'), draftListing(rec, productId, cat)); written.push(dirRel + '/' + productId + '/listing.txt'); }
      catch (e) { problems.push(productId + ': listing.txt (' + String((e && e.message) || e) + ')'); }
    }
    respondJson(res, problems.length && !written.length ? 500 : 200, { ok: written.length > 0, folder: P.join(root, dirRel), products: approved, written, problems,
      note: 'Files were copied into your line\'s folder. Nothing was published or uploaded anywhere.' });
  }

  /* POST /api/art/setup { folder } — the owner picked ONE folder; an art line needs two that are NOT inside each other
     (a line may not watch its own output): "Drop designs here" (watched, originals, never written by agents) and
     "Studio files" (the line's working folder: copies, print files, mockups, exports). This makes both, asks the
     station's own folder-watch policy whether the drop folder may be watched, and trusts the studio folder as a
     project through the same path the Projects list uses (the owner's click on Set up is the consent). It changes
     nothing else: the line's folder, its trigger and its budget are set by the Gallery through their own routes, so
     each step's real result is shown. */
  const DROP_NAME = 'Drop designs here', STUDIO_NAME = 'Studio files';
  async function setup(req, res) {
    const b = await body(req, res); if (!b) return;
    const folder = String(b.folder || '').trim();
    if (!folder || !P.isAbsolute(folder)) return fail(res, 400, 'choose a folder (its full path), for example a new "Art Station" folder in Documents');
    if (typeof d.blessProject !== 'function' || typeof d.checkDropFolder !== 'function') return fail(res, 501, 'this station cannot set up art folders');
    let st; try { st = await fsp.stat(folder); } catch (e) { return fail(res, 400, 'that folder does not exist: ' + folder); }
    if (!st.isDirectory()) return fail(res, 400, 'that path is a file, not a folder: ' + folder);
    const drop = P.join(folder, DROP_NAME), studio = P.join(folder, STUDIO_NAME);
    try { await fsp.mkdir(drop, { recursive: true }); await fsp.mkdir(studio, { recursive: true }); }
    catch (e) { return fail(res, 500, 'could not create the folders inside ' + folder + ': ' + String((e && e.message) || e)); }
    const pol = await d.checkDropFolder(drop);
    if (!pol || !pol.ok) return fail(res, 400, 'the drop folder cannot be watched: ' + ((pol && pol.error) || 'refused') + ' Choose a folder inside your own user folder (Documents or Pictures, say).', { code: (pol && pol.code) || 'policy', created: [drop, studio] });
    let bl; try { bl = await d.blessProject(studio); } catch (e) { bl = { ok: false, reason: String((e && e.message) || e) }; }
    if (!bl || !bl.ok) return fail(res, 400, 'the studio folder could not be trusted as the line\'s working folder: ' + ((bl && bl.reason) || 'refused'), { created: [drop, studio] });
    respondJson(res, 200, { ok: true, folder, drop: pol.path, studio: bl.root || studio,
      note: 'Two folders are ready. Nothing is watching the drop folder until the line\'s trigger is switched on.' });
  }

  return { designs, file, approve, rights, exportDesign, setup, _internals: { recordPaths, resolveFile, draftListing, view } };
}

module.exports = { makeArtRoutes, recordPaths, draftListing };
