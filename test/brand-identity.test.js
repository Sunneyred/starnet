/* node test/brand-identity.test.js — the fork's identity is ONE thing, and it is not upstream's.

   Art Studio overhaul, Phase 0 (fork hygiene). A build of this fork that kept StarNet's identity would:
     · share StarNet's app-data folder, WebView profile and OS keychain entries (one bundle identifier),
     · treat StarNet's folders as its own "legacy" data — migrating out of them and DELETING them on ERASE EVERYTHING,
     · install whatever upstream publishes to its release feed over the owner's work (the in-app updater).
   This gate fails when any of that comes back, and when the pinned copies of the identity drift apart:
   frontend/app/brand.js (the source) · src-tauri/tauri.conf.json · src-tauri/src/brand.rs · frontend/index.html. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const Brand = require('../frontend/app/brand.js');
const UP = Brand.UPSTREAM;

// ---- 1. the source itself --------------------------------------------------------------------
A.ok(Brand.PRODUCT_NAME && !/starnet|skynet/i.test(Brand.PRODUCT_NAME), 'the product name is the fork\'s own, not upstream\'s');
A.ok(/^[a-z0-9]+(\.[a-z0-9]+){2,}$/.test(Brand.APP_IDENTIFIER), 'the bundle identifier is a reverse-domain id');
A.ok(Brand.APP_IDENTIFIER !== UP.identifier && Brand.APP_IDENTIFIER.indexOf('skynet') < 0, 'the bundle identifier is not upstream\'s');
A.eq(Brand.CACHE_DIR_NAME, Brand.DATA_DIR_NAME.toLowerCase(), 'the cache folder is the data folder name, lower-cased');
A.eq(Brand.DATA_HOMES.slice().sort(), [Brand.DATA_DIR_NAME, Brand.APP_IDENTIFIER].sort(), 'the app owns exactly its own two data homes');
for (const theirs of UP.dataDirNames.concat([UP.identifier])) {
  A.ok(!Brand.DATA_HOMES.some(h => h.toLowerCase() === theirs.toLowerCase()), 'an upstream folder is never one of this app\'s data homes: ' + theirs);
}
A.eq(Brand.UPDATES.enabled, false, 'in-app updates are off until the fork has its own release feed');
A.eq(Brand.UPDATES.releasesPage, '', 'no releases page is offered while updates are off');
A.ok(Object.isFrozen(Brand) && Object.isFrozen(Brand.UPDATES) && Object.isFrozen(Brand.DATA_HOMES), 'the identity is frozen');

// ---- 2. the pinned copies agree --------------------------------------------------------------
const conf = JSON.parse(read('src-tauri/tauri.conf.json').replace(/^\uFEFF/, ''));
A.eq(conf.productName, Brand.PRODUCT_NAME, 'tauri.conf.json productName = brand.js PRODUCT_NAME');
A.eq(conf.identifier, Brand.APP_IDENTIFIER, 'tauri.conf.json identifier = brand.js APP_IDENTIFIER');
A.ok(!/andrew sims/i.test(String(conf.bundle && conf.bundle.publisher)), 'the installer does not name upstream\'s author as its publisher');

const rs = read('src-tauri/src/brand.rs');
const rsConst = name => { const m = new RegExp('const ' + name + ': &str = "([^"]*)";').exec(rs); return m ? m[1] : null; };
A.eq(rsConst('PRODUCT_NAME'), Brand.PRODUCT_NAME, 'brand.rs PRODUCT_NAME = brand.js');
A.eq(rsConst('APP_IDENTIFIER'), Brand.APP_IDENTIFIER, 'brand.rs APP_IDENTIFIER = brand.js');
A.eq(rsConst('DATA_DIR_NAME'), Brand.DATA_DIR_NAME, 'brand.rs DATA_DIR_NAME = brand.js');
A.eq(rsConst('CACHE_DIR_NAME'), Brand.CACHE_DIR_NAME, 'brand.rs CACHE_DIR_NAME = brand.js');
const owned = /OWNED_DIR_NAMES_LOWER: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(rs);
A.ok(!!owned, 'brand.rs declares the owned folder names');
const ownedNames = owned ? owned[2].split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean) : [];
A.eq(ownedNames.slice().sort(), Brand.DATA_HOMES.map(h => h.toLowerCase()).sort(), 'brand.rs owned folders = brand.js DATA_HOMES, lower-cased');
A.eq(owned ? Number(owned[1]) : -1, ownedNames.length, 'the owned-folders array length matches its entries');

const html = read('frontend/index.html');
A.eq((/<title>([^<]*)<\/title>/.exec(html) || [])[1], Brand.PRODUCT_NAME, 'index.html <title> = brand.js PRODUCT_NAME');
A.ok(html.indexOf('<script src="app/brand.js">') > 0, 'the page loads brand.js');
A.ok(html.indexOf('<script src="app/brand.js">') < html.indexOf('<script src="app/updates.js">'), 'brand.js loads before the Update Center reads it');
A.ok(html.indexOf('<script src="app/brandmark.js">') > 0, 'the page loads brandmark.js (fills [data-brand-name] from brand.js)');
const marks = html.replace(/<!--[\s\S]*?-->/g, '').match(/data-brand-name[^>]*>([^<]*)</g) || [];
A.ok(marks.length >= 5, 'the app\'s own marks are tagged [data-brand-name] (found ' + marks.length + ')');
for (const m of marks) A.eq(m.replace(/^[^>]*>/, '').replace(/<$/, ''), Brand.PRODUCT_NAME, 'a [data-brand-name] mark carries the placeholder name as its first-paint text');

// ---- 3. the app's own marks are text, not upstream's logo art --------------------------------
const visible = html.replace(/<!--[\s\S]*?-->/g, '');
A.ok(!/assets\/brand\/starnet-logo/.test(visible), 'the splash no longer shows upstream\'s logo image');
A.ok(/<div id="logo"><span class="logo-img brand-text"/.test(visible), 'the topbar mark is a text mark');
A.ok(/\.logo-img\.brand-text\s*\{[^}]*mask:\s*none/.test(read('frontend/css/app.css')), 'the text mark switches the upstream wordmark mask off');

// ---- 4. the desktop shell reads the identity, never upstream's literals -----------------------
const stripRs = src => src.replace(/\/\/[^\n]*/g, '');
const cred = stripRs(read('src-tauri/src/credentials.rs'));
A.ok(/KEYCHAIN_SERVICE: &str = crate::brand::APP_IDENTIFIER;/.test(cred), 'the OS keychain service is the fork\'s identifier');
const erase = read('src-tauri/src/erase_all.rs');
const eraseCode = stripRs(erase.slice(0, erase.indexOf('#[cfg(test)]')));
A.ok(/OWNED_NAMES: \[&str; \d+\] = crate::brand::OWNED_DIR_NAMES_LOWER;/.test(eraseCode), 'ERASE EVERYTHING owns only the fork\'s folders');
A.ok(!/"ai\.skynet\.harness"|"starnet"|"skynet"/i.test(eraseCode), 'ERASE EVERYTHING names no upstream folder as its own');
const main = read('src-tauri/src/main.rs');
A.ok(/^mod brand;$/m.test(main), 'the desktop shell compiles brand.rs');
const fnBody = (src, sig) => { const i = src.indexOf(sig); if (i < 0) return ''; const j = src.indexOf('\n}\n', i); return src.slice(i, j < 0 ? i + 4000 : j); };
for (const sig of ['fn workspace_path(', 'fn legacy_workspace_paths(', 'fn local_voice_model_cache(']) {
  const body = stripRs(fnBody(main, sig));
  A.ok(body.length > 0, 'found ' + sig);
  A.ok(/brand::/.test(body), sig + ' resolves its folders through brand.rs');
  A.ok(!/"ai\.skynet\.harness"|"StarNet"|"Skynet"|"starnet"/.test(body), sig + ' names no upstream folder');
}

