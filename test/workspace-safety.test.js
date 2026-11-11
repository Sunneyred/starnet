/* node test/workspace-safety.test.js — DEV/QA roots can never alias canonical StarNet user data. */
'use strict';
const { readSidecarSource } = require('./helpers/source');
const A = require('./_assert.js');
const win = require('node:path').win32;
const posix = require('node:path').posix;
const { classifyWorkspace, workspaceCandidates } = require('../sidecar/workspace-safety.js');
const Brand = require('../frontend/app/brand.js');

const winDeps = {
  path: win,
  platform: 'win32',
  env: { LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local', APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
  homedir: () => 'C:\\Users\\Ada'
};
// FORK IDENTITY (Art Studio Phase 0): the app's own homes come from frontend/app/brand.js. Upstream StarNet's roots
// stay PROTECTED (DEV/QA must never mutate someone's real StarNet station) but are never RECOVERY candidates.
A.eq(classifyWorkspace('c:\\users\\ada\\appdata\\local\\' + Brand.DATA_DIR_NAME.toUpperCase() + '\\workspaces\\', winDeps).protected, true,
  'current Windows root is protected case-insensitively');
A.eq(classifyWorkspace('C:\\Users\\Ada\\AppData\\Roaming\\' + Brand.APP_IDENTIFIER + '\\workspaces', winDeps).protected, true,
  'Tauri production identifier root is protected');
A.eq(classifyWorkspace('C:\\Users\\Ada\\AppData\\Roaming\\' + Brand.APP_IDENTIFIER + '.canary\\workspaces', winDeps).protected, false,
  'isolated canary identifier is not confused with production');
A.eq(classifyWorkspace('c:\\users\\ada\\appdata\\local\\STARNET\\workspaces\\', winDeps).protected, true,
  'an upstream StarNet root is still protected from DEV/QA');
A.eq(classifyWorkspace('C:\\Users\\Ada\\AppData\\Roaming\\Skynet\\workspaces', winDeps).protected, true,
  'an upstream legacy root is still protected from DEV/QA');
A.eq(classifyWorkspace('C:\\Users\\Ada\\AppData\\Roaming\\ai.skynet.harness\\workspaces', winDeps).protected, true,
  'an upstream desktop root is still protected from DEV/QA');
A.eq(classifyWorkspace('D:\\scratch\\starnet-eval-123', winDeps).protected, false,
  'an unrelated scratch root is allowed');

const posixDeps = { path: posix, platform: 'linux', env: {}, homedir: () => '/home/ada' };
A.eq(classifyWorkspace('/home/ada/.local/share/' + Brand.DATA_DIR_NAME + '/workspaces', posixDeps).protected, true,
  'POSIX fallback production root is protected');
A.eq(classifyWorkspace('/tmp/starnet-test', posixDeps).protected, false, 'POSIX scratch root is allowed');

const macDeps = { path: posix, platform: 'darwin', env: {}, homedir: () => '/Users/ada' };
const macCandidates = workspaceCandidates(macDeps);
A.ok(macCandidates.includes('/Users/ada/Library/Application Support/' + Brand.APP_IDENTIFIER + '/workspaces'),
  'macOS desktop bundle-id root is a canonical recovery candidate');
A.ok(macCandidates.includes('/Users/ada/.local/share/' + Brand.DATA_DIR_NAME + '/workspaces'),
  'manual-sidecar POSIX root remains a recovery candidate on macOS');
A.ok(!macCandidates.some(c => /\/(StarNet|Skynet|ai\.skynet\.harness)\//.test(c)),
  'an upstream StarNet station is never offered for recovery');
A.eq(classifyWorkspace('/Users/ada/Library/Application Support/' + Brand.APP_IDENTIFIER + '/workspaces', macDeps).protected, true,
  'macOS desktop production root is protected');

const duplicateBases = workspaceCandidates({
  path: win, platform: 'win32', env: { LOCALAPPDATA: 'C:\\same', APPDATA: 'C:\\same' }, homedir: () => ''
});
A.eq(new Set(duplicateBases.map(row => row.toLowerCase())).size, duplicateBases.length,
  'duplicate environment bases never duplicate recovery evidence');

const index = readSidecarSource();
A.ok(/process\.platform === 'darwin'[\s\S]{0,500}?Library'[\s\S]{0,200}?'Application Support'[\s\S]{0,200}?Brand\.APP_IDENTIFIER/.test(index),
  'manual sidecar defaults to the same macOS bundle-id workspace as the desktop shell');

A.report('workspace-safety.test');
