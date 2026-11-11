/* sidecar/art/products.js — the product catalog: what can be made, and the exact print area of each
   (Art Studio Phase 1c).

   The Strategist picks from this list, the Designer sizes print files from it, the Mockup Lab matches templates to
   it. So it is validated hard, and it is honest about where each number came from:

     verified: true   the print area and resolution rule were read from the print provider's own page (`source`)
     verified: false  a planning figure — usable, but to be confirmed against the provider's template before selling

   No print dimension is ever invented silently: an unverified product says so in `sourceNote`, and every consumer
   (the catalog tool, the Gallery) passes `verified` through.

   The owner can change the catalog without touching code: an override file merges over the defaults by product id
   (add a product, switch one off with enabled:false, correct a placement). Pure: the file system is injected. */
'use strict';

const DEFAULTS = require('./products.default.json');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const CATEGORIES = ['apparel', 'headwear', 'wall-art', 'sticker', 'accessory', 'digital'];
const ANCHORS = ['center', 'top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

class CatalogError extends Error {
  constructor(problems) { super('product catalog is invalid: ' + problems.join('; ')); this.name = 'CatalogError'; this.problems = problems; }
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const posInt = v => Number.isInteger(v) && v > 0;

/* Every problem, not just the first — a hand-edited override should get one complete list to fix. */
function validateCatalog(cat) {
  const problems = [];
  if (!isObj(cat)) return ['the catalog must be an object'];
  const fabricIds = new Set();
  if (!Array.isArray(cat.fabricColors)) problems.push('fabricColors must be a list');
  else for (const f of cat.fabricColors) {
    const at = 'fabric ' + JSON.stringify(f && f.id);
    if (!isObj(f) || !ID_RE.test(String(f.id))) { problems.push(at + ': id must be lower-case letters, digits and dashes'); continue; }
    if (fabricIds.has(f.id)) problems.push(at + ': duplicate id');
    fabricIds.add(f.id);
    if (!HEX_RE.test(String(f.hex))) problems.push(at + ': hex must be #rrggbb');
    if (f.kind !== 'dark' && f.kind !== 'light') problems.push(at + ': kind must be dark or light');
    if (!f.label) problems.push(at + ': needs a label');
  }
  const ids = new Set();
  if (!Array.isArray(cat.products) || !cat.products.length) problems.push('products must be a non-empty list');
  else for (const p of cat.products) {
    const at = 'product ' + JSON.stringify(p && p.id);
    if (!isObj(p) || !ID_RE.test(String(p.id))) { problems.push(at + ': id must be lower-case letters, digits and dashes'); continue; }
    if (ids.has(p.id)) problems.push(at + ': duplicate id');
    ids.add(p.id);
    if (!p.label) problems.push(at + ': needs a label');
    if (!CATEGORIES.includes(p.category)) problems.push(at + ': category must be one of ' + CATEGORIES.join(', '));
    if (typeof p.enabled !== 'boolean') problems.push(at + ': enabled must be true or false');
    if (typeof p.verified !== 'boolean') problems.push(at + ': verified must be true or false');
    if (p.verified === true && !/^https:\/\//.test(String(p.source || ''))) problems.push(at + ': a verified product must cite its source URL');
    if (!p.sourceNote) problems.push(at + ': needs a sourceNote saying where its numbers came from');
    if (!Array.isArray(p.fabrics)) problems.push(at + ': fabrics must be a list (empty for non-fabric products)');
    else for (const f of p.fabrics) if (!fabricIds.has(f)) problems.push(at + ': unknown fabric ' + JSON.stringify(f));
    if (typeof p.transparentBackground !== 'boolean') problems.push(at + ': transparentBackground must be true or false');
    if (!Array.isArray(p.placements) || !p.placements.length) { problems.push(at + ': needs at least one placement'); continue; }
    const pids = new Set();
    for (const pl of p.placements) {
      const pat = at + ' placement ' + JSON.stringify(pl && pl.id);
      if (!isObj(pl) || !ID_RE.test(String(pl.id))) { problems.push(pat + ': id must be lower-case letters, digits and dashes'); continue; }
      if (pids.has(pl.id)) problems.push(pat + ': duplicate id');
      pids.add(pl.id);
      if (!posInt(pl.widthPx) || !posInt(pl.heightPx)) problems.push(pat + ': widthPx and heightPx must be whole pixels');
      if (!(pl.dpi > 0)) problems.push(pat + ': needs a dpi');
      if (!(pl.minDpi > 0) || pl.minDpi > pl.dpi) problems.push(pat + ': minDpi must be above 0 and no higher than dpi');
      if (!(pl.widthIn > 0) || !(pl.heightIn > 0)) problems.push(pat + ': needs widthIn and heightIn');
      // the pixel size must BE the inch size at the stated dpi — a catalog whose numbers disagree with themselves is wrong somewhere
      else if (posInt(pl.widthPx) && posInt(pl.heightPx) && pl.dpi > 0 &&
        (Math.abs(pl.widthIn * pl.dpi - pl.widthPx) > 1 || Math.abs(pl.heightIn * pl.dpi - pl.heightPx) > 1)) {
        problems.push(pat + ': ' + pl.widthIn + ' x ' + pl.heightIn + ' in at ' + pl.dpi + ' dpi is ' + Math.round(pl.widthIn * pl.dpi) + ' x ' + Math.round(pl.heightIn * pl.dpi) + ' px, not ' + pl.widthPx + ' x ' + pl.heightPx);
      }
      if (!Number.isInteger(pl.safeInsetPx) || pl.safeInsetPx < 0 || pl.safeInsetPx * 2 >= Math.min(pl.widthPx || 0, pl.heightPx || 0)) problems.push(pat + ': safeInsetPx must leave a printable area');
      if (pl.shape !== 'rect') problems.push(pat + ': shape must be rect (the only shape the engine places on in v1)');
      if (pl.defaultAnchor != null && !ANCHORS.includes(pl.defaultAnchor)) problems.push(pat + ': unknown defaultAnchor');
      if (pl.defaultMode != null && pl.defaultMode !== 'contain' && pl.defaultMode !== 'cover') problems.push(pat + ': defaultMode must be contain or cover');
    }
  }
  return problems;
}

/* Merge an owner override over a base catalog. Products and fabrics merge BY ID (an override entry replaces the
   named fields of the product it names, or adds a new product); placements, when given, replace the product's list
   whole — half-merged print areas are how wrong sizes get printed. */
function mergeCatalog(base, override) {
  const out = JSON.parse(JSON.stringify(base));
  if (!isObj(override)) return out;
  const mergeById = (list, extra) => {
    if (!Array.isArray(extra)) return list;
    for (const e of extra) {
      if (!isObj(e) || !e.id) { list.push(e); continue; }   // left for validateCatalog to name
      const i = list.findIndex(x => x && x.id === e.id);
      if (i < 0) list.push(JSON.parse(JSON.stringify(e)));
      else list[i] = Object.assign({}, list[i], JSON.parse(JSON.stringify(e)));
    }
    return list;
  };
  out.fabricColors = mergeById(out.fabricColors || [], override.fabricColors);
  out.products = mergeById(out.products || [], override.products);
  return out;
}

/* Load the catalog: defaults, plus the owner's override file when one exists.
     deps.fs / deps.overridePath   optional; no override path = defaults only
   An unreadable or invalid override is NOT silently ignored and NOT fatal: the defaults load and `overrideError`
   says exactly what was wrong, so the UI can show it. */
function loadCatalog(deps) {
  const d = deps || {};
  const base = d.defaults || DEFAULTS;
  const baseProblems = validateCatalog(base);
  if (baseProblems.length) throw new CatalogError(baseProblems);
  let catalog = JSON.parse(JSON.stringify(base)), overrideError = null, overrideApplied = false;
  if (d.fs && d.overridePath && d.fs.existsSync(d.overridePath)) {
    try {
      const merged = mergeCatalog(base, JSON.parse(String(d.fs.readFileSync(d.overridePath, 'utf8')).replace(/^﻿/, '')));
      const problems = validateCatalog(merged);
      if (problems.length) overrideError = 'the product override file was not applied: ' + problems.join('; ');
      else { catalog = merged; overrideApplied = true; }
    } catch (e) {
      overrideError = 'the product override file could not be read: ' + String((e && e.message) || e);
    }
  }
  return makeCatalog(catalog, { overrideApplied, overrideError });
}

function makeCatalog(catalog, meta) {
  const fabrics = new Map(catalog.fabricColors.map(f => [f.id, f]));
  const products = new Map(catalog.products.map(p => [p.id, p]));
  const view = p => ({
    id: p.id, label: p.label, category: p.category, enabled: p.enabled, verified: p.verified,
    source: p.source || '', sourceNote: p.sourceNote, styleNotes: p.styleNotes || '',
    transparentBackground: p.transparentBackground,
    fabrics: p.fabrics.map(id => { const f = fabrics.get(id); return { id: f.id, label: f.label, hex: f.hex, kind: f.kind }; }),
    placements: p.placements.map(pl => Object.assign({ aspect: Math.round((pl.widthPx / pl.heightPx) * 1000) / 1000 }, pl))
  });
  return {
    checkedOn: catalog.checkedOn || null,
    overrideApplied: !!(meta && meta.overrideApplied),
    overrideError: (meta && meta.overrideError) || null,
    /* What the Strategist sees. Disabled products are left out unless asked for. */
    list(opts) {
      const o = opts || {};
      return catalog.products.filter(p => (o.includeDisabled || p.enabled) && (!o.category || p.category === o.category)).map(view);
    },
    get(productId) { const p = products.get(productId); return p ? view(p) : null; },
    /* Resolve the exact thing to print on. Returns { ok:false, error } with a message a model can act on. */
    resolve(productId, placementId, fabricId) {
      const p = products.get(productId);
      if (!p) return { ok: false, error: 'unknown product ' + JSON.stringify(productId) + '. Known products: ' + catalog.products.filter(x => x.enabled).map(x => x.id).join(', ') };
      if (!p.enabled) return { ok: false, error: 'product ' + productId + ' is switched off in the catalog' };
      const pl = placementId ? p.placements.find(x => x.id === placementId) : p.placements[0];
      if (!pl) return { ok: false, error: 'product ' + productId + ' has no placement ' + JSON.stringify(placementId) + '. Its placements: ' + p.placements.map(x => x.id).join(', ') };
      let fabric = null;
      if (p.fabrics.length) {
        if (!fabricId) return { ok: false, error: 'product ' + productId + ' is printed on fabric: choose one of ' + p.fabrics.join(', ') };
        if (!p.fabrics.includes(fabricId)) return { ok: false, error: 'product ' + productId + ' is not offered in fabric ' + JSON.stringify(fabricId) + '. Its fabrics: ' + p.fabrics.join(', ') };
        fabric = fabrics.get(fabricId);
      } else if (fabricId) return { ok: false, error: 'product ' + productId + ' has no fabric colours; leave fabric out' };
      return { ok: true, product: view(p), placement: Object.assign({}, pl), fabric: fabric ? Object.assign({}, fabric) : null };
    }
  };
}

module.exports = { loadCatalog, validateCatalog, mergeCatalog, CatalogError, DEFAULTS, CATEGORIES };
