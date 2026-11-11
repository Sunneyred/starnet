# ART STUDIO OVERHAUL — implementation plan for Fable 5.2

> **Owner:** Sunneyred (fork `Sunneyred/starnet`, forked from `androoAGI/starnet` at `74fcd504`, v0.14.1).
> **Written:** 2026-11-10, grounded against that commit. **Executor:** Claude Fable 5.2 (or any coding agent).
> **Status:** NOT STARTED. Update the STATUS line under each phase as work lands (commit hash + date).

---

## 0. Read this first

### 0.1 What the owner wants (in their words, condensed)

The owner is an artist who makes glitch-collage digital art: neon blue/magenta/yellow palettes, halftone and
scanline textures, classical statues and angels, bold type. They want **passive income from that art through AI
automation**, starting with this fork of StarNet, turned into **a more interactive, game-like experience with a
player character**.

The first version must do this, autonomously:

1. **Drop a design.** The owner drops finished artwork into a folder (or onto the app).
2. **The Strategist decides where it sells best.** An agent looks at the design and decides which products it suits
   (for example a shirt, a hat, a poster, a phone case, a sticker or single cover art), ranks them and explains why.
3. **The Studio adapts the design to each product.** It crops, scales, places and recolors the art so it works
   visually on each product: print area, safe zones, resolution, light versus dark fabric.
4. **The Mockup Lab makes mockups.** It produces product mockups of every adapted design.
5. Later, more automation (Phase 8, outline only): listings, posting to Instagram, Pinterest, TikTok and X/Threads,
   and a store that is still undecided.

The owner will send a video explaining the interactive vision in more detail. **Phases 0–5 do not depend on it.**
Phase 6 (the player character) should be re-checked against the video before it starts. See §6.

### 0.2 Hard rules for this repo (inherited — do not break)

- **Truthful telemetry is the core law.** The UI never claims something the harness cannot prove. A mockup that
  was not rendered is never shown as done. A post that was not published is never shown as posted. The player
  character never pretends to do agent work.
- **`shared/` is a FROZEN contract.** `shared/events.js` and `shared/schema.js` take additive changes only. Never
  rename or remove an event or field.
- **Object = capability.** A tool reaches an agent only through a placed prop. That means: `CAP_PROP_MAP` in
  `frontend/app/worldmodel.js`, then `CAP_REGISTRY` in `sidecar/capability/registry.js`, then `resolve.js`.
  `test/capdrift.test.js` guards the prop⇄capability seam. Every new tool must go through it.
- **Gate:** `npm run test:fast` must be green before any merge. Sidecar or route changes also owe
  `npm run test:http`. New behavior gets registered tests in `test/fast.list` or `test/http.list`.
- **Determinism law** for pure modules: inject the clock, rng, fs and path. Follow the pattern in
  `sidecar/routing/triggers.js`.
- **Persistence** uses the atomic `*-store.js` pattern: fsync, then rename. Copy an existing store such as
  `sidecar/deliverable-store.js`. Do not invent a new persistence style.
- **Doc-trust rule** (from `docs/BRAIN.md`): any doc claim is a hypothesis until you grep the source. That
  includes this plan. If something here does not match the code, the code wins. Note the mismatch in this file.
- Before your first edit, read `docs/BRAIN.md`, `CODE_MAP.md`, `docs/DECISIONS.md` and `docs/MISTAKES.md`.
- **Maintainer tooling is not in this fork.** `docs/BRAIN.md` refers to an untracked `CLAUDE.md` and
  `.claude/skills/starnet-*` doctrine skills. They are not in the repo, so don't look for them. This plan plus the
  docs above replace them.
- **Branching:** one branch per phase, named `art-studio/phase-N-<slug>`. Open a PR into the fork's `main`. Never
  push to `androoAGI/starnet`.

### 0.3 Licensing rule that shapes the work

The code is MIT-licensed. **The StarNet name, logo, artwork and sprites are owned by Andrew Sims and are not
covered by the MIT license** (README and `NOTICE.md`). Forks must use their own name and art. Phase 0 removes the
name from anything user-visible in the owner's builds. Phase 7 replaces the art. **Nothing gets distributed
publicly (installers, releases, a public website) until Phase 7 is done.** Internal `skynet.*` keys and
identifiers may stay, as upstream also keeps them.

---

## 1. How the vision maps onto what already exists

Most of the plumbing exists. This overhaul is mainly new tools, new data, a new line blueprint and a new player
layer. It is not a rewrite.

