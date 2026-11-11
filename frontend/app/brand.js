/* brand.js — THE ONE PLACE this fork's identity lives (Art Studio overhaul, Phase 0: fork hygiene).

   This build is a fork of StarNet (androoAGI/starnet, MIT). The StarNet name, logo and artwork are NOT
   licensed with the code (NOTICE.md), and a fork that kept upstream's app identifier would share upstream's
   data folder, keychain entries and updater feed. Everything that decides "which app is this?" reads from here:

     PRODUCT_NAME    the user-visible name. A PLACEHOLDER until the owner picks one (plan Phase 7) —
                     change it here (and the three pinned copies below) and every surface follows.
     APP_IDENTIFIER  the Tauri bundle identifier = the per-user app-data folder of the desktop app, the
                     WebView profile, the single-instance lock and the OS keychain service.
     DATA_DIR_NAME   the app-data folder a bare `npm start` station and the voice-model cache use.
     DATA_HOMES      every app-data folder name this fork owns (recovery/migration candidates). It never
                     lists upstream's folders: this fork must not adopt, migrate or erase StarNet's data.
     UPDATES         in-app updates are OFF in this fork (no release feed of its own yet). The Update
                     Center says so; it never checks upstream's feed.
     UPSTREAM        attribution only. Nothing reads these to find data or updates.

   Three files cannot require() this one and carry pinned copies instead; test/brand-identity.test.js fails
   when any of them drifts: src-tauri/tauri.conf.json (productName, identifier),
   src-tauri/src/brand.rs (the Rust constants) and frontend/index.html (<title>).

   Loaded by the page (first app script, before any consumer) AND required by the sidecar and the CLI. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Brand = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PRODUCT_NAME = 'ART STATION';
  const APP_IDENTIFIER = 'com.sunneyred.artstation';
  const DATA_DIR_NAME = 'ArtStation';

  return Object.freeze({
    PRODUCT_NAME,
    APP_IDENTIFIER,
    DATA_DIR_NAME,
    // lower-case folder name for XDG-style cache roots (~/.cache/<name>)
    CACHE_DIR_NAME: DATA_DIR_NAME.toLowerCase(),
    DATA_HOMES: Object.freeze([DATA_DIR_NAME, APP_IDENTIFIER]),
    UPDATES: Object.freeze({
      enabled: false,
      releasesPage: '',
      offNote: 'In-app updates are off in this build. It never checks or installs releases from anywhere.'
    }),
    UPSTREAM: Object.freeze({
      name: 'StarNet',
      repo: 'https://github.com/androoAGI/starnet',
      identifier: 'ai.skynet.harness',
      dataDirNames: Object.freeze(['StarNet', 'Skynet'])
    })
  });
});
