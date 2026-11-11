/* sidecar/tools/builtin/art.js — the art line's tools (Art Studio Phase 1d).

     product_catalog   read   what can be made: products, print areas, fabrics, and whether each spec is verified
     art_inspect       read   facts about a design file (size, background, artwork bounds, palette) and, for a
                              product, whether it is big enough to print there
     art_prepare       write  make the PRINT FILE for one product: exact pixel size, artwork inside the print area,
                              optional flat-background removal / trim / fabric recolour. Saved as a NEW png.

   All three ride the STUDIO capability (a placed STUDIO prop grants them — CAP_REGISTRY `studio`), the same door
   image_generate uses. None touches the network: this is deterministic local image work (sidecar/art/art-ops.js).

   THE LAWS
   · The original is never modified. art_prepare reads the source and writes a different file; it refuses an output
     path that is the source.
   · Paths go through the ONE workspace jail (fs.js), exactly like image_generate: a relative path lands in the
     project folder of a project-scoped run, else the agent's private workspace; nothing escapes.
   · The tool result states what was DONE and MEASURED — the size written, the dpi it prints at, what was removed or
     recoloured, and whether the product's print spec is verified. A refusal (art too small, unknown product) is an
     error with the numbers in it, never a blurry file.

   DESIGN RECORDS (Phase 2-3). With a design store wired, three more tools tie the work to a dropped design's
   durable record (sidecar/art/design-store.js) — the only thing the Gallery reads:

     design_get            read   the record so far: the file, its measurements, the plan, print files, reviews
     product_plan_submit   write  the Strategist's ranked product plan, validated against the catalog (plan-schema.js)
     design_review         write  the Reviewer's verdict on one print file (pass / redo, capped at 2 redo rounds)

   and art_prepare takes an optional "design": the print file is then recorded on that design, and a product that
   cannot be made is recorded as skipped WITH the reason. These two writes touch only the record, never a file the
   owner made, and never the network — so they are not consent-gated (the same posture as deliverable_note).

   makeArtTools({ fsp, pathMod, root, pathTrust?, artOps?, loadCatalog?, designStore? }) -> { tools, register(reg), _internals } */
'use strict';

const fsMod = require('./fs.js');
const ArtOps = require('../../art/art-ops.js');
const Products = require('../../art/products.js');
const PlanSchema = require('../../art/plan-schema.js');
const Mockup = require('../../art/mockup.js');
const { DesignError } = require('../../art/design-store.js');

const MAX_SOURCE_BYTES = 80 * 1024 * 1024;   // a print-size PNG is tens of MB; refuse anything absurd before reading it
const IMAGE_EXT = /\.(png|jpe?g)$/i;
const TOOL_TIMEOUT_MS = 120000;

const str = v => String(v == null ? '' : v).trim();
const slug = s => str(s).toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'design';