| Owner's idea | Existing system to build on | Where |
| --- | --- | --- |
| "Drop designs" | **FOLDER line trigger.** It polls one folder, waits for writes to settle, dedupes and starts one work line per new file. Binary files arrive as a path plus size. | `sidecar/routing/trigger-folder.js`, `triggers.js`, `trigger-runner.js` |
| Agents in rooms doing stages | **Work lines on the conveyor floor:** INBOX ▸ BAY ▸ … ▸ OUTBOX. Each bay is an agent with a role. Images are handed between stages (`test/conveyor-image-handoff.test.js`). | `frontend/app/pipeline.js`, `sidecar/routing/*`, `chain.js` |
| Ready-made pipeline | **Line BLUEPRINTS:** 20 starters such as `front_desk`, `revision_loop` and `assembly_line`, with plain-language text in `LINE_PLAIN` and `LINE_WORK`. | `frontend/app/worldmodel.js` (around lines 491 and 959) |
| Quality check / redo | **LOOP and REVIEWER machinery:** review loops and unapproved-loop handling. | `revision_loop` blueprint, `sidecar/routing/line-fire.js` |
| Looking at the art | **`image_analyze`.** Vision falls back to the run's own provider, so no extra key is needed. | `sidecar/tools/builtin/image.js` |
| Generating images | **`image_generate`.** Supports OpenRouter, OpenAI Images and ChatGPT-plan routes, plus real-alpha transparency. | same file |
| Finished work | **Deliverables and the OUTBOX.** | `sidecar/deliverable-store.js`, `tools/builtin/deliverable.js` |
| Working while away | **Night Shift, cron routines and line triggers,** with spend rails ($25/day soft rail and per-line budgets on the INBOX). | `sidecar/nightshift*.js`, `cron*.js`, `budgetcaps.js` |
| Approve before risky actions | **Consent broker and permission grants.** | `sidecar/permissions.js`, `permgrants.js`, `consentwait.js` |
| Interactive world | **Canvas station.** The hero agent walks with A* pathing (`startBodyPath`, `setPathTo`), and the crew sit at bays. **The user has no controllable avatar today.** The hero is an agent and walks on its own. | `frontend/app/world.js` |
| Later: socials and stores | **MCP connector manager** (curated catalog, OAuth 2.1) and messaging channels. | `sidecar/mcp/`, `sidecar/channels/` |

### What is missing (the actual build)

1. **Deterministic image operations:** trim, scale, place, recolor and composite. Nothing like this exists today,
   and generative tools are the wrong fit for exact print files.
2. **A product catalog:** print areas, aspect ratios, minimum pixels, safe zones and fabric colors per product.
3. **A design record:** one durable record per dropped design that tracks original → analysis → product plan →
   variants → mockups → approval.
4. **Structured agent outputs:** the Strategist returns a validated product plan, not free text.
5. **A mockup renderer and template packs.**
6. **The ART LINE blueprint, plus a Gallery window** to review and approve results.
7. **A player character:** a controllable avatar and interactable rooms.
8. **Rebrand.**

---

## 2. Target architecture

```
 drop folder ──► FOLDER trigger ──► INBOX "ART DROP"
                                       │  (copies file into the project + creates a DesignRecord)
                                       ▼
                            BAY: STRATEGIST  ── image_analyze, product.catalog, product_plan.submit
                                       │  DesignRecord.plan = ranked products (validated)
                                       ▼
                            BAY: DESIGNER    ── art.inspect, art.prepare (one variant per product)
                                       │
                            BAY: REVIEWER + LOOP ── image_analyze over each variant vs. product spec
                                       │  (loop sends back to DESIGNER with notes, max N rounds)
                                       ▼
                            BAY: MOCKUP LAB  ── mockup.render (template packs)
                                       ▼
                                    OUTBOX ──► Gallery window (approve / reject / redo per product)
                                               └─► (Phase 8) PUBLISH line via SEND TO, approval-gated
```

New sidecar module tree (suggested; keep the files small):

```
sidecar/art/
  art-ops.js            pure-ish image operations over an injected canvas implementation
  products.js           catalog loader + validator (data in products.default.json)
  products.default.json starter catalog (values must be verified — see Phase 1)
  design-store.js       atomic DesignRecord store (copy deliverable-store.js shape)
  plan-schema.js        product_plan validation (pure)
  mockup.js             template-pack loader + compositor
  templates/            bundled starter template packs (owner-licensed images only)
sidecar/tools/builtin/art.js   tool definitions: art.inspect, art.prepare, product.catalog,
                               product_plan.submit, mockup.render
frontend/app/gallery.js        the Gallery window
frontend/app/avatar.js         the player character (Phase 6)
```

---

## 3. Phases

Each phase is shippable on its own. Do them in order. **Phase 0 is mandatory first.**

### Phase 0 — Fork hygiene (do not skip)

**STATUS:** source work done on branch `art-studio/phase-0-fork-hygiene` (commit `0560d37c`), 2026-11-11.
**Not yet proven on a real install** — see "Still owed" below. Do not tick the side-by-side acceptance box until
the owner has built and installed it on their machine.

#### Phase 0 record

**Baseline (untouched `74fcd504`, recorded before any feature code).** Environment: Linux x64 cloud sandbox,
Node 22.23.4, 2 cores. `npm ci` fails here because `node-pty` has no Linux prebuild and node-gyp cannot download
headers; `npm ci --ignore-scripts` installs. `npm run test:fast`: **1468 of 1483 steps pass, 15 fail.** The 15
are environmental, not regressions, and are the comparison set for every later phase:

