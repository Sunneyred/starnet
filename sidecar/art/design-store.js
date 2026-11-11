/* sidecar/art/design-store.js — one durable record per dropped design (Art Studio Phase 2a).

   The record is the art line's ledger: original -> plan -> print files -> review -> mockups -> the owner's
   approval. The Gallery reads ONLY this, so the interface can never show more than the harness did:

     · a status moves forward only through the methods below, each of which checks what must already be true
       (no "ready" without mockups, no variant for a product that was never planned);
     · every change is appended to the record's own `history`;
     · a failure is recorded on the record (`failed` + the error) — a design never silently disappears.

   It owns metadata, never image bytes: files live in the line's working folder, and the record holds their paths
   relative to it. Storage is the shared crash-safe JSON store (durable-store.js: fsync-before-rename, a .bak of the
   last good value, and a per-key mutex so two stages finishing together cannot lose an update).

   Determinism-clean: the clock and the id source are injected.

   makeDesignStore({ fs, path, workspaces, now, newId, writeDurable? }) -> store (see the return at the bottom) */
'use strict';

const { makeDurableJsonStore } = require('../durable-store.js');

const STATUSES = ['new', 'planned', 'adapting', 'reviewing', 'mocking', 'ready', 'approved', 'rejected', 'failed'];
const ORDER = { new: 0, planned: 1, adapting: 2, reviewing: 3, mocking: 4, ready: 5 };   // the forward path
const APPROVALS = ['approved', 'rejected', 'redo'];
const VERDICTS = ['pass', 'redo', 'needs-owner'];
const ID_RE = /^dsn_[a-z0-9]{6,40}$/;
const HISTORY_CAP = 200, ERRORS_CAP = 30, TEXT = 600, MAX_REVIEW_ROUNDS = 2;

class DesignError extends Error {
  constructor(code, message) { super(message); this.name = 'DesignError'; this.code = code; }
}

const text = (v, n) => String(v == null ? '' : v).slice(0, n || TEXT);
const clone = o => JSON.parse(JSON.stringify(o));
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const posInt = v => (Number.isInteger(v) && v > 0 ? v : 0);
const variantKey = v => text(v.productId, 60) + '|' + text(v.placementId, 60) + '|' + text(v.fabricId || '', 60);

