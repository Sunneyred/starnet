#!/usr/bin/env node
/* dev/gallery-shots.mjs — the GALLERY, live, in a real browser (Art Studio Phase 5 live verification).
 *
 * Boots a seeded sidecar from THIS worktree with NO Full Access, points it at the scripted art provider
 * (test/helpers/art-mock.js — real tool calls, zero spend), drives the REAL app over CDP (the established headless
 * pattern: dev/abilities-shots.mjs, scripts/lib/cdp.mjs) and walks the owner's first run by CLICKING the Gallery's
 * own buttons: place the line, set up the folders, allow saving, drop a PNG, wait for it to reach READY, approve,
 * tick rights, export. A shot is taken at each step, and each step's claim is checked against the server.
 *
 *   node dev/gallery-shots.mjs            (ports: SKYNET_SHOT_PORT / SKYNET_CDP_PORT; out: dev/.shots-gallery)
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { findChrome, connectCDP, evalJS, capture, sleep, collectDiagnostics } from '../scripts/lib/cdp.mjs';
import { materializeSeedWorkspace, bootSeededSidecar, waitUp, waitDevReady } from '../scripts/lib/seed.mjs';

const require = createRequire(import.meta.url);
const { startArtMock } = require('../test/helpers/art-mock.js');
const C = require('@napi-rs/canvas');

const PORT = process.env.SKYNET_SHOT_PORT || '9561';
const CDP_PORT = Number(process.env.SKYNET_CDP_PORT || 9563);
const URL = `http://127.0.0.1:${PORT}/`;
const OUT = process.env.SKYNET_SHOT_OUT || join(process.cwd(), 'dev', '.shots-gallery');
const problems = [];
const check = (ok, what) => { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) problems.push(what); };

// a design in the owner's own style of brief: bold flat shapes on a white page (drawn here; no outside art is used)
function designPng() {
  const cv = C.createCanvas(3000, 3000), g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 3000, 3000);
  g.fillStyle = '#ff00aa'; g.fillRect(400, 300, 2200, 2400);
  g.fillStyle = '#00e5ff'; g.beginPath(); g.arc(1500, 1300, 700, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0b0b0b'; g.fillRect(1150, 950, 700, 700);
  g.fillStyle = '#ffffff'; g.font = 'bold 260px sans-serif'; g.textAlign = 'center'; g.fillText('REDACTED', 1500, 2400);
  return cv.toBuffer('image/png');
}
const click = (act, extra = '') => `(() => { const b = document.querySelector('.gal [data-act="${act}"]${extra}'); if (!b) return 'no-button:${act}'; b.click(); return 'clicked:${act}'; })()`;
const text = `(() => { const g = document.querySelector('.gal'); return g ? g.innerText : ''; })()`;
const api = (path) => `fetch(${JSON.stringify(path)}, { cache: 'no-store' }).then(r => r.json())`;
async function until(cdp, expr, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await evalJS(cdp, expr).catch(() => null); if (v) return v; await sleep(400); }
  check(false, 'timed out waiting for ' + what); return null;
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), 'galleryshots-'));
  const home = join(scratch, 'home'), art = join(home, 'Art Station');
  mkdirSync(art, { recursive: true });
  materializeSeedWorkspace(join(scratch, 'ws'), 'test/model');
  const mock = await startArtMock(0.0001);
  const side = bootSeededSidecar({ port: PORT, scratchDir: join(scratch, 'ws'), fullAccess: false, model: 'test/model', key: 'sk-or-v1-gallery-shots-fake', logFile: join(scratch, 'sidecar.log'),
    env: { HOME: home, USERPROFILE: home, HERMES_HOME: join(scratch, 'hermes'), SKYNET_OPENROUTER_BASE: mock.base, STARNET_TRIGGER_POLL_MS: '400', STARNET_TRIGGER_SETTLE_MS: '250' } });
  let chrome = null, cdp = null;
  try {
    if (!(await waitUp(URL))) throw new Error('sidecar never came up on ' + URL);
    const flags = ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
      `--remote-debugging-port=${CDP_PORT}`, '--window-size=1440,1000', `--user-data-dir=${join(scratch, 'chrome')}`];
    if (userInfo().uid === 0) flags.push('--no-sandbox');   // Chrome refuses to start as root otherwise (a container, not a desktop)
    chrome = spawn(findChrome(), flags.concat(['about:blank']), { stdio: 'ignore' });
    await sleep(1500);
    cdp = await connectCDP(CDP_PORT);
    await cdp.send('Runtime.enable');
    const diag = collectDiagnostics(cdp);
    await evalJS(cdp, `location.href = ${JSON.stringify(URL)}`);
    if (!(await waitDevReady(cdp, evalJS, { url: URL }))) throw new Error('app never reached the game screen');
    await sleep(1500);
    await evalJS(cdp, `(() => { if (document.body) document.body.classList.add('no-flicker'); if (typeof World !== 'undefined' && World.stop) World.stop(); })()`);

    /* 1. the Gallery opens on its setup */
    await evalJS(cdp, `StationUI.openTerm('gallery')`);
    await until(cdp, `(() => { const g = document.querySelector('.gal'); return g && /SET UP/.test(g.innerText) ? g.innerText : null; })()`, 15000, 'the Gallery to open');
    let t = await evalJS(cdp, text);
    check(/SET UP — 0 OF 5 DONE/.test(t) && /PLACE THE ART LINE/.test(t), 'a new station: setup leads, nothing claimed done');
    console.log('shot', await capture(cdp, OUT, '1-setup-empty'));

    /* 2. place the line (one click) */
    console.log(await evalJS(cdp, click('place')));
    t = await until(cdp, `(() => { const g = document.querySelector('.gal'); return g && /Every step has an agent/.test(g.innerText) ? g.innerText : null; })()`, 10000, 'the line to be placed and crewed');
    check(t && /The art line is on your floor/.test(t) && /with a workstation and a STUDIO in reach/.test(t), 'the line is on the floor; the main agent crews all four steps with a desk and the STUDIO');
    console.log('shot', await capture(cdp, OUT, '2-line-placed'));

    /* 3. folders: type the path (the OS folder chooser cannot be driven headless), press SET UP FOLDERS */
    await evalJS(cdp, `(() => { const i = document.querySelector('#gal-folder'); i.value = ${JSON.stringify(art)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    console.log(await evalJS(cdp, click('folders')));
    t = await until(cdp, `(() => { const g = document.querySelector('.gal'); return g && /Your folders are set/.test(g.innerText) ? g.innerText : null; })()`, 20000, 'the folders and the drop trigger');
    const drop = join(art, 'Drop designs here'), studio = join(art, 'Studio files');
    check(existsSync(drop) && existsSync(studio), 'both folders exist on disk');
    const trg = await evalJS(cdp, api('/api/routing/triggers'));
    const mine = ((trg && trg.triggers) || []).find(x => x.config && x.config.intake === 'design');
    check(!!mine && mine.enabled && !mine.blockedBy, 'the server lists the ART DROP trigger, on and unblocked: ' + JSON.stringify(mine && [mine.enabled, mine.blockedBy]));
    console.log('shot', await capture(cdp, OUT, '3-folders-set'));

    /* 4. the one grant */
    check(/Let the line save its files/.test(t || ''), 'saving is NOT allowed until the owner says so');
    console.log(await evalJS(cdp, click('grant')));
    t = await until(cdp, `(() => { const g = document.querySelector('.gal'); return g && /SET UP ✓/.test(g.innerText) ? g.innerText : null; })()`, 10000, 'setup to complete');
    const perms = await evalJS(cdp, api('/api/permissions'));
    check(!!t, 'setup reads complete'); check(!(perms && perms.masterBypass), 'Full Access is still off');
    console.log('shot', await capture(cdp, OUT, '4-setup-done'));

    /* 5. drop a design; wait for the record to reach READY */
    const bytes = designPng();
    writeFileSync(join(drop, 'Neon Angel.png'), bytes);
    const mid = await until(cdp, `(() => { const g = document.querySelector('.gal'); return g && /working on a drop right now/.test(g.innerText) && /Neon Angel\\.png/.test(g.innerText) ? g.innerText : null; })()`, 30000, 'the design to appear while the line works');
    if (mid) { check(!/READY FOR YOU/.test(mid), 'mid-run the card is not shown as ready'); console.log('shot', await capture(cdp, OUT, '5-working')); }
    t = await until(cdp, `(() => { const g = document.querySelector('.gal'); return g && /READY FOR YOU/.test(g.innerText) && !/working on a drop/.test(g.innerText) ? g.innerText : null; })()`, 120000, 'READY FOR YOU');
    await until(cdp, `document.querySelectorAll('.gal .gal-img.ready').length >= 5`, 15000, 'the pictures to load');
    const d = ((await evalJS(cdp, api('/api/art/designs'))) || {}).designs || [];
    check(d.length === 1 && d[0].status === 'ready' && d[0].variants.length === 2 && d[0].mockups.length === 2, 'the server record agrees: ready, 2 print files, 2 mockups');
    check(/FIT 88\/100/.test(t || '') && /spent on this design \(6 runs\)/.test(t || '') && /not a sales forecast/i.test(t || ''), 'the card shows the fit score as a judgement and real spend over 6 runs');
    check(mock.S.toolErrors.length === 0, 'no tool call was refused: ' + JSON.stringify(mock.S.toolErrors.slice(0, 1)));
    console.log('shot', await capture(cdp, OUT, '6-ready'));
    await evalJS(cdp, `(() => { const w = document.querySelector('.gal'); const t = w && w.closest('.term'); const b = t && [...t.querySelectorAll('button')].find(x => /maxim|expand|full/i.test((x.getAttribute('aria-label') || '') + (x.title || ''))); if (b) { b.click(); return 'maximized'; } return 'no-maximize-key'; })()`).then(r => console.log(r));
    await sleep(700);
    await evalJS(cdp, `(() => { const c = document.querySelector('.gal-card'); if (c) c.scrollIntoView({ block: 'start' }); return true; })()`);
    await sleep(500); console.log('shot', await capture(cdp, OUT, '7-card'));
    await evalJS(cdp, `(() => { const c = document.querySelector('.gal-prod .gal-shots'); if (c) c.scrollIntoView({ block: 'center' }); return true; })()`);
    await sleep(500); console.log('shot', await capture(cdp, OUT, '7b-product-pictures'));
    await evalJS(cdp, `(() => { const c = document.querySelector('.gal-card-ft'); if (c) c.scrollIntoView({ block: 'end' }); return true; })()`);
    await sleep(500); console.log('shot', await capture(cdp, OUT, '8-card-lower'));

    /* 6. approve the tee, tick rights, export */
    console.log(await evalJS(cdp, click('approve', '[data-product="tee-front"]')));
    await until(cdp, `(() => /✓ APPROVED/.test(document.querySelector('.gal').innerText))()`, 8000, 'the approval to show');
    console.log(await evalJS(cdp, click('rights')));
    await until(cdp, `(() => { const b = document.querySelector('.gal [data-act="export"]'); return b && !b.disabled; })()`, 8000, 'export to open');
    console.log(await evalJS(cdp, click('export')));
    t = await until(cdp, `(() => { const g = document.querySelector('.gal'); return g && /Nothing was published or uploaded/.test(g.innerText) && /Copied to/.test(g.innerText) ? g.innerText : null; })()`, 10000, 'the export to finish');
    const ex = existsSync(join(studio, 'export')) ? readdirSync(join(studio, 'export')) : [];
    check(ex.length === 1 && existsSync(join(studio, 'export', ex[0], 'tee-front', 'listing.txt')), 'the export folder is on disk with a draft listing');
    await evalJS(cdp, `(() => { const c = document.querySelector('.gal-card-ft'); if (c) c.scrollIntoView({ block: 'end' }); return true; })()`);
    await sleep(400); console.log('shot', await capture(cdp, OUT, '9-exported'));

    const errs = (diag.exceptions || []).concat((diag.consoleMsgs || []).filter(m => m.type === 'error' && /gallery/i.test(m.text)).map(m => m.text));
    check(errs.length === 0, 'no page exceptions: ' + JSON.stringify(errs.slice(0, 3)).slice(0, 600));
  } finally {
    try { if (cdp && cdp.close) cdp.close(); } catch {}
    try { if (chrome) chrome.kill(); } catch {}
    try { side.kill(); } catch {}
    try { mock.server.close(); } catch {}
  }
  console.log(problems.length ? '\n' + problems.length + ' problem(s)' : '\nGALLERY LIVE WALK: all checks passed');
  process.exit(problems.length ? 1 : 0);
}
main().catch(e => { console.error('gallery-shots failed:', e && e.stack || e); process.exit(1); });
