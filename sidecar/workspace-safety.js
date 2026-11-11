/* sidecar/workspace-safety.js — identify canonical user-data roots that DEV/QA must never mutate.

   FORK IDENTITY (Art Studio Phase 0): two different questions used to share one list.
     workspaceCandidates  -> the roots THIS app owns (frontend/app/brand.js DATA_HOMES). Recovery and the CLI
                             look here, so the fork can never adopt or migrate an upstream StarNet station.
     classifyWorkspace    -> the roots DEV/QA must never mutate: this app's own AND upstream StarNet's, because
                             a dev seed or test run pointed at someone's real StarNet install is just as wrong. */
'use strict';
const Brand = require('../frontend/app/brand.js');

function normalize(value, path, platform) {
  let out = path.resolve(String(value || ''));
  const root = path.parse(out).root;
  while (out.length > root.length && /[\\\/]$/.test(out)) out = out.slice(0, -1);
  return platform === 'win32' ? out.toLowerCase() : out;
}

function workspaceCandidates(deps, apps) {
  const d = deps || {};
  const path = d.path;
  const env = d.env || {};
  const platform = String(d.platform || '');
  const homedir = typeof d.homedir === 'function' ? d.homedir : function () { return ''; };
  if (!path || typeof path.join !== 'function') throw new Error('workspace-safety: an injected path is required');
  const bases = [env.LOCALAPPDATA, env.APPDATA, env.XDG_DATA_HOME];
  const home = String(homedir() || '');
  // Tauri's stable macOS app-data root is ~/Library/Application Support/<bundle-id>. Manual sidecar boots
  // used the generic POSIX ~/.local/share fallback instead. Inspect/protect BOTH so the desktop can recover
  // the stranded root and the two launch modes can never silently become separate stations again.
  if (home && platform === 'darwin') bases.push(path.join(home, 'Library', 'Application Support'));
  if (home) bases.push(path.join(home, '.local', 'share'));
  const out = [];
  for (const base of bases.filter(Boolean)) {
    for (const app of (Array.isArray(apps) ? apps : Brand.DATA_HOMES)) {
      const candidate = path.join(String(base), app, 'workspaces');
      if (!out.some(existing => normalize(existing, path, platform) === normalize(candidate, path, platform))) out.push(candidate);
    }
  }
  return out;
}

function classifyWorkspace(root, deps) {
  const d = deps || {};
  const path = d.path;
  const env = d.env || {};
  const platform = String(d.platform || '');
  const homedir = typeof d.homedir === 'function' ? d.homedir : function () { return ''; };
  if (!path || typeof path.resolve !== 'function' || typeof path.join !== 'function') {
    throw new Error('workspace-safety: an injected path is required');
  }
  const candidates = workspaceCandidates({ path: path, env: env, platform: platform, homedir: homedir },
    Brand.DATA_HOMES.concat(Brand.UPSTREAM.dataDirNames, [Brand.UPSTREAM.identifier]));
  const actual = normalize(root, path, platform);
  for (const candidate of candidates) {
    if (actual === normalize(candidate, path, platform)) {
      return { protected: true, root: path.resolve(String(root)), matched: path.resolve(candidate) };
    }
  }
  return { protected: false, root: path.resolve(String(root)), matched: '' };
}

module.exports = { classifyWorkspace: classifyWorkspace, workspaceCandidates: workspaceCandidates };