function makeDesignStore(deps) {
  deps = deps || {};
  if (!deps.fs || !deps.path || !deps.workspaces) throw new Error('makeDesignStore: fs/path/workspaces required');
  if (typeof deps.now !== 'function' || typeof deps.newId !== 'function') throw new Error('makeDesignStore: now() and newId() must be injected');
  const now = deps.now, P = deps.path;
  const durable = makeDurableJsonStore({ fs: deps.fs, path: P, fileFor: () => P.join(deps.workspaces, 'art-designs.json'), writeDurable: deps.writeDurable });
  const KEY = 'designs';

  const normalize = s => ({ v: 1, designs: (s && Array.isArray(s.designs)) ? s.designs : [] });
  const readAll = () => normalize(durable.get(KEY));

  function note(rec, event, detail) {
    rec.history.push({ at: now(), event: text(event, 60), detail: text(detail, 300) });
    if (rec.history.length > HISTORY_CAP) rec.history.splice(0, rec.history.length - HISTORY_CAP);
    rec.updatedAt = now();
  }
  // forward only: a late stage finishing after the owner already approved must not drag the status back
  function advance(rec, to) {
    if (rec.status === 'failed' || rec.status === 'approved' || rec.status === 'rejected') return;
    if (ORDER[to] > ORDER[rec.status]) rec.status = to;
  }

  /* mutate(id, fn): the ONE write path. Re-reads under the store's mutex, applies fn to a copy, persists. fn may
     throw a DesignError to refuse — then nothing is written. */
  async function mutate(id, fn) {
    let out = null;
    await durable.update(KEY, cur => {
      const s = normalize(cur);
      const i = s.designs.findIndex(d => d.id === id);
      if (i < 0) throw new DesignError('DESIGN_NOT_FOUND', 'no design ' + JSON.stringify(id));
      const rec = clone(s.designs[i]);
      fn(rec);
      s.designs[i] = rec;
      out = clone(rec);
      return s;
    });
    return out;
  }

  /* create(source) — a dropped design becomes a record. `source`:
       { originalName, droppedPath, projectRoot, storedRel, sha256, bytes, width, height, lineId?, triggerId? }
     Refuses a second record for the same bytes (DESIGN_DUPLICATE, carrying the existing id). */
  async function create(source) {
    const src = source || {};
    if (!/^[a-f0-9]{64}$/.test(String(src.sha256))) throw new DesignError('DESIGN_BAD_SOURCE', 'a design needs the sha256 of its bytes');
    if (!text(src.storedRel) || !text(src.projectRoot, 4096)) throw new DesignError('DESIGN_BAD_SOURCE', 'a design needs the folder and relative path its copy was stored at');
    if (!posInt(src.width) || !posInt(src.height)) throw new DesignError('DESIGN_BAD_SOURCE', 'a design needs its pixel size');
    let out = null;
    await durable.update(KEY, cur => {
      const s = normalize(cur);
      const dup = s.designs.find(d => d.source && d.source.sha256 === src.sha256);
      if (dup) { const e = new DesignError('DESIGN_DUPLICATE', 'these exact bytes are already design ' + dup.id); e.existingId = dup.id; throw e; }
      let id = '';
      for (let k = 0; k < 8 && (!id || s.designs.some(d => d.id === id)); k++) id = 'dsn_' + String(deps.newId()).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
      if (!ID_RE.test(id) || s.designs.some(d => d.id === id)) throw new DesignError('DESIGN_BAD_ID', 'could not mint a design id');
      const at = now();
      const rec = {
        id, createdAt: at, updatedAt: at, status: 'new',
        source: { originalName: text(src.originalName, 260), droppedPath: text(src.droppedPath, 4096), projectRoot: text(src.projectRoot, 4096),
          storedRel: text(src.storedRel, 600), previewRel: text(src.previewRel || '', 600) || null, sha256: src.sha256, bytes: num(src.bytes), width: src.width, height: src.height,
          lineId: text(src.lineId, 80), triggerId: text(src.triggerId, 80) },
        facts: src.facts && typeof src.facts === 'object' ? clone(src.facts) : null,   // art-ops inspect at intake (measured, not judged)
        analysis: null, plan: null, variants: [], mockups: [], approvals: {},
        rightsConfirmed: false, spendUsd: 0, runIds: [], errors: [], history: []
      };
      note(rec, 'dropped', rec.source.originalName);
      s.designs.push(rec);
      out = clone(rec);
      return s;
    });
    return out;
  }

  /* setPlan — the Strategist's decision, ALREADY validated against the catalog (plan-schema.js). Replacing a plan
     is allowed only before any print file exists; after that the owner's "redo" is the way back. */
  function setPlan(id, analysis, plan, meta) {
    return mutate(id, rec => {
      if (rec.status === 'failed') throw new DesignError('DESIGN_FAILED', 'design ' + id + ' is marked failed: ' + ((rec.errors[rec.errors.length - 1] || {}).message || ''));
      if (rec.variants.length) throw new DesignError('DESIGN_PLAN_LOCKED', 'design ' + id + ' already has print files; its plan can no longer be replaced');
      if (!plan || !Array.isArray(plan.products) || !plan.products.length) throw new DesignError('DESIGN_BAD_PLAN', 'a plan needs at least one product');
      rec.analysis = analysis ? clone(analysis) : null;
      rec.plan = Object.assign(clone(plan), { createdAt: now(), agentId: text(meta && meta.agentId, 60), model: text(meta && meta.model, 120) });
      advance(rec, 'planned');
      note(rec, 'planned', plan.products.map(p => p.productId).join(', '));
    });
  }

  /* addVariant — a print file the Designer made. Only for a product the plan names. Re-making the same
     product/placement/fabric replaces the earlier file's row (its review is cleared: it is a different file now). */
  function addVariant(id, v) {
    return mutate(id, rec => {
      if (!rec.plan) throw new DesignError('DESIGN_NOT_PLANNED', 'design ' + id + ' has no product plan yet; submit one before making print files');
      const planned = rec.plan.products.find(p => p.productId === v.productId);
      if (!planned) throw new DesignError('DESIGN_NOT_IN_PLAN', 'product ' + JSON.stringify(v.productId) + ' is not in design ' + id + '\'s plan (' + rec.plan.products.map(p => p.productId).join(', ') + ')');
      if (!text(v.path)) throw new DesignError('DESIGN_BAD_VARIANT', 'a variant needs the path of the print file that was written');
      const row = { productId: text(v.productId, 60), placementId: text(v.placementId, 60), fabricId: text(v.fabricId || '', 60) || null,
        path: text(v.path, 600), previewPath: text(v.previewPath || '', 600) || null, width: posInt(v.width), height: posInt(v.height), effectiveDpi: num(v.effectiveDpi), requiredDpi: num(v.requiredDpi),
        upscaled: !!v.upscaled, verifiedSpec: !!v.verifiedSpec, steps: Array.isArray(v.steps) ? v.steps.slice(0, 12).map(s => text(s, 300)) : [],
        lowContrastShare: v.lowContrastShare == null ? null : num(v.lowContrastShare),
        madeAt: now(), reviewRounds: 0, review: null };
      const i = rec.variants.findIndex(x => variantKey(x) === variantKey(row));
      if (i >= 0) { row.reviewRounds = rec.variants[i].reviewRounds; rec.variants[i] = row; } else rec.variants.push(row);
      // it could be made after all: the Designer's earlier "could not make this" no longer stands
      if (rec.plan.skipped) rec.plan.skipped = rec.plan.skipped.filter(k => !(k.productId === row.productId && k.by === 'designer'));
      // a re-made print file invalidates the mockups rendered from the old one
      rec.mockups = rec.mockups.filter(m => !(m.productId === row.productId && (m.fabricId || null) === row.fabricId));
      advance(rec, 'adapting');
      note(rec, i >= 0 ? 'variant-remade' : 'variant', row.productId + (row.fabricId ? '/' + row.fabricId : '') + ' -> ' + row.path);
    });
  }

  /* skipProduct — the Designer could not make a planned product (too small to print, say). Recorded with the reason. */
  function skipProduct(id, productId, reason) {
    return mutate(id, rec => {
      if (!rec.plan) throw new DesignError('DESIGN_NOT_PLANNED', 'design ' + id + ' has no product plan yet');
      if (!rec.plan.products.some(p => p.productId === productId)) throw new DesignError('DESIGN_NOT_IN_PLAN', 'product ' + JSON.stringify(productId) + ' is not in the plan');
      rec.plan.skipped = (rec.plan.skipped || []).filter(s => s.productId !== productId);
      rec.plan.skipped.push({ productId: text(productId, 60), reason: text(reason, 400), at: now(), by: 'designer' });
      note(rec, 'skipped', productId + ': ' + text(reason, 200));
    });
  }

  /* setReview — the Reviewer's verdict on one print file. `redo` counts a round; after MAX_REVIEW_ROUNDS redos the
     verdict becomes `needs-owner` whatever was asked — the line never loops forever, and the file is still shown. */
  function setReview(id, sel, review) {
    return mutate(id, rec => {
      const i = rec.variants.findIndex(x => x.productId === sel.productId && (sel.fabricId == null || (x.fabricId || null) === (sel.fabricId || null)) &&
        (sel.placementId == null || x.placementId === sel.placementId));
      if (i < 0) throw new DesignError('DESIGN_NO_VARIANT', 'design ' + id + ' has no print file for ' + JSON.stringify(sel.productId) + (sel.fabricId ? ' on ' + sel.fabricId : ''));
      if (!VERDICTS.includes(review && review.verdict) || review.verdict === 'needs-owner') throw new DesignError('DESIGN_BAD_REVIEW', 'verdict must be pass or redo');
      const v = rec.variants[i];
      let verdict = review.verdict;
      if (verdict === 'redo') {
        if (v.reviewRounds >= MAX_REVIEW_ROUNDS) verdict = 'needs-owner';
        else v.reviewRounds += 1;
      }
      v.review = { verdict, notes: text(review.notes, 1000), at: now(), cappedFrom: verdict === 'needs-owner' ? 'redo' : null };
      advance(rec, 'reviewing');
      // every print file judged and none waiting on a redo: the design moves on to mockups
      if (rec.variants.every(x => x.review && x.review.verdict !== 'redo')) advance(rec, 'mocking');
      note(rec, 'review', v.productId + ': ' + verdict + (verdict === 'needs-owner' ? ' (redo limit reached)' : ''));
    });
  }

  /* addMockup — a rendered mockup of a print file that exists. */
  function addMockup(id, m) {
    return mutate(id, rec => {
      const v = rec.variants.find(x => x.productId === m.productId && (x.fabricId || null) === (m.fabricId || null));
      if (!v) throw new DesignError('DESIGN_NO_VARIANT', 'design ' + id + ' has no print file for ' + JSON.stringify(m.productId) + (m.fabricId ? ' on ' + m.fabricId : '') + '; a mockup needs one');
      if (!text(m.path)) throw new DesignError('DESIGN_BAD_MOCKUP', 'a mockup needs the path of the image that was written');
      const row = { productId: v.productId, fabricId: v.fabricId, templateId: text(m.templateId, 80), path: text(m.path, 600),
        width: posInt(m.width), height: posInt(m.height), kind: m.kind === 'ai-scene' ? 'ai-scene' : 'template', madeAt: now() };
      rec.mockups = rec.mockups.filter(x => !(x.productId === row.productId && (x.fabricId || null) === row.fabricId && x.templateId === row.templateId));
      rec.mockups.push(row);
      advance(rec, 'mocking');
      note(rec, 'mockup', row.productId + ' -> ' + row.path);
    });
  }

  /* markReady — the line is done with this design. Only true when every made print file has a mockup and none is
     still waiting on a redo; otherwise it refuses and says what is missing. */
  function markReady(id) {
    return mutate(id, rec => {
      if (!rec.variants.length) throw new DesignError('DESIGN_NOT_READY', 'design ' + id + ' has no print files');
      const waiting = rec.variants.filter(v => v.review && v.review.verdict === 'redo').map(v => v.productId);
      if (waiting.length) throw new DesignError('DESIGN_NOT_READY', 'still waiting on a redo for: ' + waiting.join(', '));
      const bare = rec.variants.filter(v => !rec.mockups.some(m => m.productId === v.productId && (m.fabricId || null) === (v.fabricId || null))).map(v => v.productId);
      if (bare.length) throw new DesignError('DESIGN_NOT_READY', 'no mockup yet for: ' + bare.join(', '));
      advance(rec, 'ready');
      note(rec, 'ready', rec.variants.length + ' product(s)');
    });
  }

  /* setApproval — the OWNER's decision on one product (the Gallery). Never called by an agent tool. */
  function setApproval(id, productId, decision, noteText) {
    return mutate(id, rec => {
      if (!APPROVALS.includes(decision)) throw new DesignError('DESIGN_BAD_APPROVAL', 'decision must be approved, rejected or redo');
      if (!rec.variants.some(v => v.productId === productId)) throw new DesignError('DESIGN_NO_VARIANT', 'design ' + id + ' has no print file for ' + JSON.stringify(productId));
      rec.approvals[productId] = { decision, note: text(noteText, 600), at: now() };
      const made = Array.from(new Set(rec.variants.map(v => v.productId)));
      const all = made.map(p => rec.approvals[p] && rec.approvals[p].decision);
      if (rec.status !== 'failed') {
        if (all.every(d => d === 'approved' || d === 'rejected') && all.some(d => d === 'approved')) rec.status = 'approved';
        else if (all.every(d => d === 'rejected')) rec.status = 'rejected';
        else if (rec.status === 'approved' || rec.status === 'rejected') rec.status = 'ready';   // a redo reopens it
      }
      note(rec, 'owner-' + decision, productId + (noteText ? ': ' + text(noteText, 200) : ''));
    });
  }

  function setRights(id, confirmed) {
    return mutate(id, rec => { rec.rightsConfirmed = confirmed === true; note(rec, 'rights', rec.rightsConfirmed ? 'owner confirmed commercial rights' : 'owner cleared the rights confirmation'); });
  }
  function addRun(id, runId, usd) {
    return mutate(id, rec => {
      const r = text(runId, 80);
      if (r && !rec.runIds.includes(r)) { rec.runIds.push(r); if (rec.runIds.length > 100) rec.runIds.shift(); }
      if (num(usd) > 0) rec.spendUsd = Math.round((rec.spendUsd + num(usd)) * 1e6) / 1e6;
    });
  }
  /* fail — a stage could not finish. The record stays, visibly failed, with the reason. */
  function fail(id, stage, message) {
    return mutate(id, rec => {
      rec.errors.push({ at: now(), stage: text(stage, 60), message: text(message, 600) });
      if (rec.errors.length > ERRORS_CAP) rec.errors.shift();
      if (rec.status !== 'approved' && rec.status !== 'rejected') rec.status = 'failed';
      note(rec, 'failed', text(stage, 60) + ': ' + text(message, 200));
    });
  }
  /* recordError — something went wrong that did NOT stop the design (one product refused, say). */
  function recordError(id, stage, message) {
    return mutate(id, rec => {
      rec.errors.push({ at: now(), stage: text(stage, 60), message: text(message, 600) });
      if (rec.errors.length > ERRORS_CAP) rec.errors.shift();
      note(rec, 'error', text(stage, 60) + ': ' + text(message, 200));
    });
  }

  return {
    create, setPlan, addVariant, skipProduct, setReview, addMockup, markReady, setApproval, setRights, addRun, fail, recordError,
    get(id) { const d = readAll().designs.find(x => x.id === id); return d ? clone(d) : null; },
    findBySha(sha) { const d = readAll().designs.find(x => x.source && x.source.sha256 === sha); return d ? clone(d) : null; },
    /* newest first */
    list(opts) {
      const o = opts || {};
      let rows = readAll().designs.slice().sort((a, b) => b.createdAt - a.createdAt);
      if (o.status) rows = rows.filter(d => d.status === o.status);
      if (o.lineId) rows = rows.filter(d => d.source.lineId === o.lineId);
      return rows.slice(0, o.limit > 0 ? o.limit : 500).map(clone);
    },
    _internals: { durable, KEY,
      // intake only: the copy's final path is known once the record (and so its id) exists
      setStoredRel(id, rel) { return mutate(id, rec => { rec.source.storedRel = text(rel, 600); }); },
      // intake only: the small look-at copy of the design (art-ops preview), written after the original's copy
      setPreviewRel(id, rel) { return mutate(id, rec => { rec.source.previewRel = text(rel || '', 600) || null; }); } }
  };
}

module.exports = { makeDesignStore, DesignError, STATUSES, APPROVALS, MAX_REVIEW_ROUNDS, ID_RE };
