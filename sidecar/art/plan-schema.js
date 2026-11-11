/* sidecar/art/plan-schema.js — is this a product plan the art line can act on? (Art Studio Phase 2c)

   The Strategist "decides where a design sells best" by submitting a plan. Free text cannot be acted on or checked,
   so the plan is structured and validated against the live catalog before it is recorded:

     analysis { summary, subjects[], mood, palette[], textInArt, notes }     what the agent SAW in the design
     products [{ productId, placementId?, fabricId?, score 0-100, why, titleIdeas[]? }]    1..MAX_PRODUCTS, ranked
     skipped  [{ productId, reason }]                                        products it considered and ruled out

   Every problem is reported at once, in words a model can act on (unknown ids list the real ones), so one retry can
   fix them all. Nothing is silently corrected: a plan either passes as written or is refused.

   The score is the agent's FIT JUDGEMENT for this design on this product. It is not sales data — nothing here knows
   what sells — and the normalized plan is stamped `basis: 'fit-judgement'` so no surface can present it as more.

   Pure. validatePlan(input, catalog) -> { ok:true, analysis, plan } | { ok:false, errors:[...] } */
'use strict';

const MAX_PRODUCTS = 8, MIN_WHY = 20, MAX_WHY = 600, MAX_TITLES = 5;
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const strList = (v, cap, n) => (Array.isArray(v) ? v : []).map(x => str(x, n)).filter(Boolean).slice(0, cap);

function validatePlan(input, catalog) {
  const errors = [];
  const inp = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
  if (!inp) return { ok: false, errors: ['the plan must be an object with "analysis" and "products"'] };
  if (!catalog || typeof catalog.resolve !== 'function') throw new Error('validatePlan needs the product catalog');

  // ---- analysis: what was seen ----
  const a = inp.analysis && typeof inp.analysis === 'object' ? inp.analysis : null;
  let analysis = null;
  if (!a) errors.push('"analysis" is required: say what the design shows (summary, subjects, mood, palette, textInArt)');
  else {
    analysis = { summary: str(a.summary, 600), subjects: strList(a.subjects, 8, 80), mood: str(a.mood, 120),
      palette: strList(a.palette, 8, 40), textInArt: str(a.textInArt, 200), notes: str(a.notes, 600) };
    if (analysis.summary.length < 20) errors.push('analysis.summary must describe the design in a sentence or two (at least 20 characters)');
    if (!analysis.subjects.length) errors.push('analysis.subjects must list what the design depicts');
  }

  // ---- products: the ranked decision ----
  const list = Array.isArray(inp.products) ? inp.products : null;
  const products = [];
  if (!list || !list.length) errors.push('"products" must list at least one product to make');
  else if (list.length > MAX_PRODUCTS) errors.push('"products" lists ' + list.length + ' products; choose the best ' + MAX_PRODUCTS + ' at most');
  else {
    const seen = new Set();
    list.forEach((p, i) => {
      const at = 'products[' + i + ']';
      if (!p || typeof p !== 'object') { errors.push(at + ' must be an object'); return; }
      const productId = str(p.productId, 60);
      if (!productId) { errors.push(at + '.productId is required'); return; }
      if (seen.has(productId)) { errors.push(at + ': ' + productId + ' is listed twice — one entry per product (pick its best fabric)'); return; }
      seen.add(productId);
      const r = catalog.resolve(productId, str(p.placementId, 60) || null, str(p.fabricId, 60) || null);
      if (!r.ok) errors.push(at + ': ' + r.error);
      const score = Number(p.score);
      if (!Number.isFinite(score) || score < 0 || score > 100 || Math.round(score) !== score) errors.push(at + '.score must be a whole number from 0 to 100 (your fit judgement), got ' + JSON.stringify(p.score));
      const why = str(p.why, MAX_WHY);
      if (why.length < MIN_WHY) errors.push(at + '.why must explain the choice for THIS design (at least ' + MIN_WHY + ' characters)');
      if (r.ok && Number.isFinite(score)) products.push({ productId, placementId: r.placement.id, fabricId: r.fabric ? r.fabric.id : null,
        score, why, titleIdeas: strList(p.titleIdeas, MAX_TITLES, 100), verifiedSpec: r.product.verified });
    });
    for (let i = 1; i < list.length; i++) {
      if (Number(list[i] && list[i].score) > Number(list[i - 1] && list[i - 1].score)) { errors.push('"products" must be ranked best first (score descending)'); break; }
    }
  }

  // ---- skipped: considered and ruled out ----
  const skipped = [];
  if (inp.skipped != null && !Array.isArray(inp.skipped)) errors.push('"skipped" must be a list of { productId, reason }');
  else for (const [i, s] of (inp.skipped || []).entries()) {
    const at = 'skipped[' + i + ']';
    const productId = str(s && s.productId, 60), reason = str(s && s.reason, 400);
    if (!productId || !catalog.get(productId)) { errors.push(at + ': unknown product ' + JSON.stringify(productId)); continue; }
    if (reason.length < 10) { errors.push(at + '.reason must say why ' + productId + ' does not suit this design'); continue; }
    if (products.some(p => p.productId === productId)) { errors.push(at + ': ' + productId + ' is both chosen and skipped'); continue; }
    skipped.push({ productId, reason, by: 'strategist' });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, analysis, plan: { basis: 'fit-judgement', products, skipped } };
}

module.exports = { validatePlan, MAX_PRODUCTS };
