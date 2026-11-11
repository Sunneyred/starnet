/* node test/art-products.test.js — the product catalog is valid, honest about its sources, and safely overridable
   (Art Studio Phase 1c). */
'use strict';
const A = require('./_assert.js');
const { loadCatalog, validateCatalog, mergeCatalog, CatalogError, DEFAULTS } = require('../sidecar/art/products.js');
const clone = o => JSON.parse(JSON.stringify(o));

// ---- the shipped catalog ----
A.eq(validateCatalog(DEFAULTS), [], 'the shipped catalog is valid');
const cat = loadCatalog();
const all = cat.list();
A.ok(all.length >= 8, 'it offers a real range of products (' + all.length + ')');
for (const want of ['tee-front', 'dad-hat-front', 'poster-18x24', 'phone-case', 'sticker-4x4', 'cover-art']) A.ok(cat.get(want), 'it has ' + want);
A.eq([cat.overrideApplied, cat.overrideError], [false, null], 'no override: none applied, no error');

// honesty about sources: verified products cite a provider URL; every product says where its numbers came from
const verified = all.filter(p => p.verified), unverified = all.filter(p => !p.verified);
A.ok(verified.length >= 1 && unverified.length >= 1, 'the catalog distinguishes verified from planning figures (' + verified.length + ' verified, ' + unverified.length + ' not)');
for (const p of verified) A.ok(/^https:\/\/www\.printful\.com\//.test(p.source), p.id + ': a verified product cites the provider page it was read from');
for (const p of all) A.ok(p.sourceNote && p.sourceNote.length > 20, p.id + ': says where its numbers came from');
for (const p of unverified) A.ok(/not |assumed|common|confirm|planning/i.test(p.sourceNote), p.id + ': an unverified product says plainly what is not confirmed');
// every number agrees with itself: pixels = inches x dpi, and minDpi never exceeds dpi
for (const p of all) for (const pl of p.placements) {
  A.ok(Math.abs(pl.widthIn * pl.dpi - pl.widthPx) <= 1 && Math.abs(pl.heightIn * pl.dpi - pl.heightPx) <= 1, p.id + '/' + pl.id + ': pixel size is the inch size at its dpi');
  A.ok(pl.minDpi <= pl.dpi && pl.minDpi >= 150, p.id + '/' + pl.id + ': minimum dpi is sane (' + pl.minDpi + ')');
  A.eq(pl.aspect, Math.round((pl.widthPx / pl.heightPx) * 1000) / 1000, p.id + '/' + pl.id + ': aspect is derived');
}
const tee = cat.get('tee-front');
A.eq([tee.placements[0].widthPx, tee.placements[0].heightPx, tee.placements[0].minDpi, tee.verified], [3600, 4800, 150, true], 'the t-shirt front is Printful\'s 12 x 16 in area at 300 dpi, 150 minimum');
A.ok(tee.fabrics.some(f => f.kind === 'dark') && tee.fabrics.some(f => f.kind === 'light'), 'apparel comes in dark and light fabrics, with their colours');
A.eq(cat.get('poster-18x24').fabrics, [], 'a poster has no fabric');

// ---- list / resolve ----
A.ok(cat.list({ category: 'wall-art' }).every(p => p.category === 'wall-art') && cat.list({ category: 'wall-art' }).length >= 2, 'list filters by category');
const r = cat.resolve('tee-front', 'front', 'black');
A.eq([r.ok, r.placement.widthPx, r.fabric.kind], [true, 3600, 'dark'], 'resolve returns the exact placement and fabric');
A.eq(cat.resolve('poster-18x24').placement.id, 'full', 'resolve defaults to the first placement');
A.ok(/unknown product/.test(cat.resolve('mug').error) && /tee-front/.test(cat.resolve('mug').error), 'an unknown product is refused, naming the real ones');
A.ok(/choose one of black/.test(cat.resolve('tee-front', 'front').error), 'a fabric product needs a fabric, and the error lists them');
A.ok(/not offered in fabric/.test(cat.resolve('tee-front', 'front', 'neon').error), 'an unknown fabric is refused');
A.ok(/no placement/.test(cat.resolve('tee-front', 'sleeve', 'black').error), 'an unknown placement is refused, naming the real ones');
A.ok(/no fabric colours/.test(cat.resolve('poster-18x24', 'full', 'black').error), 'a fabric on a non-fabric product is refused');
r.placement.widthPx = 1; A.eq(cat.resolve('tee-front', 'front', 'black').placement.widthPx, 3600, 'a caller cannot corrupt the catalog through a returned placement');

// ---- validation names every problem ----
const bad = clone(DEFAULTS);
bad.products[0].placements[0].widthPx = 3000;            // no longer 12 in at 300 dpi
bad.products[1].verified = true; bad.products[1].source = '';
bad.products[2].fabrics = ['plaid'];
bad.products.push(clone(bad.products[3]));               // duplicate id
const problems = validateCatalog(bad);
A.ok(problems.some(p => /tee-front.*is 3600 x 4800 px, not 3000 x 4800/.test(p)), 'a pixel size that contradicts its inches is caught');
A.ok(problems.some(p => /hoodie-front.*must cite its source URL/.test(p)), 'a verified product with no source is caught');
A.ok(problems.some(p => /unknown fabric "plaid"/.test(p)), 'an unknown fabric is caught');
A.ok(problems.some(p => /duplicate id/.test(p)), 'a duplicate product id is caught');
A.ok(problems.length >= 4, 'all problems are reported together, not just the first');
A.throws(() => loadCatalog({ defaults: bad }), 'a broken base catalog refuses to load');
try { loadCatalog({ defaults: bad }); } catch (e) { A.ok(e instanceof CatalogError && e.problems.length === problems.length, 'the error carries the full problem list'); }

// ---- owner overrides ----
const merged = mergeCatalog(DEFAULTS, { products: [{ id: 'phone-case', enabled: false }, {
  id: 'tote', label: 'Tote bag', category: 'accessory', enabled: true, verified: false, source: '', sourceNote: 'owner-entered planning figure, not confirmed',
  fabrics: ['sand'], transparentBackground: true,
  placements: [{ id: 'front', label: 'Front', widthIn: 10, heightIn: 10, dpi: 300, minDpi: 150, widthPx: 3000, heightPx: 3000, safeInsetPx: 0, shape: 'rect' }] }] });
A.eq(validateCatalog(merged), [], 'an override that switches one product off and adds another is valid');
A.eq(DEFAULTS.products.find(p => p.id === 'phone-case').enabled, true, 'merging never mutates the defaults');

const files = { '/ws/art-products.json': JSON.stringify({ products: [{ id: 'phone-case', enabled: false }] }) };
const fakeFs = { existsSync: p => p in files, readFileSync: p => files[p] };
const o1 = loadCatalog({ fs: fakeFs, overridePath: '/ws/art-products.json' });
A.eq([o1.overrideApplied, o1.overrideError], [true, null], 'a valid override file is applied');
A.ok(!o1.list().some(p => p.id === 'phone-case') && o1.list({ includeDisabled: true }).some(p => p.id === 'phone-case'), 'a switched-off product leaves the list but is still known');
A.ok(/switched off/.test(o1.resolve('phone-case').error), 'a switched-off product cannot be resolved');

files['/ws/art-products.json'] = '{ not json';
const o2 = loadCatalog({ fs: fakeFs, overridePath: '/ws/art-products.json' });
A.eq(o2.overrideApplied, false, 'an unreadable override is not applied');
A.ok(/could not be read/.test(o2.overrideError), 'and the reason is reported, not swallowed');
A.eq(o2.list().length, all.length, 'the defaults still load');

files['/ws/art-products.json'] = JSON.stringify({ products: [{ id: 'tee-front', placements: [{ id: 'front', label: 'Front', widthIn: 12, heightIn: 16, dpi: 300, minDpi: 150, widthPx: 9999, heightPx: 4800, safeInsetPx: 0, shape: 'rect' }] }] });
const o3 = loadCatalog({ fs: fakeFs, overridePath: '/ws/art-products.json' });
A.eq(o3.overrideApplied, false, 'an override with a wrong print size is NOT applied');
A.ok(/not applied/.test(o3.overrideError) && /not 9999 x 4800/.test(o3.overrideError), 'and says which number was wrong');
A.eq(o3.get('tee-front').placements[0].widthPx, 3600, 'the verified default print area stands');
A.eq(loadCatalog({ fs: fakeFs, overridePath: '/ws/missing.json' }).overrideApplied, false, 'no override file is simply no override');

A.report('art-products.test');