| Cause in this sandbox | Steps |
| --- | --- |
| No Chrome/Chromium binary | `crt-context-loss.e2e`, `world-sharpen`, `worldlight-receiver`, `stationbake.connections`, `stationbake.plate-parity`, `stationbake.offcanvas`, `session-reliability.e2e`, `prop-recovery-live.e2e`, `browser.attach`, `browser.desktop-login-journey` |
| No outside network (`example.com`) / no Chromium | `browser`, `browser-proxy` |
| Windows-style path in a doc fixture (`docs\station-remaster\…`) | `projection-correction-assets` |
| Timing budget on a slow 2-core box | `world-say-head` |
| Upstream's own planning ledger reports BLOCKED | `qa-product-perfect-claims` |

`npm run test:http` and a packaged desktop build were not run in this sandbox (no WebKit, no Windows/macOS).

**What changed.**
- One identity source: `frontend/app/brand.js` (`PRODUCT_NAME` = `ART STATION`, `APP_IDENTIFIER` =
  `com.sunneyred.artstation`, `DATA_DIR_NAME` = `ArtStation`, updates off). Pinned copies in
  `src-tauri/tauri.conf.json`, `src-tauri/src/brand.rs`, `bin/lib/brand.js` and the `<title>` in
  `frontend/index.html`; `test/brand-identity.test.js` fails when any of them drifts. Renaming the app in Phase 7
  means changing those values.
- Data separation. The identifier decides the desktop data folder, the WebView profile and the single-instance
  lock. On top of that, every hard-coded upstream folder was replaced: the OS keychain service
  (`credentials.rs`), ERASE EVERYTHING's ownership list (`erase_all.rs`), the legacy-migration list and the
  voice-model cache (`main.rs`), the bare `npm start` data root (`sidecar/index.js`), recovery candidates
  (`workspace-safety.js`), sign-in token migration (`codex-token-store.js`), the voice-model cache
  (`local-voice.js`) and the CLI (`bin/starnet.js`, `bin/lib/theme.js`, `sidecar/cli-link.js`).
- Updater: `plugins.updater.endpoints` is empty and `createUpdaterArtifacts` is false. The Update Center shows
  "UPDATES ARE OFF IN THIS BUILD", never calls the native check or install, and offers no download link.
- Visible name: window title, tray tooltip, boot and splash screens, the setup title bar, the topbar mark and the
  save/recovery gates now say `ART STATION` as text. Upstream's logo image and wordmark are no longer used for
  the app's own marks.
- `upstream` git remote added (fetch only; its push URL is disabled).

**Where the plan and the code disagreed (code won).**
- *"The identifier is in one place."* It is not. Besides `tauri.conf.json`, upstream's identifier and folder
  names were hard-coded in about a dozen Rust and JS sites. Left alone, a renamed build would still have shared
  StarNet's keychain entries, migrated StarNet's station (and live sign-in tokens) into itself on first launch,
  and deleted StarNet's data on ERASE EVERYTHING. All fixed and locked by the new test.
- *"PR into the fork's main."* The fork has no `main`. Its only branch, and its default, is
  `feat/harness-backend`. Phase PRs target that branch.
- *"Start the fork at `0.14.1-art.0`."* Not done. The five version pins already agree at `0.14.1`, the updater is
  off so the number gates nothing, and a pre-release version is a known risk for Windows installers that cannot
  be tested here. Revisit in Phase 7 with a real build.
- *"`npm run release:bump`."* Not used, for the same reason.
- *"Don't touch `website/`."* `website/app` is a generated mirror of `frontend/` and the fast gate
  (`test/website-app-sync.test.js`) fails unless it is regenerated, so `npm run sync:website` was run. Nothing in
  `website/` was hand-edited. The site itself is upstream's and is not ours to deploy.

**Merge policy for upstream fixes.** `git fetch upstream`, merge into a fresh branch (never straight into the
default branch), run `node test/brand-identity.test.js` first (a merge that reintroduces an upstream folder name,
the updater endpoint or the logo fails there), then the fast gate against the baseline above, then merge.

**Tests changed.** New: `test/brand-identity.test.js` (108 assertions, registered in `test/fast.list`). Updated
to the fork's identity: `workspace-safety`, `provider.codex-auth`, `upgrade-085-090`, `tauri.hardening`,
`update-state-parity`, `brand-wordmark-mask`, `cli-link`, `cli-theme`, `cli-desktop-closed`,
`cli-owner-identity`, `cli-bootstrap-lineage`, `desktop-workspace-migration`, `failopen-ratchet` (one fewer
fail-open in `index.js`). `release-cut` now asserts that upstream's release script refuses to run here.
`updates-install` and `update-center-truth` keep testing the retained update machinery through a fixture
identity with updates on. `t5-public-distribution` prints a named SKIP while no updater endpoint exists.

