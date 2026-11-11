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

   makeArtTools({ fsp, pathMod, root, pathTrust?, artOps?, loadCatalog? }) -> { tools, register(reg), _internals } */
'use strict';

const fsMod = require('./fs.js');
const ArtOps = require('../../art/art-ops.js');
const Products = require('../../art/products.js');

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
  // the catalog is re-read per call so an owner's edit to the override file applies without a restart
  const catalog = () => (typeof deps.loadCatalog === 'function' ? deps.loadCatalog() : Products.loadCatalog());

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
    schema: { type: 'object', required: ['path', 'product'], properties: {
      path: { type: 'string', description: 'the design file (PNG or JPEG) in your workspace or project' },
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
      const src = await readSource(aid, args.path, ctx);

      // choose the output first: an invalid or source-clobbering path must fail before any work
      let rel = str(args.out) || ('art/' + slug(P.basename(src.rel)) + '/' + product.id + (fabric ? '-' + fabric.id : '') + '.png');
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
        return {
          content: 'Print file saved: ' + rel + ' — ' + placedArt.width + 'x' + placedArt.height + ' px for ' + product.label + ' / ' + placement.label +
            (fabric ? ' on ' + fabric.label + ' fabric' : '') + '.' +
            '\nArtwork: ' + placedArt.artRect.width + 'x' + placedArt.artRect.height + ' px at (' + placedArt.artRect.x + ', ' + placedArt.artRect.y + '), printing at ' +
              placedArt.effectiveDpi + ' dpi (minimum ' + placedArt.requiredDpi + ')' + (placedArt.upscaled ? ' — ENLARGED ' + placedArt.scale + 'x from the source, within the minimum' : '') + '.' +
            (steps.length ? '\nSteps: ' + steps.join('; ') + '.' : '\nSteps: placed as-is.') +
            (contrast ? '\nOn this fabric, ' + Math.round(contrast.lowContrastShare * 100) + '% of the artwork is nearly the fabric colour' + (contrast.lowContrastShare > 0.15 && recolor === 'none' ? ' — consider recolor:"separate" or "outline", or a different fabric.' : '.') : '') +
            (product.verified ? '' : '\nSPEC NOT VERIFIED: ' + product.sourceNote) +
            '\nThe original ' + src.rel + ' was not changed.' +
            '\n' + where.line + (where.viewer ? '\nView: ' + where.viewer : ''),
          summary: 'print file → ' + rel,
          data
        };
      } catch (e) {
        if (e instanceof ArtOps.ArtError) throw new Error('art_prepare could not make ' + product.id + ' from ' + src.rel + ': ' + e.message + '. No file was written.');
        throw e;
      }
    }
  };

  const tools = [catalogTool, inspectTool, prepareTool];
  return {
    tools, catalogTool, inspectTool, prepareTool,
    register(reg) { for (const t of tools) reg.register(t); return reg; },
    _internals: { readSource, slug, MAX_SOURCE_BYTES }
  };
}

module.exports = { makeArtTools };
