//! This fork's identity, in one place (Art Studio overhaul, Phase 0: fork hygiene).
//!
//! PINNED COPIES of the constants in `frontend/app/brand.js` — Rust cannot `require()` that file.
//! `test/brand-identity.test.js` fails when these, `tauri.conf.json` and brand.js disagree.
//!
//! Why they exist: with upstream's identifier this app would share StarNet's keychain service, treat
//! StarNet's data folders as its own "legacy" roots (migrating from them, and deleting them on ERASE
//! EVERYTHING) and share its voice-model cache. Every such decision reads these constants instead.

/// The user-visible product name. A placeholder until the owner picks one (plan Phase 7).
pub(crate) const PRODUCT_NAME: &str = "ART STATION";
/// The Tauri bundle identifier: app-data folder name, WebView profile and OS keychain service.
pub(crate) const APP_IDENTIFIER: &str = "com.sunneyred.artstation";
/// The app-data folder a bare `npm start` station and the voice-model cache use.
pub(crate) const DATA_DIR_NAME: &str = "ArtStation";
/// `DATA_DIR_NAME` lower-cased, for XDG-style cache roots (`~/.cache/<name>`).
pub(crate) const CACHE_DIR_NAME: &str = "artstation";
/// Every app-data folder name this fork owns, lower-cased (path ownership checks compare lower-case).
/// Upstream's `ai.skynet.harness`, `StarNet` and `Skynet` are deliberately absent.
pub(crate) const OWNED_DIR_NAMES_LOWER: [&str; 2] = ["com.sunneyred.artstation", "artstation"];