**Gate result on the branch (same sandbox as the baseline).** `npm run test:fast`: 1469 of 1484 steps pass
(the new identity test is the extra step). The 15 failures are exactly the 15 baseline failures above; no new
failure. One upstream test is flaky and unrelated to this work: `website-pricing-hold` failed in one of two full
runs on the branch, and fails about one run in four (3 of 12) on the untouched baseline too. Treat a lone failure
there as noise and re-run it. Live check with `node dev/seed.js --keep`: the station boots and serves the page with the title
`ART STATION`, `brand.js` and seven `[data-brand-name]` marks, and no reference to upstream's logo image. There is
no browser in the sandbox, so nothing was checked by eye.

**Still owed (cannot be done from the cloud sandbox).**
1. **A real desktop build has not been compiled or installed.** The Rust edits are constant substitutions;
   `erase_all.rs` + `brand.rs` were compiled and their 5 unit tests pass in a standalone crate, but `main.rs` and
   `credentials.rs` were not compiled (the Tauri crate needs WebKit/Windows/macOS). First thing on the owner's
   machine: `npm ci`, `npm run desktop:build`, install it next to real StarNet, and confirm separate data.
2. Assumption to confirm in that build: the updater plugin starts cleanly with an empty endpoint list.
3. `npm run test:http` on the owner's machine.

**Known gaps, on purpose, for Phase 7.**
- The terminal command is still called `starnet`. On a machine with both apps installed, whichever is first on
  PATH answers. Each one only ever opens its own data. On macOS this app never takes over StarNet's link.
- The name "StarNet" still appears outside the surfaces listed above: settings text, notices, the terminal
  dashboard and its logo, and what agents call the app in their prompts. A case-insensitive count on 2026-11-11
  found about 3,500 "starnet" matches across `frontend/`, `sidecar/`, `bin/` and `src-tauri/`; that count includes
  code comments and internal keys and has not been sorted into visible versus internal.