function makeArtTools(deps) {
  deps = deps || {};
  const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root;
  if (!fsp || !P || !ROOT) throw new Error('art.js requires { fsp, pathMod, root }');
  const jail = fsMod.makeFsTools({ fsp, pathMod: P, root: ROOT, pathTrust: typeof deps.pathTrust === 'function' ? deps.pathTrust : undefined })._internals;
  // lazy: the native canvas module loads on the first art call, never at sidecar boot
  let _ops = deps.artOps || null;
  const ops = () => _ops || (_ops = ArtOps.defaultArtOps());
  // mockup templates: the drawn built-ins plus the owner's own packs, re-read per call like the catalog
  const mockups = () => (typeof deps.mockups === 'function' ? deps.mockups() : Mockup.defaultMockups());
  // the catalog is re-read per call so an owner's edit to the override file applies without a restart
  const catalog = () => (typeof deps.loadCatalog === 'function' ? deps.loadCatalog() : Products.loadCatalog());

  const store = deps.designStore || null;
  const DESIGN_ID = /^dsn_[a-z0-9]{6,40}$/;
  /* designOf(args.design) -> the record, or a refusal a model can act on. null when no design was named. */
  function designOf(v, required) {
    const id = str(v);
    if (!id) { if (required) throw new Error('design is required: the design id from the work item (it looks like dsn_…)'); return null; }
    if (!store) throw new Error('this station keeps no design records, so a design id cannot be used here');
    if (!DESIGN_ID.test(id)) throw new Error('"' + id + '" is not a design id (it looks like dsn_ followed by letters and digits) — copy it from the work item');
    const rec = store.get(id);
    if (!rec) throw new Error('no design ' + id + ' on record — copy the design id from the work item exactly');
    return rec;
  }
  const storeMessage = e => (e instanceof DesignError ? e.message : String((e && e.message) || e));
  // a run that worked on a design is noted on it (the Gallery sums real spend from these run ids)
  async function noteRun(rec, ctx) {
    const runId = ctx && (ctx.runId || ctx.run_id);
    if (rec && store && runId) await store.addRun(rec.id, String(runId), 0).catch(require('../../failopen.js').swallow('art.design.note-run'));
  }

  async function readSource(aid, path, ctx) {
    const rel = str(path);
    if (!rel) throw new Error('path is required: the design image file to work from');
    if (/^(?:https?|data|file|ftp):/i.test(rel)) throw new Error('path must be an image file in your workspace or project, not a URL');
    if (!IMAGE_EXT.test(rel)) throw new Error('the design must be a PNG or JPEG file: ' + rel);
    const { abs } = await jail.resolveInside(aid, rel, { scope: 'read', ctx });
    let stat;
    try { stat = await fsp.stat(abs); }
    catch (e) { if (e && e.code === 'ENOENT') throw new Error('design file not found: ' + rel + ' (looked at ' + abs + ')'); throw e; }
    if (stat.size > MAX_SOURCE_BYTES) throw new Error('design file is too large (' + stat.size + ' bytes, max ' + MAX_SOURCE_BYTES + ')');
    return { rel, abs, buffer: await fsp.readFile(abs) };
  }
  const artMessage = e => (e instanceof ArtOps.ArtError ? e.message : String((e && e.message) || e));

  function emitDeliverable(ctx, aid, rel) {
    if (!ctx || typeof ctx.emit !== 'function') return;
    const d = { id: 'img_' + String(rel).replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'image', title: String(rel) };
    if (ctx.room) d.room = ctx.room;
    ctx.emit('deliverable', d);
  }

  // ---------------- product_catalog ----------------
  const catalogTool = {
    name: 'product_catalog', capability: 'studio', scope: 'read', requiresConsent: false, timeoutMs: 15000,
    description: 'List the products a design can be made into: each product\'s id, its print placements (exact pixel size, dpi, ' +
      'minimum dpi, shape), the fabric colours it comes in, style notes, and whether its print spec is VERIFIED against the ' +
      'print provider or only a planning figure. Call this before choosing products for a design. Optional "category": ' +
      Products.CATEGORIES.join(', ') + '.',
    schema: { type: 'object', properties: { category: { type: 'string', enum: Products.CATEGORIES } } },
    run: async (args) => {
      const cat = catalog();
      const category = str(args && args.category);
      if (category && !Products.CATEGORIES.includes(category)) throw new Error('unknown category "' + category + '". Categories: ' + Products.CATEGORIES.join(', '));
      const list = cat.list(category ? { category } : {});
      const lines = list.map(p => {
        const pls = p.placements.map(pl => pl.id + ' ' + pl.widthPx + 'x' + pl.heightPx + 'px (' + pl.widthIn + 'x' + pl.heightIn + 'in @' + pl.dpi + 'dpi, min ' + pl.minDpi + ', aspect ' + pl.aspect + ')').join('; ');
        return '- ' + p.id + ' — ' + p.label + ' [' + p.category + '] ' + (p.verified ? 'VERIFIED spec' : 'UNVERIFIED planning spec') +
          '\n  placements: ' + pls +
          (p.fabrics.length ? '\n  fabrics: ' + p.fabrics.map(f => f.id + ' (' + f.kind + ' ' + f.hex + ')').join(', ') : '\n  fabrics: none') +
          '\n  needs transparent background: ' + (p.transparentBackground ? 'yes' : 'no') +
          (p.styleNotes ? '\n  notes: ' + p.styleNotes : '') +
          (p.verified ? '' : '\n  spec caveat: ' + p.sourceNote);
      });
      return {
        content: list.length + ' product(s)' + (category ? ' in ' + category : '') + (cat.checkedOn ? ' (specs checked ' + cat.checkedOn + ')' : '') + ':\n' + lines.join('\n') +
          (cat.overrideError ? '\nNOTE: ' + cat.overrideError : ''),
        summary: 'catalog → ' + list.length + ' product(s)',
        data: { products: list, overrideApplied: cat.overrideApplied, overrideError: cat.overrideError }
      };
    }
  };

  // ---------------- art_inspect ----------------
  const inspectTool = {
    name: 'art_inspect', capability: 'studio', scope: 'read', requiresConsent: false, timeoutMs: TOOL_TIMEOUT_MS,
    description: 'Measure a design image file: pixel size, whether its background is transparent / a flat colour / none (full-bleed), ' +
      'the bounding box of the actual artwork, how much of the canvas it covers, and its dominant colours. These are measurements, ' +
      'not opinions (use image_analyze to LOOK at the design). Optional "product" (+ "placement", "fill"): also reports whether the ' +
      'artwork is large enough to print there and at what dpi. Reads only; changes nothing.',
    schema: { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: 'the design file (PNG or JPEG) in your workspace or project' },
      product: { type: 'string', description: 'a product id from product_catalog, to check print size against' },
      placement: { type: 'string' },
      fill: { type: 'number', minimum: 0.05, maximum: 1, description: 'share of the print area the art should span (default 1)' }
    } },
    run: async (args, ctx) => {
      args = args || {};
      const aid = (ctx && ctx.agentId) || 'agent';
      const src = await readSource(aid, args.path, ctx);
      let info;
      try { info = await ops().inspect(src.buffer); } catch (e) { throw new Error('could not inspect ' + src.rel + ': ' + artMessage(e)); }
      const bg = info.background.kind === 'flat' ? 'flat ' + info.background.color + (info.background.isDark ? ' (dark)' : ' (light)') : info.background.kind === 'transparent' ? 'transparent' : 'none (full-bleed image)';
      let out = src.rel + ': ' + info.width + 'x' + info.height + ' px (' + info.megapixels + ' MP, aspect ' + info.aspect + ')' +
        '\nBackground: ' + bg +
        '\nArtwork bounds: ' + info.bbox.width + 'x' + info.bbox.height + ' px at (' + info.bbox.x + ', ' + info.bbox.y + '), covering ' + Math.round(info.coverage * 100) + '% of the canvas' +
        (info.empty ? '\nWARNING: the image contains only background — there is no artwork in it.' : '') +
        '\nDominant colours: ' + (info.dominantColors.map(c => c.hex + ' ' + Math.round(c.share * 100) + '%').join(', ') || 'none');
      const data = { path: src.rel, inspect: info, print: null };
      const productId = str(args.product);
      if (productId) {
        const cat = catalog();
        const p = cat.get(productId);
        if (!p || !p.enabled) throw new Error(cat.resolve(productId, null, null).error);
        const pl = str(args.placement) ? p.placements.find(x => x.id === str(args.placement)) : p.placements[0];
        if (!pl) throw new Error('product ' + productId + ' has no placement "' + str(args.placement) + '". Its placements: ' + p.placements.map(x => x.id).join(', '));
        // judged on the ARTWORK (what art_prepare places after trimming), not the canvas around it
        const useArt = p.transparentBackground && info.background.kind !== 'none' && !info.empty;
        const w = useArt ? info.bbox.width : info.width, h = useArt ? info.bbox.height : info.height;
        const check = ops().printCheck(w, h, pl, { fill: args.fill, mode: pl.defaultMode, anchor: pl.defaultAnchor });
        data.print = { product: p.id, placement: pl.id, verifiedSpec: p.verified, measured: useArt ? 'artwork bounds' : 'whole image', check };
        out += '\nOn ' + p.id + '/' + pl.id + ' (' + pl.widthPx + 'x' + pl.heightPx + ' px' + (p.verified ? '' : ', UNVERIFIED spec') + '): ' +
          (check.ok ? 'prints at ' + check.effectiveDpi + ' dpi (minimum ' + check.requiredDpi + ') — large enough'
            : 'TOO SMALL — would print at ' + check.effectiveDpi + ' dpi, below the minimum ' + check.requiredDpi +
              (check.maxFillAtMinDpi > 0 ? '; it could fill at most ' + Math.round(check.maxFillAtMinDpi * 100) + '% of the print area' : '')) +
          ' [measured on the ' + data.print.measured + ']';
      }
      return { content: out, summary: 'inspect → ' + src.rel, data };
    }
  };

  // ---------------- art_prepare ----------------
  const prepareTool = {
    name: 'art_prepare', capability: 'studio', scope: 'write', requiresConsent: true, timeoutMs: TOOL_TIMEOUT_MS,
    description: 'Make the PRINT FILE of a design for ONE product: a new PNG at exactly the product placement\'s pixel size with the ' +
      'artwork inside the print area. The original file is never changed. For products that need a transparent background it removes a ' +
      'FLAT background colour and trims to the artwork first (a photographic background is NOT cut out — the result says so). ' +
      'Options: "fabric" (required for fabric products), "fill" (0-1 share of the print area, default 1), "mode" (contain | cover), ' +
      '"anchor" (center, top, bottom, ...), "recolor" (none | separate | outline — help artwork that vanishes into the fabric colour), ' +
      '"remove_background" / "trim" (true/false to override the automatic choice), "out" (output filename). It REFUSES, with the ' +
      'numbers, when the artwork is too small to print at the product\'s minimum dpi — lower "fill" or skip that product; it never ' +
      'stretches. The result reports the size written, the dpi it prints at, and whether the product spec is verified.',
    schema: { type: 'object', required: ['product'], properties: {
      path: { type: 'string', description: 'the design file (PNG or JPEG) in your workspace or project. Optional when "design" is given (its recorded file is used)' },
      design: { type: 'string', description: 'the design id (dsn_…) from the work item: records this print file on that design. The product must be in the design\'s submitted plan' },
      product: { type: 'string', description: 'product id from product_catalog' },
      placement: { type: 'string', description: 'placement id (default: the product\'s first)' },
      fabric: { type: 'string', description: 'fabric colour id, for fabric products' },
      fill: { type: 'number', minimum: 0.05, maximum: 1 },
      mode: { type: 'string', enum: ['contain', 'cover'] },
      anchor: { type: 'string' },
      recolor: { type: 'string', enum: ['none', 'separate', 'outline'] },
      remove_background: { type: 'boolean' },
      trim: { type: 'boolean' },
      out: { type: 'string', description: 'output filename (default art/<design>/<product>[-<fabric>].png)' }
    } },
    run: async (args, ctx) => {
      args = args || {};
      const aid = (ctx && ctx.agentId) || 'agent';
      const cat = catalog();
      const res = cat.resolve(str(args.product), str(args.placement) || null, str(args.fabric) || null);
      if (!res.ok) throw new Error(res.error);
      const { product, placement, fabric } = res;
      const recolor = str(args.recolor) || 'none';
      if (recolor !== 'none' && !fabric) throw new Error('recolor "' + recolor + '" needs a fabric product: ' + product.id + ' has no fabric colour to separate from');
      const design = designOf(args.design, false);
      if (design) {
        // refuse BEFORE any work: a print file for a product nobody planned would be an orphan the record cannot hold
        if (!design.plan) throw new Error('design ' + design.id + ' has no product plan yet — a plan must be submitted (product_plan_submit) before print files are made');
        if (!design.plan.products.some(p => p.productId === product.id)) throw new Error('product ' + product.id + ' is not in design ' + design.id + '\'s plan (' + design.plan.products.map(p => p.productId).join(', ') + ')');
      }
      const src = await readSource(aid, str(args.path) || (design ? design.source.storedRel : ''), ctx);

      // choose the output first: an invalid or source-clobbering path must fail before any work
      let rel = str(args.out) || ((design ? 'designs/' + design.id + '/print/' : 'art/' + slug(P.basename(src.rel)) + '/') + product.id + (fabric ? '-' + fabric.id : '') + '.png');
      if (!/\.png$/i.test(rel)) rel = rel.replace(/\.[a-z0-9]+$/i, '') + '.png';
      const placed = await jail.resolveInside(aid, rel, { scope: 'write', ctx });
      if (P.resolve(placed.abs) === P.resolve(src.abs)) throw new Error('the output would overwrite the original design (' + src.rel + '). Originals are never modified — choose a different "out" name.');

      const o = ops();
      const steps = [];
      let buf = src.buffer;
      try {
        const info = await o.inspect(buf);
        if (info.empty) throw new ArtOps.ArtError('ART_EMPTY_ART', 'the image contains only background — there is no artwork to place');
        const wantsCutout = product.transparentBackground;
        const doRemove = args.remove_background === true || (args.remove_background !== false && wantsCutout && info.background.kind === 'flat');
        if (doRemove) {
          const r = await o.removeBackground(buf);
          if (r.removed) { buf = r.buffer; steps.push('removed the flat ' + r.color + ' background (' + Math.round(r.clearedShare * 100) + '% of the canvas)'); }
          else steps.push('background NOT removed: ' + r.reason);
        } else if (wantsCutout && info.background.kind === 'none') {
          steps.push('NOTE: this product prints best with a transparent background, but the design is a full-bleed image with no flat background to remove — it will print as a rectangle');
        }
        const doTrim = args.trim === true || (args.trim !== false && wantsCutout);
        if (doTrim) {
          const t = await o.trim(buf);
          if (t.trimmed) { buf = t.buffer; steps.push('trimmed to the artwork (' + t.width + 'x' + t.height + ' px)'); }
        }
        if (recolor !== 'none') {
          const before = await o.fabricContrast(buf, fabric.hex);
          const r = await o.recolorForFabric(buf, { fabric: fabric.hex, strategy: recolor });
          buf = r.buffer;
          steps.push(recolor === 'outline'
            ? 'added a ' + r.outlineWidth + ' px ' + r.outlineColor + ' outline' + (r.note ? ' (' + r.note + ')' : '')
            : 'recoloured ' + Math.round(r.changedShare * 100) + '% of the artwork away from the ' + fabric.label.toLowerCase() + ' fabric (' + Math.round(before.lowContrastShare * 100) + '% was nearly the fabric colour)');
        }
        const placedArt = await o.place(buf, placement, {
          fill: args.fill, mode: str(args.mode) || placement.defaultMode, anchor: str(args.anchor) || placement.defaultAnchor });
        const contrast = fabric ? await o.fabricContrast(placedArt.buffer, fabric.hex) : null;

        await fsp.mkdir(P.dirname(placed.abs), { recursive: true });
        // stage then rename: a failure mid-write never leaves a half print file under the real name
        const staging = placed.abs + '.pending-' + process.pid;
        try { await fsp.writeFile(staging, placedArt.buffer); await fsp.rename(staging, placed.abs); }
        catch (e) { await fsp.unlink(staging).catch(require('../../failopen.js').swallow('art.staging-cleanup')); throw e; }
        emitDeliverable(ctx, aid, rel);

        const where = await jail.outputPlacement(aid, placed);
        const data = {
          source: src.rel, output: rel, product: product.id, placement: placement.id, fabric: fabric ? fabric.id : null,
          width: placedArt.width, height: placedArt.height, artRect: placedArt.artRect, scale: placedArt.scale,
          effectiveDpi: placedArt.effectiveDpi, requiredDpi: placedArt.requiredDpi, upscaled: placedArt.upscaled,
          verifiedSpec: product.verified, steps, lowContrastShare: contrast ? contrast.lowContrastShare : null
        };
        let recorded = '';
        if (design) {
          try { await store.addVariant(design.id, Object.assign({}, data, { productId: product.id, placementId: placement.id, fabricId: fabric ? fabric.id : null, path: rel })); await noteRun(design, ctx); recorded = '\nRecorded on design ' + design.id + '.'; }
          catch (e) { recorded = '\nNOT RECORDED on design ' + design.id + ': ' + storeMessage(e) + ' (the file was still written).'; }
        }
        return {
          content: 'Print file saved: ' + rel + ' — ' + placedArt.width + 'x' + placedArt.height + ' px for ' + product.label + ' / ' + placement.label +
            (fabric ? ' on ' + fabric.label + ' fabric' : '') + '.' +
            '\nArtwork: ' + placedArt.artRect.width + 'x' + placedArt.artRect.height + ' px at (' + placedArt.artRect.x + ', ' + placedArt.artRect.y + '), printing at ' +
              placedArt.effectiveDpi + ' dpi (minimum ' + placedArt.requiredDpi + ')' + (placedArt.upscaled ? ' — ENLARGED ' + placedArt.scale + 'x from the source, within the minimum' : '') + '.' +
            (steps.length ? '\nSteps: ' + steps.join('; ') + '.' : '\nSteps: placed as-is.') +
            (contrast ? '\nOn this fabric, ' + Math.round(contrast.lowContrastShare * 100) + '% of the artwork is nearly the fabric colour' + (contrast.lowContrastShare > 0.15 && recolor === 'none' ? ' — consider recolor:"separate" or "outline", or a different fabric.' : '.') : '') +
            (product.verified ? '' : '\nSPEC NOT VERIFIED: ' + product.sourceNote) +
            '\nThe original ' + src.rel + ' was not changed.' + recorded +
            '\n' + where.line + (where.viewer ? '\nView: ' + where.viewer : ''),
          summary: 'print file → ' + rel,
          data
        };
      } catch (e) {
        if (e instanceof ArtOps.ArtError) {
          // too small to print is a FACT about this design on this product: note it on the record as a skip. A later
          // successful art_prepare for the same product (a smaller fill) clears it.
          let noted = '';
          if (design && e.code === 'ART_TOO_SMALL') {
            try { await store.skipProduct(design.id, product.id, e.message); noted = ' Recorded on design ' + design.id + ' as skipped for now; a smaller "fill" may still work.'; }
            catch (se) { noted = ' (could not note this on design ' + design.id + ': ' + storeMessage(se) + ')'; }
          }
          throw new Error('art_prepare could not make ' + product.id + ' from ' + src.rel + ': ' + e.message + '. No file was written.' + noted);
        }
        throw e;
      }
    }
  };

  // ---------------- design_get ----------------
  const designGetTool = {
    name: 'design_get', capability: 'studio', scope: 'read', requiresConsent: false, timeoutMs: 15000,
    description: 'Read a dropped design\'s record: its file path and pixel size, the measured background and artwork bounds, the ' +
      'submitted product plan (if any), every print file made so far with its dpi and review verdict, mockups, and anything that ' +
      'went wrong. Call it first when you are handed a design id, so you work from what has actually been done.',
    schema: { type: 'object', required: ['design'], properties: { design: { type: 'string', description: 'the design id (dsn_…)' } } },
    run: async (args) => {
      const rec = designOf(args && args.design, true);
      const f = rec.facts;
      const lines = ['Design ' + rec.id + ' — status: ' + rec.status,
        'File: ' + rec.source.storedRel + ' (' + rec.source.width + 'x' + rec.source.height + ' px; original name ' + rec.source.originalName + ')'];
      if (f) lines.push('Measured: background ' + (f.background.kind === 'flat' ? 'flat ' + f.background.color : f.background.kind) +
        '; artwork ' + f.bbox.width + 'x' + f.bbox.height + ' px covering ' + Math.round(f.coverage * 100) + '% of the canvas; dominant colours ' + f.dominantColors.slice(0, 4).map(c => c.hex).join(', '));
      if (!rec.plan) lines.push('Plan: none submitted yet.');
      else {
        lines.push('Plan (fit judgement, ranked):');
        for (const p of rec.plan.products) lines.push('  ' + p.score + '  ' + p.productId + '/' + p.placementId + (p.fabricId ? ' on ' + p.fabricId : '') + (p.verifiedSpec ? '' : ' [unverified spec]') + ' — ' + p.why);
        for (const k of (rec.plan.skipped || [])) lines.push('  skipped ' + k.productId + ' (' + k.by + '): ' + k.reason);
      }
      if (rec.analysis) lines.push('Seen in the design: ' + rec.analysis.summary + (rec.analysis.textInArt ? ' Text in the art: ' + rec.analysis.textInArt : ''));
      lines.push(rec.variants.length ? 'Print files:' : 'Print files: none yet.');
      for (const v of rec.variants) lines.push('  ' + v.productId + (v.fabricId ? ' on ' + v.fabricId : '') + ' -> ' + v.path + ' (' + v.width + 'x' + v.height + ' px, ' + v.effectiveDpi + ' dpi' +
        (v.lowContrastShare != null ? ', ' + Math.round(v.lowContrastShare * 100) + '% near the fabric colour' : '') + ') — review: ' +
        (v.review ? v.review.verdict + (v.review.notes ? ' — ' + v.review.notes : '') : 'not reviewed') + (v.reviewRounds ? ' [redo rounds used: ' + v.reviewRounds + ']' : ''));
      if (rec.mockups.length) { lines.push('Mockups:'); for (const m of rec.mockups) lines.push('  ' + m.productId + (m.fabricId ? ' on ' + m.fabricId : '') + ' -> ' + m.path); }
      if (rec.errors.length) { lines.push('Problems recorded:'); for (const e of rec.errors.slice(-5)) lines.push('  ' + e.stage + ': ' + e.message); }
      return { content: lines.join('\n'), summary: 'design → ' + rec.id + ' (' + rec.status + ')', data: rec };
    }
  };

  // ---------------- product_plan_submit ----------------
  const planTool = {
    name: 'product_plan_submit', capability: 'studio', scope: 'write', requiresConsent: false, timeoutMs: 15000,
    description: 'Record your decision of which products a design should be made into. Look at the design first (image_analyze) and ' +
      'read product_catalog. Submit "analysis" (what the design shows: summary, subjects, mood, palette, textInArt) and "products": ' +
      '1 to ' + PlanSchema.MAX_PRODUCTS + ' entries ranked best first, each { productId, fabricId (for fabric products), placementId (optional), ' +
      'score (0-100 whole number), why (specific to THIS design), titleIdeas (optional) }. Optional "skipped": [{ productId, reason }] for ' +
      'products you ruled out. The score is YOUR FIT JUDGEMENT — how well this design suits the product\'s shape, size and fabric. It is not ' +
      'sales data and must not be described as such. The plan is checked against the catalog; every problem is reported at once so you ' +
      'can fix and resubmit. A plan can be replaced until the first print file is made.',
    schema: { type: 'object', required: ['design', 'analysis', 'products'], properties: {
      design: { type: 'string', description: 'the design id (dsn_…) from the work item' },
      analysis: { type: 'object', properties: { summary: { type: 'string' }, subjects: { type: 'array', items: { type: 'string' } }, mood: { type: 'string' },
        palette: { type: 'array', items: { type: 'string' } }, textInArt: { type: 'string' }, notes: { type: 'string' } } },
      products: { type: 'array', items: { type: 'object', required: ['productId', 'score', 'why'], properties: {
        productId: { type: 'string' }, placementId: { type: 'string' }, fabricId: { type: 'string' }, score: { type: 'integer', minimum: 0, maximum: 100 },
        why: { type: 'string' }, titleIdeas: { type: 'array', items: { type: 'string' } } } } },
      skipped: { type: 'array', items: { type: 'object', properties: { productId: { type: 'string' }, reason: { type: 'string' } } } }
    } },
    run: async (args, ctx) => {
      args = args || {};
      const rec = designOf(args.design, true);
      const v = PlanSchema.validatePlan({ analysis: args.analysis, products: args.products, skipped: args.skipped }, catalog());
      if (!v.ok) throw new Error('the plan was NOT recorded. Fix these and submit again:\n- ' + v.errors.join('\n- '));
      let saved;
      try { saved = await store.setPlan(rec.id, v.analysis, v.plan, { agentId: ctx && ctx.agentId, model: ctx && ctx.model }); }
      catch (e) { throw new Error('the plan was NOT recorded: ' + storeMessage(e)); }
      await noteRun(rec, ctx);
      const unverified = v.plan.products.filter(p => !p.verifiedSpec).map(p => p.productId);
      return {
        content: 'Plan recorded on design ' + rec.id + ' (status: ' + saved.status + '): ' + v.plan.products.map(p => p.productId + (p.fabricId ? '/' + p.fabricId : '') + ' ' + p.score).join(', ') + '.' +
          (v.plan.skipped.length ? '\nSkipped: ' + v.plan.skipped.map(k => k.productId).join(', ') + '.' : '') +
          (unverified.length ? '\nNote: the print specs of ' + unverified.join(', ') + ' are unverified planning figures.' : '') +
          '\nThe scores are recorded as fit judgements, not sales data.',
        summary: 'plan → ' + rec.id + ' (' + v.plan.products.length + ' product(s))',
        data: saved
      };
    }
  };

  // ---------------- design_review ----------------
  const reviewTool = {
    name: 'design_review', capability: 'studio', scope: 'write', requiresConsent: false, timeoutMs: 15000,
    description: 'Record your verdict on ONE print file of a design after LOOKING at it (image_analyze on the print file path from ' +
      'design_get). "verdict": "pass" (good to mock up) or "redo" (the Designer should remake it — "notes" must then say exactly what to ' +
      'change: a different fill, anchor, fabric or recolor). Check: is the subject cropped or cut off, is text legible at this size, does ' +
      'the art read against the fabric colour, are there background remnants or rough edges. A print file can be sent back at most twice; ' +
      'after that it is marked for the owner to look at and is NOT sent back again — the result tells you when that happened.',
    schema: { type: 'object', required: ['design', 'product', 'verdict'], properties: {
      design: { type: 'string' }, product: { type: 'string' }, fabric: { type: 'string', description: 'needed only when the product was made on more than one fabric' },
      verdict: { type: 'string', enum: ['pass', 'redo'] }, notes: { type: 'string' } } },
    run: async (args, ctx) => {
      args = args || {};
      const rec = designOf(args.design, true);
      const verdict = str(args.verdict), notes = str(args.notes);
      if (verdict !== 'pass' && verdict !== 'redo') throw new Error('verdict must be "pass" or "redo"');
      if (verdict === 'redo' && notes.length < 15) throw new Error('a "redo" needs notes that tell the Designer exactly what to change (at least a sentence)');
      let saved;
      try { saved = await store.setReview(rec.id, { productId: str(args.product), fabricId: str(args.fabric) || undefined }, { verdict, notes }); }
      catch (e) { throw new Error('the review was NOT recorded: ' + storeMessage(e)); }
      await noteRun(rec, ctx);
      const row = saved.variants.find(x => x.productId === str(args.product) && (!str(args.fabric) || x.fabricId === str(args.fabric)));
      const final = row.review.verdict;
      const waiting = saved.variants.filter(x => !x.review || x.review.verdict === 'redo').map(x => x.productId);
      return {
        content: 'Review recorded on design ' + rec.id + ': ' + row.productId + ' — ' + final.toUpperCase() +
          (final === 'needs-owner' ? '. The redo limit (2 rounds) was already used, so this print file is NOT being sent back again: it goes to the owner marked "needs owner review". Do not ask for it to be remade.'
            : final === 'redo' ? ' (redo round ' + row.reviewRounds + ' of 2). The Designer should remake it following your notes.' : '.') +
          (waiting.length ? '\nStill to review or waiting on a redo: ' + waiting.join(', ') + '.' : '\nEvery print file has a final verdict.'),
        summary: 'review → ' + rec.id + ' ' + row.productId + ' ' + final,
        data: { verdict: final, reviewRounds: row.reviewRounds, waiting, status: saved.status }
      };
    }
  };

  // ---------------- mockup_render ----------------
  const mockupTool = {
    name: 'mockup_render', capability: 'studio', scope: 'write', requiresConsent: true, timeoutMs: TOOL_TIMEOUT_MS,
    description: 'Render a product MOCKUP from a print file: the print file is placed onto a picture of the product and saved as a new ' +
      'PNG. With "design" + "product" (+ "fabric" when the product was made on more than one) it uses that design\'s recorded print ' +
      'file, records the mockup on the design, and marks the design READY once every print file has a mockup. Without a design, give ' +
      '"path" (a print file) and "product". Optional "template": a template id (the default is the product\'s own; an unknown id lists ' +
      'the real ones). The built-in templates are simple DRAWN products, not photographs, and are labelled as such; a mockup is a ' +
      'picture for a listing, not a colour-accurate print proof.',
    schema: { type: 'object', required: ['product'], properties: {
      design: { type: 'string', description: 'the design id (dsn_…)' }, product: { type: 'string' }, fabric: { type: 'string' },
      path: { type: 'string', description: 'a print file, when no design is given' }, template: { type: 'string' }, out: { type: 'string' } } },
    run: async (args, ctx) => {
      args = args || {};
      const aid = (ctx && ctx.agentId) || 'agent';
      const cat = catalog();
      const productId = str(args.product);
      const product = cat.get(productId);
      if (!product) throw new Error(cat.resolve(productId, null, null).error);
      const design = designOf(args.design, false);
      let printRel, fabricId = str(args.fabric) || null;
      if (design) {
        const made = design.variants.filter(v => v.productId === productId);
        if (!made.length) throw new Error('design ' + design.id + ' has no print file for ' + productId + ' yet — a mockup needs one (art_prepare first). Print files so far: ' + (design.variants.map(v => v.productId).join(', ') || 'none'));
        const v = fabricId ? made.find(x => x.fabricId === fabricId) : (made.length === 1 ? made[0] : null);
        if (!v) throw new Error(fabricId ? 'design ' + design.id + ' has no ' + productId + ' print file on fabric "' + fabricId + '". Made on: ' + made.map(x => x.fabricId).join(', ')
          : productId + ' was made on more than one fabric (' + made.map(x => x.fabricId).join(', ') + ') — say which with "fabric"');
        if (v.review && v.review.verdict === 'redo') throw new Error(productId + ' is waiting on a redo (the Reviewer sent it back) — it must be remade before it is mocked up');
        printRel = v.path; fabricId = v.fabricId;
      } else printRel = str(args.path);
      if (!printRel) throw new Error('give "design" (to use its recorded print file) or "path" (a print file)');
      const fabric = fabricId ? product.fabrics.find(f => f.id === fabricId) : null;
      if (fabricId && !fabric) throw new Error('product ' + productId + ' is not offered in fabric "' + fabricId + '". Its fabrics: ' + (product.fabrics.map(f => f.id).join(', ') || 'none'));

      const M = mockups();
      const tpl = str(args.template) ? M.get(str(args.template)) : M.forProduct(productId);
      if (!tpl) throw new Error(str(args.template) ? 'no mockup template "' + str(args.template) + '". Templates for ' + productId + ': ' + (M.list(productId).map(t => t.id).join(', ') || 'none')
        : 'there is no mockup template for ' + productId + ' yet — no mockup was made');
      if (!tpl.productIds.includes(productId)) throw new Error('template ' + tpl.id + ' shows ' + tpl.productIds.join(', ') + ', not ' + productId + '. Templates for ' + productId + ': ' + (M.list(productId).map(t => t.id).join(', ') || 'none'));

      const src = await readSource(aid, printRel, ctx);
      const rel0 = str(args.out) || ((design ? 'designs/' + design.id + '/mockups/' : 'art/mockups/' + slug(P.basename(P.dirname(src.rel))) + '-') + productId + (fabricId ? '-' + fabricId : '') + '--' + tpl.id + '.png');
      const rel = /\.png$/i.test(rel0) ? rel0 : rel0.replace(/\.[a-z0-9]+$/i, '') + '.png';
      const placed = await jail.resolveInside(aid, rel, { scope: 'write', ctx });
      if (P.resolve(placed.abs) === P.resolve(src.abs)) throw new Error('the mockup would overwrite the print file — choose a different "out" name');
      let m;
      try { m = await M.render(src.buffer, tpl.id, { fabricHex: fabric ? fabric.hex : undefined }); }
      catch (e) { throw new Error('mockup_render could not render ' + productId + ' on ' + tpl.id + ': ' + artMessage(e) + '. No file was written.'); }
      await fsp.mkdir(P.dirname(placed.abs), { recursive: true });
      const staging = placed.abs + '.pending-' + process.pid;
      try { await fsp.writeFile(staging, m.buffer); await fsp.rename(staging, placed.abs); }
      catch (e) { await fsp.unlink(staging).catch(require('../../failopen.js').swallow('art.mockup.staging-cleanup')); throw e; }
      emitDeliverable(ctx, aid, rel);

      let recorded = '', ready = '';
      if (design) {
        try {
          await store.addMockup(design.id, { productId, fabricId, templateId: tpl.id, path: rel, width: m.width, height: m.height });
          await noteRun(design, ctx);
          recorded = '\nRecorded on design ' + design.id + '.';
          // READY is a fact about the record, checked by the record: every print file mocked up, none waiting on a redo
          try { const done = await store.markReady(design.id); ready = '\nDesign ' + design.id + ' is now ' + done.status.toUpperCase() + ': every print file has a mockup. It is waiting for the owner in the Gallery.'; }
          catch (e) { if (!(e instanceof DesignError && e.code === 'DESIGN_NOT_READY')) throw e; ready = '\nNot ready yet — ' + e.message + '.'; }
        } catch (e) { recorded = '\nNOT RECORDED on design ' + design.id + ': ' + storeMessage(e) + ' (the file was still written).'; }
      }
      const where = await jail.outputPlacement(aid, placed);
      return {
        content: 'Mockup saved: ' + rel + ' — ' + m.width + 'x' + m.height + ' px, ' + product.label + (fabric ? ' in ' + fabric.label : '') + ' on template ' + tpl.id +
          (m.kind === 'drawn' ? ' (a simple DRAWN product, not a photograph)' : ' (the owner\'s own template; stated license: ' + m.license + ')') + '.' +
          '\nA mockup is a picture for a listing, not a colour-accurate print proof.' + recorded + ready +
          '\n' + where.line + (where.viewer ? '\nView: ' + where.viewer : ''),
        summary: 'mockup → ' + rel,
        data: { output: rel, product: productId, fabric: fabricId, templateId: tpl.id, kind: m.kind, width: m.width, height: m.height }
      };
    }
  };

  // the three record tools exist only where a design store is wired; the others always do
  const tools = store ? [catalogTool, inspectTool, prepareTool, mockupTool, designGetTool, planTool, reviewTool] : [catalogTool, inspectTool, prepareTool, mockupTool];
  return {
    tools, catalogTool, inspectTool, prepareTool, mockupTool, designGetTool, planTool, reviewTool,
    register(reg) { for (const t of tools) reg.register(t); return reg; },
    _internals: { readSource, slug, MAX_SOURCE_BYTES }
  };
}

module.exports = { makeArtTools };