// ---- 5. the sidecar and CLI resolve their folders through brand.js ---------------------------
const stripJs = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
for (const rel of ['sidecar/workspace-safety.js', 'sidecar/local-voice.js', 'sidecar/providers/codex-token-store.js',
  'sidecar/cli-link.js', 'bin/starnet.js', 'bin/lib/theme.js', 'bin/lib/brand.js']) {
  const code = stripJs(read(rel));
  A.ok(/brand\.js/.test(code), rel + ' requires brand.js');
  A.ok(!/['"]ai\.skynet\.harness['"]/.test(code), rel + ' does not hard-code upstream\'s bundle identifier');
  A.ok(!/['"](StarNet|Skynet)['"]\s*,\s*['"](workspaces|models)['"]/.test(code), rel + ' does not build a path under an upstream data folder');
}

// sidecar/index.js is read through the shared source helper (test/source-helper.test.js H5), one function at a time
const { sidecarFunctionSource } = require('./helpers/source.js');
const defaultWs = stripJs(sidecarFunctionSource('defaultWorkspaces'));
A.ok(/Brand\.APP_IDENTIFIER/.test(defaultWs) && /Brand\.DATA_DIR_NAME/.test(defaultWs), 'the sidecar\'s default data root is built from brand.js');
A.ok(!/['"](ai\.skynet\.harness|StarNet|Skynet)['"]/.test(defaultWs), 'the sidecar\'s default data root names no upstream folder');

// ---- 5b. upstream's paid credits service is not offered (owner decision, 2026-11-11) ----------
const { readSidecarIndex } = require('./helpers/source.js');
const idx = readSidecarIndex();
A.ok(/^const CLOUD_LIVE = false;/m.test(idx), 'the StarNet Cloud switch is off: no account link, no credits, no START WITH hero');
A.ok(/CLOUD_LIVE \? CLOUD_URL_DEFAULT : ''/.test(idx), 'with the switch off the default cloud URL is empty');
A.ok(!/id="model-dock-subscription"/.test(visible) && !/starnetos\.com\/pricing/.test(visible), 'the page carries no link to upstream\'s subscription');
A.ok(!/Start with StarNet/.test(visible), 'the connect screen does not invite a StarNet start');
A.ok(/class="prov prov-hero hidden" data-prov="starnet"/.test(visible), 'the StarNet provider card stays hidden markup (revealed only by a linkable cloud, which is off)');

// ---- 6. behaviour: whose data is whose -------------------------------------------------------
const { classifyWorkspace, workspaceCandidates } = require('../sidecar/workspace-safety.js');
const winDeps = { path: path.win32, platform: 'win32', homedir: () => 'C:\\Users\\Ada',
  env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local', APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' } };
const cands = workspaceCandidates(winDeps);
A.ok(cands.length > 0 && cands.every(c => Brand.DATA_HOMES.some(h => c.indexOf('\\' + h + '\\workspaces') > 0)), 'every recovery candidate is one of this app\'s own homes');
A.ok(!cands.some(c => /\\(StarNet|Skynet|ai\.skynet\.harness)\\/i.test(c)), 'an upstream StarNet station is never a recovery candidate');
A.eq(classifyWorkspace('C:\\Users\\Ada\\AppData\\Roaming\\' + Brand.APP_IDENTIFIER + '\\workspaces', winDeps).protected, true, 'DEV/QA may not mutate this app\'s real station');
A.eq(classifyWorkspace('C:\\Users\\Ada\\AppData\\Roaming\\' + UP.identifier + '\\workspaces', winDeps).protected, true, 'DEV/QA may not mutate a real upstream StarNet station either');

const tokenStore = require('../sidecar/providers/codex-token-store.js');
if (typeof tokenStore.knownWorkspaceRoots === 'function') {
  const roots = tokenStore.knownWorkspaceRoots({ pathMod: path.win32, env: winDeps.env });
  A.ok(roots.length > 0 && !roots.some(r => /\\(StarNet|Skynet|ai\.skynet\.harness)\\/i.test(r)), 'a sign-in token is never migrated out of an upstream StarNet folder');
}

const binBrand = require('../bin/lib/brand.js');
for (const k of ['PRODUCT_NAME', 'APP_IDENTIFIER', 'DATA_DIR_NAME']) {
  A.eq(binBrand.PINNED[k], Brand[k], 'bin/lib/brand.js pinned ' + k + ' = brand.js (the CLI must work when bin/ runs alone)');
  A.eq(binBrand[k], Brand[k], 'the CLI reads ' + k + ' from brand.js');
}
const theme = require('../bin/lib/theme.js');
if (typeof theme.configFile === 'function') {
  A.ok(theme.configFile({ APPDATA: 'C:\\A' }, 'win32').indexOf(Brand.APP_IDENTIFIER) > 0, 'the CLI keeps its settings beside this app\'s data');
}

// ---- 7. updates: off, said plainly, and never upstream's feed --------------------------------
const updater = conf.plugins && conf.plugins.updater;
A.ok(updater && Array.isArray(updater.endpoints), 'the updater block is present (the plugin reads it at start)');
A.eq(updater.endpoints, [], 'the desktop updater has NO endpoint: nothing can be fetched or installed');
A.eq(conf.bundle.createUpdaterArtifacts, false, 'a build produces no updater artifacts');
A.ok(!/starnet-releases/.test(JSON.stringify(conf)), 'tauri.conf.json never names upstream\'s release feed');
const updSrc = read('frontend/app/updates.js');
A.ok(!/androoAGI|starnet-releases/.test(stripJs(updSrc)), 'the Update Center never links upstream\'s releases');

function loadUpdates(tauri) {
  const invoked = [];
  const g = {
    Brand, UpdateCore: require('../frontend/app/updatecore.js'),
    localStorage: { getItem() { return null; }, setItem() {} },
    window: tauri ? { __TAURI__: { core: { invoke(cmd) { invoked.push(cmd); return cmd === 'starnet_update_status'
      ? Promise.resolve({ desktop: true, currentVersion: '9.9.9', target: 'test', pending: { version: '99.0.0' } })
      : Promise.reject(new Error('must not be invoked: ' + cmd)); } } } } : undefined,
    setTimeout, clearTimeout, Date, Promise, JSON, Object, String, Math, console
  };
  const fn = new Function('Brand', 'UpdateCore', 'localStorage', 'window', 'setTimeout', 'clearTimeout', updSrc + '\nreturn Updates;');
  return { Updates: fn(g.Brand, g.UpdateCore, g.localStorage, g.window, g.setTimeout, g.clearTimeout), invoked };
}

(async () => {
  for (const tauri of [false, true]) {
    const where = tauri ? 'desktop' : 'browser';
    const { Updates, invoked } = loadUpdates(tauri);
    const said = [];
    await Updates.init({ notify: m => said.push(String(m)), rerender() {} });
    A.eq(Updates.off(), true, where + ': the Update Center knows updates are off');
    A.eq(Updates.phase(), 'off', where + ': the phase after start is "off", even with a pending update reported');
    const snap = await Updates.check(true, 'manual');
    A.eq(snap.phase, 'off', where + ': a manual check stays "off"');
    A.eq(snap.update, null, where + ': no update is ever offered');
    A.ok(said.some(m => /off in this build/i.test(m)), where + ': a manual check SAYS updates are off');
    await Updates.install();
    A.ok(!invoked.some(c => c === 'starnet_update_check' || c === 'starnet_update_install'), where + ': the native check/install is never invoked (' + invoked.join(',') + ')');
    const body = { innerHTML: '', querySelector() { return null; } };
    Updates.render(body);
    A.ok(/UPDATES ARE OFF IN THIS BUILD/.test(body.innerHTML), where + ': the Update Center window says updates are off');
    A.ok(!/CHECK NOW|INSTALL UPDATE|download manually/i.test(body.innerHTML), where + ': it offers no check, install or download control');
    A.ok(/off in this build/i.test(Updates.settingsHtml()) && !/AUTO-CHECK/.test(Updates.settingsHtml()), where + ': Settings shows the same truth and no auto-check toggle');
    Updates.openReleasesPage();   // must not throw and must not open anything
  }
  A.report('brand-identity.test');
})();
