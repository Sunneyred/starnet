/* Issue #101: native-shaped erase marker, real production-mode sidecar boot/restart and explicit restore. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const A = require('./_assert.js');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const Save = require('../frontend/app/save.js');

function write(root, rel, value) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
(async () => {
  const fixture = SidecarFixture.create({ prefix: 'starnet-erased-restart-', timeoutMs: 30000, env: {
    STARNET_DEV: '0', SKYNET_DEV: '0', STARNET_CRON_ENABLED: '0', SKYNET_CRON_ENABLED: '0',
    STARNET_LOOP_ENABLED: '0', SKYNET_LOOP_ENABLED: '0', STARNET_EDGE_TTS: '0', SKYNET_EDGE_TTS: '0',
    STARNET_CLOUD_URL: 'http://127.0.0.1:1', STARNET_CREDITS_URL: 'http://127.0.0.1:1',
    STARNET_SCRATCH_ROOT: '', SKYNET_SCRATCH_ROOT: '', STARNET_DESKTOP_SHELL: '0',
    OPENROUTER_API_KEY: '', SKYNET_OPENROUTER_KEY: '', STARNET_OPENROUTER_KEY: '',
    OPENAI_API_KEY: '', SKYNET_OPENAI_API_KEY: '', STARNET_OPENAI_API_KEY: '',
    STARNET_DEFAULT_MODEL: 'test/replay', SKYNET_DEFAULT_MODEL: 'test/replay'
  } });
  const fixtureRoot = fixture.workspace;
  fixture.workspace = path.join(fixtureRoot, 'workspaces');
  fs.mkdirSync(fixture.workspace);
  // All candidate roots are synthetic. A separate child temp directory allows this hermetic workspace
  // to exercise production auto recovery instead of passing only because the scratch-root guard skipped it.
  const childTemp = path.join(fixture.profile, 'runtime-temp');
  fs.mkdirSync(childTemp);
  Object.assign(fixture.env, { HOME: fixture.profile, USERPROFILE: fixture.profile,
    TMP: childTemp, TEMP: childTemp, TMPDIR: childTemp });
  const legacy = path.join(fixture.profile, require('../frontend/app/brand.js').DATA_DIR_NAME, 'workspaces');
  const marker = { version: 1, erased: true, at: '2026-10-11T00:00:00.000Z', acknowledgedRoots: [legacy], quarantine: null, moved: [] };
  const markerBytes = JSON.stringify(marker);
  write(fixture.workspace, '.fresh-start.json', markerBytes);
  write(fixture.workspace, '.migrated', '1');
  write(legacy, 'agent.save.json', { version: 1, agentId: 'agent', updatedAt: 1000, savedAt: 1000, doc: {
    schema: 'starnet.save', version: Save.CURRENT, updatedAt: 1000,
    agent: { id: 'agent', name: 'SYNTHETIC-OLD-STATION', provider: 'replay', model: 'test/replay' },
    station: { rooms: [{ id: 'old-command' }], props: [] }, workstreams: [], activeId: 'general', generalId: 'general'
  } });
  write(legacy, '.fresh-start.json', { version: 1, acknowledgedRoots: [] });
  const sourceBytes = fs.readFileSync(path.join(legacy, 'agent.save.json'));
  const extraRoots = [];
  try {
    await fixture.start();
    let save = await fixture.json('GET', '/api/save?agent=agent');
    A.eq(save.status, 200, 'erased generation boots and serves the real save route');
    A.eq(save.body.save, null, 'first production boot does not resurrect the old station');
    A.eq(save.body.lineage.onboardingAllowed, true, 'first production boot permits clean onboarding: ' + JSON.stringify(save.body.lineage));
    A.ok(fixture.output().includes('AUTO_RECOVERY_ERASED'), 'boot reports the actual erase authority');
    A.ok(save.body.lineage.autoRecovery.reason.includes('ERASE EVERYTHING'), 'lineage telemetry names the actual erase authority');
    A.ok(!fixture.output().includes('AUTO_RECOVERY_TARGET_IS_SCRATCH'), 'proof exercises erase policy rather than scratch guard');
    A.eq(fs.readFileSync(path.join(fixture.workspace, '.fresh-start.json'), 'utf8'), markerBytes, 'first boot preserves exact erase marker');
    A.ok(fs.readFileSync(path.join(legacy, 'agent.save.json')).equals(sourceBytes), 'first boot preserves legacy source bytes');

    await fixture.restart();
    save = await fixture.json('GET', '/api/save?agent=agent');
    A.eq(save.body.save, null, 'next production boot remains a new station');
    A.eq(save.body.lineage.onboardingAllowed, true, 'clean onboarding survives a sidecar restart: ' + JSON.stringify(save.body.lineage));
    A.eq(fs.readFileSync(path.join(fixture.workspace, '.fresh-start.json'), 'utf8'), markerBytes, 'restart preserves the erase marker');

    const lineage = await fixture.json('GET', '/api/lineage');
    const candidate = lineage.body.lineage.recovery.candidates.find(c => c.stationName === 'SYNTHETIC-OLD-STATION');
    A.ok(candidate && candidate.recoverable, 'operator can still inspect the preserved old station');
    if (!candidate) throw new Error('synthetic recovery candidate missing');
    const requested = await fixture.json('POST', '/api/lineage/recover', { candidateId: candidate.id });
    A.eq(requested.status, 202, 'authenticated explicit restore is admitted after erase');
    const child = fixture.child;
    await new Promise((resolve, reject) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error('explicit recovery did not request restart')), 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await fixture.restart();
    save = await fixture.json('GET', '/api/save?agent=agent');
    A.eq(save.body.save && save.body.save.agent.name, 'SYNTHETIC-OLD-STATION', 'explicit restore takes effect at real next boot');
    A.ok(fs.readFileSync(path.join(legacy, 'agent.save.json')).equals(sourceBytes), 'explicit restore preserves source bytes');
    const parent = path.dirname(fixture.workspace), base = path.basename(fixture.workspace);
    const rollback = fs.readdirSync(parent).find(n => n.startsWith(base + '.recovery-rollback-'));
    if (rollback) extraRoots.push(path.join(parent, rollback));
    A.ok(rollback, 'explicit restore keeps the superseded clean generation');
    A.eq(rollback && fs.readFileSync(path.join(parent, rollback, '.fresh-start.json'), 'utf8'), markerBytes, 'rollback keeps the exact superseded erase marker');
    await fixture.restart();
    save = await fixture.json('GET', '/api/save?agent=agent');
    A.eq(save.body.save && save.body.save.agent.name, 'SYNTHETIC-OLD-STATION', 'explicitly restored live station survives another restart');
  } finally {
    const parent = path.dirname(fixture.workspace), base = path.basename(fixture.workspace);
    await fixture.dispose();
    // Only the constructor-minted workspace siblings belong to this test.
    for (const name of fs.readdirSync(parent)) {
      if (name.startsWith(base + '.recovery-')) extraRoots.push(path.join(parent, name));
    }
    for (const target of new Set(extraRoots)) {
      if (path.dirname(target) !== parent || !path.basename(target).startsWith(base + '.recovery-')) throw new Error('unsafe fixture cleanup');
      fs.rmSync(target, { recursive: true, force: true });
    }
    if (path.dirname(fixtureRoot) !== path.resolve(require('node:os').tmpdir()) || !path.basename(fixtureRoot).startsWith('starnet-erased-restart-')) throw new Error('unsafe fixture root cleanup');
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
  A.report('workspace-recovery-fresh-start.http.test');
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