- Upstream's sprites and station art are untouched.
- The "Start with StarNet" provider (upstream's paid credits service) and its account links are still offered,
  with upstream's wordmark as its provider logo. Whether this fork should offer another company's paid service
  is the owner's call (see §6).
- Upstream's release tooling (`scripts/release-*.mjs`, `update-canary.mjs`, `verify-update-host.mjs`) is
  unchanged and does not apply to this fork.

The fork currently builds an app that **auto-updates from upstream's releases**. It also shares upstream's app
identifier and data folder. If the owner installs their build next to real StarNet, or upstream ships an update,
the owner's work gets overwritten or the two apps' data mix. Fix that before anything else.

Tasks:

1. **Identity.** In `src-tauri/tauri.conf.json`, change `productName` (currently `StarNet`) to a placeholder.
   Use `ART STATION` until the owner picks a name, and keep it in one constant so Phase 7 changes a single place.
   Change `identifier` (currently `ai.skynet.harness`) to something like `com.sunneyred.artstation`. Check every
   place that derives the data folder from the identifier. `CODE_MAP.md` says the data lives at
   `%APPDATA%\Roaming\ai.skynet.harness\workspaces`, so grep `src-tauri/src` and `sidecar/` for the identifier and
   the data-root resolution.
2. **Updater.** Remove the `androoAGI/starnet-releases` endpoint from `plugins.updater` in `tauri.conf.json`, and
   disable the updater (or point it at a future `Sunneyred` releases repo with the owner's own key). Grep the
   frontend and sidecar for update-check UI and make it state truthfully that updates are off. Don't let it fail
   silently.
3. **Versions.** Keep the five version pins in agreement (`package.json`, the `package-lock.json` root,
   `tauri.conf.json`, `Cargo.toml`, the `skynet-desktop` entry in `Cargo.lock`). Use `npm run release:bump` if it
   works offline. Otherwise edit all five together. Start the fork at `0.14.1-art.0` or similar.
4. **Remotes.** Add `upstream` → `androoAGI/starnet` so later fixes can be pulled deliberately. Document the
   merge policy in this file: pull upstream into a branch, run the gates, then merge.
5. **Visible name.** Replace the user-visible "StarNet" strings in the window title, onboarding, topbar and About
   with the placeholder constant. Leave internal keys alone. Don't touch `website/`; it's upstream's site. Mark it
   "not ours" in a README note.
6. **Baseline.** On a clean checkout, run `npm ci`, `npm run test:fast` and `node dev/seed.js --keep`. Record
   which steps pass on the owner's platform before any feature code goes in. Upstream's own `docs/NEXT.md` records
   a fast-gate failure caused by disk exhaustion, so record the real baseline and don't assume green. Note failures
   that already existed as **pre-existing**, not as regressions.

Acceptance:
- A built app installs side by side with upstream StarNet, using separate data and no shared updater.
- `grep -ri "starnet" frontend/ --include=*.html` shows no user-visible product name outside comments and keys.
- Baseline gate results are recorded in this file.

### Phase 1 — Art engine and product catalog

**STATUS:** not started

**1a. Pick the image library (spike first, about one session).**
- Preferred: **`@napi-rs/canvas`**. It's already in the tree as a devDependency (`package.json`, `0.1.100`), has
  prebuilt binaries for win-x64, darwin-arm64 and darwin-x64, and offers a real 2D canvas API (drawImage,
  getImageData, composite operations, filters).
- The risk is packaging. The Tauri app embeds Node and the sidecar. Verify that a **native** module in
  `dependencies` actually gets bundled and loads in the installed app on Windows and macOS. Check how
  `node-pty`, already a native runtime dependency, is packaged, and follow the same path.
- Fallback: `jimp` (pure JS, slower, no native packaging risk).
- Decision rule: if `@napi-rs/canvas` loads in a packaged build on the owner's OS, use it. Otherwise use `jimp`.
  Hide the choice behind an injected adapter in `art-ops.js` so tests can use a fake, and so the library can be
  swapped later.

**1b. `sidecar/art/art-ops.js`.** Operations, all of them pure functions over buffers plus explicit options:
- `inspect(buf)` → `{ width, height, hasAlpha, dominantColors[], isDarkBackground, bbox (non-transparent / non-bg) }`
- `trim(buf, {bg:'auto'|color, tolerance})` → removes the solid border or background
- `removeBackground(buf, {method:'flatColor', tolerance})`: flat-color keying only, in v1. AI matting is out of
  scope. If a design has no flat background, say so; don't fake a cutout.
- `fit(buf, {width, height, mode:'contain'|'cover', anchor, padding})`
- `place(buf, product, placementId)` → a print-ready PNG at the product's exact pixel size, with the art inside
  the safe zone
- `recolorForFabric(buf, {fabric:'dark'|'light', strategy:'invert-lights'|'add-outline'|'none'})`: deterministic,
  conservative transforms. The Reviewer judges the result.
- `upscaleNeeded(buf, product)` → `{ ok, actualDpi, requiredDpi }`. **Never silently upscale.** If the art is too
  small, flag it in the record. An AI upscaler is a later option.

**1c. Product catalog: `sidecar/art/products.default.json` plus `products.js`.**
- Schema per product: `{ id, label, category, placements:[{ id, label, widthPx, heightPx, dpi, safeInsetPx,
  shape:'rect'|'circle'|'curved' }], aspectHint, fabricColors:[{id, hex, kind:'dark'|'light'}],
  minSourcePx, styleNotes, enabled }`.
- Starter products: t-shirt front, oversized tee back, hoodie, dad hat or snapback front, poster (several
  ratios), canvas print, phone case, sticker, tote bag, square single/album cover (3000×3000 is the common
  streaming spec; verify it).
- **Pixel sizes must come from a real print provider's published specs**, such as the Printful or Printify
  product catalog pages or APIs. Fill them in from those sources, cite the source URL in a `source` field per
  product, and mark anything unverified `"verified": false`. Do not invent print dimensions.
- Let the owner edit products from the UI later. For now, a JSON override file in the workspace merges over the
  defaults.

**1d. Tools: `sidecar/tools/builtin/art.js`.**
- `art.inspect(path)` → inspect output (read; no consent)
- `art.prepare(path, productId, placementId, options)` → writes the variant PNG into the run's workspace or
  project and emits a `deliverable` event the same way `image_generate` does (copy its save and guard path,
  including the fs.js jail) (write; consent-gated like `image_generate`)
- `product.catalog({category?})` → the enabled products (read)
- Wiring, which all four places need, or `capdrift.test.js` fails:
  - `CAP_REGISTRY`: add grants. **Recommendation for v1:** add these grants to the existing `studio` object
    (registry around line 354), so any bay with a STUDIO prop gets them. That avoids new prop types until Phase 6.
  - `sidecar/capability/toolsets.js` (the `studio` TOOLSETS_META description) and `capsummary.js` (the `studio`
    row) so the UI describes the new powers truthfully.
  - `sidecar/tools/registry.js`: register the tools where the image tools register.

Tests (add to `test/fast.list`):
- `art-ops.test.js`: every operation on fixture PNGs. Include a transparent PNG, a flat-background PNG, a
  too-small image and a non-square image. Assert pixel sizes, that the safe zone holds and that `upscaleNeeded`
  is truthful.
- `products.test.js`: the schema validates, overrides merge, and unverified entries are surfaced.
- `art-tools.test.js`: jail enforcement (a path outside the workspace is refused), consent flags and the
  deliverable event.
- `capdrift.test.js` stays green.

### Phase 2 — Design records and the Strategist

**STATUS:** not started

**2a. `sidecar/art/design-store.js`:** an atomic store, one record per dropped design:
```
DesignRecord {
  id: 'dsn_<id>', createdAt, source:{ originalName, droppedPath, storedPath, sha256, width, height },
  status: 'new'|'planned'|'adapting'|'reviewing'|'mocking'|'ready'|'approved'|'rejected'|'failed',
  analysis: { summary, palette[], subjects[], mood, textInArt, notes } | null,
  plan:     { products:[{ productId, placementId, fabricId?, score:0-100, why, colorway?, titleIdeas[] }],
              skipped:[{ productId, reason }], model, createdAt } | null,
  variants: [{ productId, placementId, fabricId?, path, reviewRounds, review:{ verdict, notes } }],
  mockups:  [{ productId, templateId, path }],
  approvals:{ [productId]: 'approved'|'rejected'|'redo' },
  lineRunIds: [], spendUsd, errors:[]
}
```
- Every state change appends to the record. The Gallery (Phase 5) reads only this record, so the UI can never
  show more than the harness did.

**2b. Ingest.** When a FOLDER trigger fires for an image file (`png`, `jpg` or `jpeg`; `webp` and `psd` are a
stretch), the host must **copy the file into the line's project folder or the bay agent's jail before the run
starts**. Today a binary drop arrives as a path plus size only (`triggers.js` `composeFolderItem`), and a path
outside the jail can't be read by the agent's fs or image tools. Then create the DesignRecord and put its id into
the work-item text. Find the binary branch in `trigger-runner.js` (around line 394) and add the hook there or in
the INBOX dispatch. Dedupe by `sha256`: the same image dropped twice links to the existing record.

**2c. Tool `product_plan.submit(designId, plan)`** (write; no network; no consent, because it only writes the
record):
- Validated by `plan-schema.js` against the catalog. Unknown product or placement ids are rejected with a useful
  error so the model retries. There's a 1–8 product cap. A `why` is required per product. Scores must be 0–100.
- This is how the Strategist "decides where it sells best": in a structured, checkable way.

**2d. The STRATEGIST role prompt** (bay standing instructions, written as `LINE_WORK` text for the blueprint):
- Look at the design with `image_analyze`. Read `product.catalog`. Score products on fit: composition and
  aspect, readability at small sizes, how well the palette survives on fabric, whether the subject matter suits
  apparel or wall art, and how much text the art contains.
- Prefer the owner's styles. Neon glitch with statue subjects tends toward posters, streetwear tees, phone cases,
  stickers and cover art. Treat this as a prior, not a rule.
- **No invented market data.** The v1 score is a fit judgment and must say so. Real sales signals arrive in
  Phase 8 through the feedback loop.

Tests: `plan-schema.test.js` (rejections, caps, catalog cross-check), `design-store.test.js` (atomic writes,
state transitions, sha dedupe), and an ingest e2e that drops a fixture PNG in a temp folder and asserts the
record and the copied file (put it in `test/http.list` if it goes through routes).

### Phase 3 — Designer and Reviewer loop

**STATUS:** not started

- **DESIGNER** standing instructions: for each product in `plan.products`, call `art.prepare` with the product,
  placement and fabric, and choose options such as trim, fit mode, anchor and recolor strategy. One variant per
  product. Record the variants on the DesignRecord. If `upscaleNeeded` returns not-ok, skip that product with the
  reason. Never stretch.
- **REVIEWER** (a REVIEWER bay followed by a `loop` back to DESIGNER, the same shape as the existing `revision_loop` blueprint: `intake → bay WRITER → bay REVIEWER → loop → outbox`): for each variant, run
  `image_analyze` with the product spec in the prompt and check legibility, cropping of key subjects (faces,
  text), contrast on the fabric color and edge artifacts. Verdicts are `pass` or `redo` with concrete notes. Cap
  it at **2 redo rounds** per variant. After that, the variant goes to the Gallery marked "needs owner review".
  Don't loop forever.
- A variant that fails review after the cap is still shown, honestly labeled. It is not silently dropped.

Tests: an e2e with a stubbed provider. The scripted Reviewer returns redo then pass. Assert the round counts, the
cap behavior, and the record's final labels.

### Phase 4 — Mockup Lab

**STATUS:** not started

**4a. Template pack format** (`sidecar/art/templates/<packId>/`):
```
pack.json  { id, label, productId, placementId, license, source,
             base: 'base.png',             // blank product photo
             printQuad: [[x,y]x4],          // where the print lands (perspective quad)
             mask?: 'mask.png',             // where print is allowed (alpha)
             shading?: 'shading.png',       // multiply layer for folds/light
             fabricColors?: [...] }
```
- `mockup.js`: perspective-warp the variant into `printQuad`, clip it with `mask`, blend with `shading`
  (multiply), and composite onto `base`. If there's a `fabricColors` entry, tint the base for colored fabric. Use
  the same canvas adapter as Phase 1.
- Tool `mockup.render(designId, productId, templateId?)` → writes the mockup PNG, adds it to the DesignRecord and
  emits a deliverable. It is write and consent-gated, under the same `studio` grant.

**4b. Where the templates come from.** Licensing matters here.
- Bundle only images the owner has the right to use. Options: (1) the owner photographs or supplies blanks;
  (2) photos from a source whose license allows commercial use, with the license recorded in `pack.json`;
  (3) generating blank product photos **once** with `image_generate` (transparent background where useful), then
  having the owner approve them as a template. Building the templates is a one-time setup step. It is not part of
  every run.
- Ship a **template-builder flow** in the Gallery: upload a blank product photo, click 4 corners to set
  `printQuad`, and save the pack. That turns "I need a new mockup" into a 30-second owner task with no code.
- Upstream sprites and art must not be used as templates.

**4c. Optional AI mockup mode (stretch).** A lifestyle scene, such as a model wearing the shirt, rendered through
`image_generate` with the variant as a reference. Label it clearly as "AI scene, not print-accurate". The
deterministic mockup stays the source of truth for what the product looks like.

Tests: `mockup.test.js` covering quad warp bounds, mask clipping, and the deterministic output size with the fake
canvas plus one real-canvas golden image. `template-pack.test.js` covering validation, a license field present
and a bad quad rejected.

### Phase 5 — The ART LINE and the Gallery

**STATUS:** not started

**5a. Blueprint.** Add `art_line` to `BLUEPRINTS` in `frontend/app/worldmodel.js`, with `LINE_PLAIN` and
`LINE_WORK` entries:
- `intake` labeled `ART DROP` with a default budget, for example `limits: { maxUsdPerDay: 5, maxUsdPerMessage: 1 }`,
  modeled on `allowance_desk`, so a flood of drops can't run up a bill.
- `bay` roles `STRATEGIST`, then `DESIGNER`, then `REVIEWER` followed by a `loop` back to DESIGNER (copy the `revision_loop` geometry), then `MOCKUP` (check `ROLE_RE` in
  `linedraft.js`: uppercase, 24 characters max), then `outbox`.
- Each bay's room needs a compute prop and a STUDIO prop to reach the tools. Make sure the blueprint places them,
  or that the REFIT validator flags them.
- Add `art_line` to the SET IT UP FOR ME starter shelf (`sidecar/routing/linedraft.js` reads every blueprint).

**5b. First-run setup ("ART SETUP" window):**
1. Pick a drop folder. This creates the FOLDER trigger bound to the art line, with arming baselining existing
   files exactly as `trigger-folder.js` already does.
2. Pick the AI provider and model, reusing the existing model dock and onboarding.
3. Choose the enabled products (the catalog toggles).
4. Optionally drop a first design and watch it flow.

**5c. Gallery window (`frontend/app/gallery.js`), a docked station window** (DECISIONS: windows, not popovers):
- A grid of DesignRecords, newest first, showing the status chip, thumbnails of variants and mockups, the plan
  with each `why`, review verdicts, spend and errors.
- Per-product actions: **Approve**, **Reject**, **Redo with note** (re-enters the line at DESIGNER with the note)
  and **Open folder**.
- An "Export approved" action that writes a tidy folder per design: `<design>/<product>/print.png`,
  `mockup-*.png` and `listing.txt`. `listing.txt` is a draft with a title, a description and tags written by the
  Strategist (add a small `listing.draft` step or extend `product_plan`). It feeds Phase 8 later and is useful
  right away for manual uploads.
- Reads come only from the design store through a new GET route. There's no client-side invented state.

**Acceptance (the v1 promise):** drop a PNG in the folder. With nothing else touched, a DesignRecord moves
`new → planned → adapting → reviewing → mocking → ready`. The Gallery shows ranked products with reasons, print
files at catalog pixel sizes and mockups. Spend stays inside the INBOX budget. A restart mid-line neither loses
nor duplicates the record. Every visible fact traces to a record field or an event.

### Phase 6 — Player character and interactive rooms

**STATUS:** not started. **Re-check against the owner's video before starting.**

Goal: the owner walks a character around the station and interacts with the rooms where the agents work.

- **Avatar (`frontend/app/avatar.js`)**: a new body, distinct from the agent `hero` and the `crew[]`. It's
  controlled with WASD or the arrow keys, plus click-to-move using the existing pathing (`startBodyPath` and
  `setPathTo` in `world.js`). The camera follows it, with a toggle back to the free camera. Respect collision on
  blocking props.
  - Check the existing keyboard bindings first: the build-mode hotbar uses keys 1–8, Q and Alt (DECISIONS,
    "Build mode / conveyors"), and COMMS/chat captures typing. Movement keys must not fire while a text field
    has focus or build mode is active.
  - Its position is part of the save (follow the versioned save in `frontend/app/save.js`), as an additive field.
- **Interact (E key or click when adjacent)** on room props opens that room's window:
  - ART DROP intake → the setup window, plus a "drop a file here" target (drag a file onto the app window, which
    copies it into the drop folder)
  - STRATEGIST bay → that design's plan board
  - DESIGNER bay or REVIEWER loop → variants and review notes
  - MOCKUP bay → the Gallery
- **Dedicated props for the rooms (optional, in this phase):** new prop types such as `easel` (design studio) and
  `printpress` (mockup lab) mapped to the `studio` capability in `CAP_PROP_MAP`, with sprites the owner supplies
  (Phase 7). If added, update `CAP_PROP_MAP`, `CAP_LABEL` and the prop catalog (`frontend/app/prop-catalog-data.js`),
  and keep `capdrift` green.
- **Game feel driven only by real events:** confetti or sound when a design reaches `ready`, a "shipped" counter,
  and room lights tied to live run state. The repo already has leveling and quest systems
  (`docs/LEVELING_LANE_PLAN.md`, `frontend/app/quests.js`). Hook into them with real events only, such as designs
  completed or approved. **No fake progress.**
- NPC flavor: agents walk to the avatar or face it when it interacts, which reuses the social beats in `world.js`.

Tests: an avatar input unit test with key handling suppressed during text focus and build mode, a save
round-trip with the new field, and live verification through `node dev/seed.js --keep` plus a CDP DOM check
(`docs/BRAIN.md` notes that canvas screenshots time out, so assert DOM and state, not pixels).

### Phase 7 — Rebrand (required before any public distribution)

**STATUS:** not started

- The owner picks the name. The new name, logo and window icon go in `src-tauri/icons`, and the onboarding art
  is replaced.
- **Sprites:** the station's art lives mainly in `frontend/app/propsprites.js` (about 12k lines of sprite data),
  `frontend/js/assets.js`, `frontend/assets/` and the prop remaster data. Inventory every upstream-authored art
  asset, then replace each one or mark it TODO. Suggested direction: lean into the owner's own glitch aesthetic
  (neon, halftone, scanlines) as the visual identity. Ask the owner for source art; don't invent a brand.
- Then a public release pipeline can be set up under the owner's account with their own updater key (reverses
  Phase 0 step 2).

Acceptance: an audit list in this file shows every upstream art asset as replaced or removed.

### Phase 8 — Publish and grow (outline only; plan in detail later)

**STATUS:** not started. **Needs owner decisions** (see §6).

- **PUBLISH line**, started from the art line's OUTBOX through **SEND TO** (DECISIONS: SEND TO is an OUTBOX
  pointer, not a belt). Stages: LISTER (store listing from `listing.txt`), then SOCIAL (captions plus a schedule),
  then a **mandatory owner approval gate** before anything public.
