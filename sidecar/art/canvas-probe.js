/* sidecar/art/canvas-probe.js — does the image library actually work HERE? (Art Studio Phase 1a spike)

   The art engine (trim / fit / place / recolor / mockup compositing) is built on @napi-rs/canvas, a NATIVE module.
   A native module that loads in a dev checkout can still be missing or unloadable inside an installed desktop app,
   where node_modules is a staged, pruned tree beside sidecar/ and Node is the bundled runtime. This probe exercises
   every primitive the engine depends on and reports exactly what happened. It asserts nothing it did not do.

     node sidecar/art/canvas-probe.js            -> one JSON line on stdout; exit 0 only if every check passed
     require('./canvas-probe.js').runProbe()     -> the same report object

   The Windows packaged proof runs this with the INSTALLED app's own node.exe against the INSTALLED sidecar
   (.github/workflows/art-canvas-windows.yml). Decision rule (docs/ART_STUDIO_OVERHAUL_PLAN.md, Phase 1a):
   ok:true there => build on @napi-rs/canvas; otherwise the pure-JS fallback goes behind the same adapter. */
'use strict';

function runProbe(load) {
  const report = { ok: false, library: '@napi-rs/canvas', version: null, resolvedFrom: null,
    node: process.version, platform: process.platform, arch: process.arch, checks: [], error: null };
  const check = (name, fn) => {
    try { const detail = fn(); report.checks.push({ name, ok: true, detail: detail === undefined ? null : detail }); return true; }
    catch (e) { report.checks.push({ name, ok: false, detail: String((e && e.message) || e) }); return false; }
  };
  const must = (cond, msg) => { if (!cond) throw new Error(msg); };

  let C = null;
  const loaded = check('load native module', () => {
    C = load ? load() : require('@napi-rs/canvas');
    try { report.resolvedFrom = require.resolve('@napi-rs/canvas'); } catch (_) {}
    try { report.version = require('@napi-rs/canvas/package.json').version; } catch (_) {}
    must(C && typeof C.createCanvas === 'function' && typeof C.loadImage === 'function', 'createCanvas/loadImage missing');
    return report.version;
  });
  if (!loaded) { report.error = report.checks[0].detail; return Promise.resolve(report); }

  let png = null, jpg = null;
  check('draw + encode PNG with alpha', () => {
    const cv = C.createCanvas(64, 48), g = cv.getContext('2d');
    g.clearRect(0, 0, 64, 48);
    g.fillStyle = '#ff00aa'; g.fillRect(16, 12, 32, 24);
    png = cv.toBuffer('image/png');
    must(png && png.length > 60 && png[0] === 0x89 && png[1] === 0x50, 'not a PNG');
    return png.length + ' bytes';
  });
  check('encode JPEG', () => {
    const cv = C.createCanvas(32, 32), g = cv.getContext('2d');
    g.fillStyle = '#2040ff'; g.fillRect(0, 0, 32, 32);
    jpg = cv.toBuffer('image/jpeg');
    must(jpg && jpg[0] === 0xff && jpg[1] === 0xd8, 'not a JPEG');
    return jpg.length + ' bytes';
  });

  return (async () => {
    let img = null;
    const asyncCheck = async (name, fn) => {
      try { const detail = await fn(); report.checks.push({ name, ok: true, detail: detail === undefined ? null : detail }); }
      catch (e) { report.checks.push({ name, ok: false, detail: String((e && e.message) || e) }); }
    };
    await asyncCheck('decode PNG from a buffer', async () => {
      must(png, 'no PNG to decode');
      img = await C.loadImage(png);
      must(img.width === 64 && img.height === 48, 'decoded size ' + img.width + 'x' + img.height);
      return img.width + 'x' + img.height;
    });
    await asyncCheck('decode JPEG from a buffer', async () => {
      must(jpg, 'no JPEG to decode');
      const j = await C.loadImage(jpg);
      must(j.width === 32 && j.height === 32, 'decoded size ' + j.width + 'x' + j.height);
    });
    check('read pixels (alpha preserved, colour exact)', () => {
      must(img, 'no decoded image');
      const cv = C.createCanvas(64, 48), g = cv.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, 64, 48).data;
      const at = (x, y) => Array.from(d.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
      const corner = at(1, 1), mid = at(32, 24);
      must(corner[3] === 0, 'transparent corner has alpha ' + corner[3]);
      must(mid[0] === 255 && mid[1] === 0 && mid[2] === 170 && mid[3] === 255, 'centre pixel ' + mid.join(','));
      return 'corner a=0, centre ' + mid.join(',');
    });
    check('scale to a print-size canvas (4500x5400)', () => {
      must(img, 'no decoded image');
      const cv = C.createCanvas(4500, 5400), g = cv.getContext('2d');
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, 4500, 5400);
      const d = g.getImageData(2250, 2700, 1, 1).data;
      must(d[0] === 255 && d[2] === 170 && d[3] === 255, 'centre pixel after upscale ' + Array.from(d).join(','));
      const out = cv.toBuffer('image/png');
      must(out.length > 1000, 'print-size PNG too small');
      return (out.length / 1024).toFixed(0) + ' KB PNG';
    });
    check('write pixels back (putImageData)', () => {
      const cv = C.createCanvas(2, 1), g = cv.getContext('2d');
      const id = g.createImageData(2, 1);
      id.data.set([10, 20, 30, 255, 0, 0, 0, 0]);
      g.putImageData(id, 0, 0);
      const d = g.getImageData(0, 0, 2, 1).data;
      must(d[0] === 10 && d[1] === 20 && d[2] === 30 && d[3] === 255 && d[7] === 0, 'round-trip ' + Array.from(d).join(','));
    });
    check('multiply blend (mockup shading)', () => {
      const cv = C.createCanvas(4, 4), g = cv.getContext('2d');
      // colours chosen so a blend mode that was silently ignored (plain source-over => 128,128,255) cannot pass
      g.fillStyle = '#ff8000'; g.fillRect(0, 0, 4, 4);
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = '#8080ff'; g.fillRect(0, 0, 4, 4);
      const d = g.getImageData(1, 1, 1, 1).data;
      must(Math.abs(d[0] - 128) <= 2 && Math.abs(d[1] - 64) <= 2 && d[2] <= 2 && d[3] === 255, 'multiply gave ' + Array.from(d).join(','));
    });
    check('mask with destination-in (print area clip)', () => {
      const cv = C.createCanvas(4, 4), g = cv.getContext('2d');
      g.fillStyle = '#00ff00'; g.fillRect(0, 0, 4, 4);
      g.globalCompositeOperation = 'destination-in';
      g.fillStyle = '#000000'; g.fillRect(0, 0, 2, 4);
      const d = g.getImageData(0, 0, 4, 1).data;
      must(d[3] === 255 && d[15] === 0, 'mask gave alphas ' + d[3] + ',' + d[15]);
    });
    check('clipped affine transform (perspective warp by triangles)', () => {
      const cv = C.createCanvas(20, 20), g = cv.getContext('2d');
      g.save();
      g.beginPath(); g.moveTo(0, 0); g.lineTo(20, 0); g.lineTo(0, 20); g.closePath(); g.clip();
      g.setTransform(2, 0.1, 0.1, 2, 0, 0);
      g.fillStyle = '#ff0000'; g.fillRect(0, 0, 20, 20);
      g.restore();
      const d = g.getImageData(0, 0, 20, 20).data;
      const a = (x, y) => d[(y * 20 + x) * 4 + 3];
      must(a(2, 2) === 255 && a(18, 18) === 0, 'clip alphas ' + a(2, 2) + ',' + a(18, 18));
    });
    report.ok = report.checks.every(c => c.ok);
    if (!report.ok) report.error = report.checks.filter(c => !c.ok).map(c => c.name + ': ' + c.detail).join(' | ');
    return report;
  })();
}

module.exports = { runProbe };

if (require.main === module) {
  runProbe().then(r => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(r.ok ? 0 : 1); },
    e => { process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }) + '\n'); process.exit(1); });
}
