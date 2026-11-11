/* node test/art-plan-schema.test.js — a product plan is accepted exactly as written or refused with every problem
   named (Art Studio Phase 2c). */
'use strict';
const A = require('./_assert.js');
const { validatePlan, MAX_PRODUCTS } = require('../sidecar/art/plan-schema.js');
const { loadCatalog } = require('../sidecar/art/products.js');
const cat = loadCatalog();
const clone = o => JSON.parse(JSON.stringify(o));

const GOOD = {
  analysis: { summary: 'A neon magenta and blue glitch collage of a classical statue with the word REDACTED.', subjects: ['statue', 'glitch texture'], mood: 'moody, electric',
    palette: ['magenta', 'blue', 'black'], textInArt: 'REDACTED', notes: '' },
  products: [
    { productId: 'poster-18x24', score: 92, why: 'The full collage and texture read best large and full-bleed.', titleIdeas: ['Redacted Statue Poster'] },
    { productId: 'tee-front', fabricId: 'black', score: 85, why: 'High-contrast neon on black suits a streetwear front print.' },
    { productId: 'cover-art', score: 70, why: 'Square crop keeps the statue and reads at thumbnail size.' }
  ],
  skipped: [{ productId: 'dad-hat-front', reason: 'Far too detailed for a 4 inch wide embroidery area.' }]
};

const ok = validatePlan(GOOD, cat);
A.eq(ok.ok, true, 'a well-formed plan is accepted' + (ok.errors ? ': ' + ok.errors.join(' | ') : ''));
A.eq(ok.plan.basis, 'fit-judgement', 'the plan is stamped as a fit judgement, never sales data');
A.eq(ok.plan.products.map(p => [p.productId, p.placementId, p.fabricId, p.score, p.verifiedSpec]),
  [['poster-18x24', 'full', null, 92, false], ['tee-front', 'front', 'black', 85, true], ['cover-art', 'square', null, 70, false]],
  'products keep their order and scores; the default placement is filled in; each carries whether its spec is verified');
A.eq(ok.plan.skipped, [{ productId: 'dad-hat-front', reason: 'Far too detailed for a 4 inch wide embroidery area.', by: 'strategist' }], 'skipped products keep their reason');
A.eq(ok.analysis.textInArt, 'REDACTED', 'the analysis is kept');
A.eq(GOOD.products[0].placementId, undefined, 'the input is not mutated');

const errs = fn => { const p = clone(GOOD); fn(p); const r = validatePlan(p, cat); return r.ok ? [] : r.errors; };
const has = (list, re) => list.some(e => re.test(e));
A.ok(has(errs(p => { p.products[0].productId = 'mug'; }), /products\[0\]: unknown product "mug"\. Known products: .*tee-front/), 'an unknown product is refused and the real ones are listed');
A.ok(has(errs(p => { delete p.products[1].fabricId; }), /products\[1\]: product tee-front is printed on fabric: choose one of black/), 'a fabric product without a fabric is refused, listing the fabrics');
A.ok(has(errs(p => { p.products[1].fabricId = 'neon'; }), /not offered in fabric "neon"/), 'an unknown fabric is refused');
A.ok(has(errs(p => { p.products[0].placementId = 'sleeve'; }), /no placement "sleeve"/), 'an unknown placement is refused');
A.ok(has(errs(p => { p.products[0].score = 150; }), /score must be a whole number from 0 to 100/), 'a score above 100 is refused');
A.ok(has(errs(p => { p.products[0].score = 91.5; }), /score must be a whole number/), 'a fractional score is refused');
A.ok(has(errs(p => { p.products[0].score = 'high'; }), /score must be a whole number/), 'a non-numeric score is refused');
A.ok(has(errs(p => { p.products[0].why = 'looks good'; }), /why must explain the choice for THIS design/), 'a throwaway reason is refused');
A.ok(has(errs(p => { p.products[2].score = 99; }), /ranked best first/), 'products out of rank order are refused');
A.ok(has(errs(p => { p.products.push(clone(p.products[0])); p.products[3].score = 1; }), /poster-18x24 is listed twice/), 'a product listed twice is refused');
A.ok(has(errs(p => { p.products = []; }), /at least one product/), 'an empty product list is refused');
A.ok(has(errs(p => { p.products = Array.from({ length: MAX_PRODUCTS + 1 }, () => clone(GOOD.products[0])); }), /choose the best 8 at most/), 'more than the cap is refused');
A.ok(has(errs(p => { delete p.analysis; }), /"analysis" is required/), 'a plan with no analysis is refused');
A.ok(has(errs(p => { p.analysis.summary = 'nice'; }), /analysis\.summary must describe the design/), 'a one-word summary is refused');
A.ok(has(errs(p => { p.analysis.subjects = []; }), /analysis\.subjects must list/), 'no subjects is refused');
A.ok(has(errs(p => { p.skipped[0].productId = 'tee-front'; }), /tee-front is both chosen and skipped/), 'a product cannot be both chosen and skipped');
A.ok(has(errs(p => { p.skipped[0].reason = 'no'; }), /reason must say why/), 'a skip needs a real reason');
A.ok(has(errs(p => { p.skipped = 'none'; }), /"skipped" must be a list/), 'skipped must be a list');
// every problem at once, so one retry can fix them all
const many = errs(p => { p.products[0].productId = 'mug'; p.products[1].score = -1; p.products[2].why = ''; p.analysis.subjects = []; });
A.ok(many.length >= 4, 'all problems are reported together (' + many.length + ')');
A.eq(validatePlan(null, cat).ok, false, 'a non-object plan is refused');
A.eq(validatePlan([], cat).ok, false, 'an array is refused');
A.throws(() => validatePlan(GOOD, null), 'validation without a catalog is a programming error, not a pass');
// a product the owner switched off cannot be planned
const off = loadCatalog({ fs: { existsSync: () => true, readFileSync: () => JSON.stringify({ products: [{ id: 'cover-art', enabled: false }] }) }, overridePath: 'x' });
A.ok(has(validatePlan(GOOD, off).errors || [], /cover-art is switched off/), 'a switched-off product is refused');

A.report('art-plan-schema.test');