- **Social targets the owner chose:** Instagram, Pinterest, TikTok and X/Threads. Each needs a real API path:
  - Instagram: the Graph API (Business or Creator account linked to a Facebook Page).
  - Pinterest: the API v5.
  - TikTok: the Content Posting API, which needs app approval. Until it's approved, fall back to "draft saved,
    post it manually".
  - X and Threads: their official APIs.
  - Prefer MCP connectors from the curated catalog where they exist (`sidecar/mcp/`). **If a route isn't
    connected, the UI says "not connected". It never pretends to post.**
- **Store:** undecided. Print-on-demand (Printful or Printify feeding Etsy or Shopify) fits the shirts, hats and
  posters. Gumroad fits digital packs. The catalog's `source` fields (Phase 1) should line up with whichever
  provider is chosen.
- **Feedback loop:** views, saves and sales flow back into the DesignRecords, so the Strategist's scores get
  evidence over time. That must be real data only, the same as the `recquality` approach in `docs/BRAIN.md`.
- **Night Shift:** scheduled batch posting of approved items only.

---

## 4. Autonomy and safety rules (apply to every phase)

1. **Anything public needs owner approval.** Posting, listing and messaging customers are consent-gated with no
   standing auto-approve in v1.
2. **Budgets come first.** Every art-line INBOX carries a spend limit by default. Show spend per design in the
   Gallery.
