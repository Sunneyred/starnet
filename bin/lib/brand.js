/* bin/lib/brand.js — the fork's identity for the `starnet` terminal command (Art Studio Phase 0).

   The one source is frontend/app/brand.js. In an installed app it ships beside bin/ (Resources/frontend), so it is
   read from there. bin/ must also run ALONE — a copied bin folder, a partial install — so a pinned copy of the three
   values the CLI needs is the fallback; test/brand-identity.test.js fails when the two drift. */
'use strict';

const PINNED = Object.freeze({
  PRODUCT_NAME: 'ART STATION',
  APP_IDENTIFIER: 'com.sunneyred.artstation',
  DATA_DIR_NAME: 'ArtStation'
});

let brand = PINNED;
try {
  const full = require('../../frontend/app/brand.js');
  if (full && full.APP_IDENTIFIER && full.PRODUCT_NAME && full.DATA_DIR_NAME) brand = full;
} catch (_) { /* bin/ on its own: the pinned copy is the identity */ }

module.exports = { PRODUCT_NAME: brand.PRODUCT_NAME, APP_IDENTIFIER: brand.APP_IDENTIFIER, DATA_DIR_NAME: brand.DATA_DIR_NAME, PINNED };
