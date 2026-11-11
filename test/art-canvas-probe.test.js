/* node test/art-canvas-probe.test.js — the image-library probe tells the truth (Art Studio Phase 1a).

   sidecar/art/canvas-probe.js is what the Windows packaged proof runs inside an installed app to decide whether the
   art engine may be built on @napi-rs/canvas. A probe that reports ok when the library is missing or half-working
   would turn that proof into theatre, so: the real library must pass every check here, and a missing or broken
   library must produce ok:false with the failing check named — never a throw, never a silent pass. */
'use strict';
const A = require('./_assert.js');
const path = require('path');
const { spawnSync } = require('child_process');
const { runProbe } = require('../sidecar/art/canvas-probe.js');

const NEEDED = ['load native module', 'draw + encode PNG with alpha', 'encode JPEG', 'decode PNG from a buffer',
  'decode JPEG from a buffer', 'read pixels (alpha preserved, colour exact)', 'scale to a print-size canvas (4500x5400)',
  'write pixels back (putImageData)', 'multiply blend (mockup shading)', 'mask with destination-in (print area clip)',
  'clipped affine transform (perspective warp by triangles)'];

(async () => {
  // 1. the real library, in this checkout
  const real = await runProbe();
  A.eq(real.ok, true, 'the real library passes the probe here' + (real.error ? ' — ' + real.error : ''));
  A.eq(real.checks.map(c => c.name), NEEDED, 'the probe runs every primitive the art engine depends on, in order');
  A.ok(real.checks.every(c => c.ok), 'every check passed');
  A.eq(real.version, require('../package.json').dependencies['@napi-rs/canvas'], 'it reports the pinned library version');
  A.ok(/@napi-rs[\\/]canvas/.test(String(real.resolvedFrom)), 'it reports where the library was resolved from');
  A.eq([real.platform, real.arch], [process.platform, process.arch], 'it reports the runtime it ran on');

  // 2. the library is missing (what a badly staged install looks like)
  const missing = await runProbe(() => { throw new Error("Cannot find module '@napi-rs/canvas'"); });
  A.eq(missing.ok, false, 'a missing library is ok:false');
  A.eq(missing.checks.length, 1, 'and stops at the load check — nothing else is claimed');
  A.ok(/Cannot find module/.test(missing.error), 'the reason is the loader\'s own message');

  // 3. the library loads but is not usable
  const hollow = await runProbe(() => ({}));
  A.eq(hollow.ok, false, 'a module without createCanvas/loadImage is ok:false');

  // 4. the library loads but one primitive is wrong (multiply blend silently ignored)
  const C = require('@napi-rs/canvas');
  const lying = await runProbe(() => ({
    loadImage: C.loadImage,
    createCanvas(w, h) {
      const cv = C.createCanvas(w, h), get = cv.getContext.bind(cv);
      cv.getContext = kind => {
        const g = get(kind);
        return new Proxy(g, {
          get(t, k) { const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; },
          set(t, k, v) { if (k === 'globalCompositeOperation' && v === 'multiply') return true; t[k] = v; return true; }
        });
      };
      return cv;
    }
  }));
  A.eq(lying.ok, false, 'one broken primitive fails the whole probe');
  const bad = lying.checks.filter(c => !c.ok).map(c => c.name);
  A.eq(bad, ['multiply blend (mockup shading)'], 'and exactly that primitive is named');
  A.ok(/multiply blend/.test(lying.error), 'the summary error names it too');

  // 5. the command line contract the workflow relies on: one JSON line, exit 0 only on ok
  const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'sidecar', 'art', 'canvas-probe.js')], { encoding: 'utf8', cwd: require('os').tmpdir() });
  A.eq(cli.status, 0, 'the CLI exits 0 when the probe passes');
  const lines = cli.stdout.trim().split('\n');
  A.eq(lines.length, 1, 'it prints exactly one line');
  A.eq(JSON.parse(lines[0]).ok, true, 'and that line is the JSON report');

  A.report('art-canvas-probe.test');
})();