3. **Originals are never modified.** Dropped files are copied, and every output is a new file.
4. **Rights check.** The owner's art may include stock or found imagery, such as statue photos. Add a per-design
   checkbox in the Gallery, "I have commercial rights to everything in this design", required before Export or
   Publish. The app can't verify rights, so it asks. It never claims to have checked.
5. **No invented numbers.** Print specs are cited or marked unverified. Fit scores are labeled as judgments.
   Market and sales claims appear only with real data.
6. **Failure is visible.** A failed stage leaves the record `failed` with the error. It never disappears.

## 5. Definition of done (per phase)

- [ ] Code merged on a phase branch through a PR, with `npm run test:fast` green (and `test:http` for sidecar or
      route changes), or pre-existing failures documented against the Phase 0 baseline.
- [ ] New tests registered in `test/fast.list` or `test/http.list`.
- [ ] Live-verified with `node dev/seed.js --keep`, with the steps written in the PR.
- [ ] This file's STATUS line updated with the commit hash. Mismatches between this plan and the code are noted
      inline.
- [ ] No user-visible upstream branding added, and no unlicensed assets.

## 6. Open questions for the owner

Ask these when the answer is needed. Don't block earlier phases on them.

1. **The video:** how the player character and the interactive experience should feel. Needed before Phase 6.
2. **Platform:** Windows, macOS or both? This drives the Phase 1a packaging spike and the test priority.
3. **AI provider:** OpenRouter key, an Anthropic/OpenAI/Google sign-in, or local Ollama? Vision quality matters
   for the Strategist and Reviewer. Small local models will be weak at visual judgment.
4. **Store:** print-on-demand provider plus Etsy, Shopify or Gumroad. Needed before Phase 8.
5. **Name and brand art:** needed before Phase 7 and before any public release.
6. **Mockup blanks:** does the owner have blank product photos, or should Phase 4 generate starter blanks for
   approval?
7. **Upstream's paid service:** the app still offers "Start with StarNet" (upstream's credits subscription) as a
   way to connect an AI model. Keep it, hide it, or remove it? (Raised in Phase 0.)
