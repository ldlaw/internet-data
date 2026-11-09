// Gate 2B: the synthetic fixture path. Simulated data must be unmistakable in the schema and in every published document, must need no network,
// and every deliberate fault must fail BEFORE a site tree is written (so the previous deployment stays online).
import test from 'node:test'; import assert from 'node:assert/strict';
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { validateDocument, scanLeaks, SYNTHETIC_ID_BASE } from '../src/contract.mjs';
import { collectSynthetic, syntheticConfig, FAULTS } from '../src/adapters/fixture-ping.mjs';
import { buildSite, GateFailure } from '../src/build.mjs';
import { curateHome } from '../src/curate.mjs';
import { loadConfig, NOW } from './helpers/ripe-fixtures.mjs';
import { SCHEMA, clone, isoZ, makeDataset } from './helpers/model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), schemaText = fs.readFileSync(path.join(root, 'contracts', 'internet-model.v1.schema.json'), 'utf8'), cfg = loadConfig(), NOWISO = isoZ(NOW);
const synth = (o = {}) => collectSynthetic(cfg, { nowSeconds: NOW, fetchedAt: NOWISO, ...o });
const ctl = { enabled: true, surfaces: { home: true, dashboard: true }, reason: null };
const build = (dataset, status = 'synthetic') => buildSite({ schema: SCHEMA, schemaText, controlConfig: ctl, publication: { permission_status: status }, dataset, nowIso: NOWISO });
const errs = (d, ctx) => validateDocument(SCHEMA, d, ctx);

// ---- the fixture is complete, realistic in shape, and simulated everywhere ----
test('synthetic: a full valid dataset, 90 directed observations, 45 published pairs, no gaps', () => {
  const d = synth(); assert.deepEqual(errs(d), []); assert.equal(d.observations.length, 90); assert.deepEqual(d.coverage.dropped, {});
  const r = build(d); const home = JSON.parse(r.files.get('v1/views/home.json')); assert.deepEqual(errs(home, { dataset: d }), []); assert.equal(home.pairs.length, 45); assert.equal(home.gaps.length, 0);
});
test('synthetic: the data has variety (loss on some pairs, spread of ages and RTTs), so the display is exercised realistically', () => {
  const home = curateHome(synth()), rtts = home.pairs.map((p) => p.rtt_median), ages = new Set(home.pairs.map((p) => p.observed));
  assert.ok(home.pairs.some((p) => p.loss_pct > 0), 'some loss'); assert.ok(home.pairs.some((p) => p.loss_pct === 0)); assert.ok(Math.max(...rtts) > 100 && Math.min(...rtts) < 30); assert.ok(ages.size > 20);
});
test('synthetic: marked simulated in five independent places', () => {
  const d = synth(), home = curateHome(d);
  assert.equal(d.provenance.simulated, true); assert.equal(d.provenance.publication.permission_status, 'synthetic'); assert.equal(d.provenance.provider.id, 'fixture'); assert.ok(d.dataset_id.startsWith('synthetic-'));
  assert.ok(d.endpoints.every((e) => e.refs.anchor_id > SYNTHETIC_ID_BASE && e.refs.probe_id > SYNTHETIC_ID_BASE)); assert.ok(d.observations.every((o) => o.source.measurement_id > SYNTHETIC_ID_BASE && o.source.probe_id > SYNTHETIC_ID_BASE));
  assert.match(d.notes[0], /^SIMULATED/); assert.match(d.provenance.provider.name, /synthetic/i); assert.match(d.provenance.provider.attribution, /simulated/i);
  assert.equal(home.attribution.simulated, true); assert.match(home.attribution.text, /^SIMULATED/); assert.match(home.attribution.disclaimer, /simulated/i); assert.ok(home.pairs.every((p) => p.measurement_id > SYNTHETIC_ID_BASE && p.probe_id > SYNTHETIC_ID_BASE));
});
test('synthetic: no published document mentions RIPE or carries an address or a real identifier', () => {
  const r = build(synth()); for (const f of ['v1/control.json', 'v1/views/home.json']) {
    const t = r.files.get(f); assert.ok(!/ripe/i.test(t), f + ' mentions RIPE'); assert.deepEqual(scanLeaks(JSON.parse(t)), []);
    for (const bad of [...cfg.nodes.map((n) => n.target_ip), ...cfg.nodes.map((n) => String(n.measurement_id)), ...cfg.nodes.map((n) => String(n.probe_id)), ...cfg.nodes.map((n) => n.target_fqdn).filter(Boolean)]) assert.ok(!t.includes(bad), `${f} contains ${bad}`);
  }
});
test('synthetic: the synthetic config never carries a real anchor address, probe id or measurement id', () => {
  const sc = syntheticConfig(cfg), real = new Set(cfg.nodes.flatMap((n) => [n.target_ip, n.anchor_id, n.probe_id, n.measurement_id, n.target_fqdn]));
  for (const n of sc.nodes) for (const v of Object.values(n)) assert.ok(!real.has(v), String(v));
});
test('synthetic: deterministic for a given instant (same bytes), different instants differ in time only', () => {
  const a = JSON.stringify(curateHome(synth())), b = JSON.stringify(curateHome(synth())); assert.equal(a, b);
  const later = curateHome(collectSynthetic(cfg, { nowSeconds: NOW + 1800, fetchedAt: isoZ(NOW + 1800) })), now = curateHome(synth());
  assert.notEqual(later.generated_at, now.generated_at); assert.deepEqual(later.pairs.map((p) => p.rtt_median), now.pairs.map((p) => p.rtt_median));
});
test('synthetic: freshness is realistic, every pair measured within 10 minutes of generation', () => {
  const home = curateHome(synth()), g = Date.parse(home.generated_at) / 1000; for (const p of home.pairs) assert.ok(g - Date.parse(p.observed) / 1000 < 600, p.src);
});

// ---- the contract refuses every inconsistent mix of real and simulated ----
const bad = (mut, re, which = 'dataset') => { const d = synth(), home = curateHome(d), t = clone(which === 'dataset' ? d : home); mut(t); const e = which === 'dataset' ? errs(t) : errs(t, { dataset: d }); assert.ok(e.some((m) => re.test(m)), `${re} not in ${JSON.stringify(e.slice(0, 4))}`); };
test('contract: simulated=false on a synthetic-status dataset is refused', () => bad((d) => { d.provenance.simulated = false; }, /simulated must be true exactly when permission_status/));
test('contract: simulated=true with a non-fixture provider is refused', () => bad((d) => { d.provenance.provider.id = 'ripe-atlas'; }, /exactly when the provider id is 'fixture'/));
test('contract: simulated data without the synthetic- dataset prefix is refused', () => bad((d) => { d.dataset_id = 'ripe-atlas.test'; }, /must start with 'synthetic-'/));
test('contract: simulated data with a real-looking identifier is refused', () => bad((d) => { d.observations[0].source.measurement_id = 22453852; }, /reserved synthetic range/));
test('contract: simulated data pointing at RIPE is refused', () => bad((d) => { d.provenance.provider.url = 'https://atlas.ripe.net/'; }, /must not point at RIPE/));
test('contract: simulated data whose first note does not say SIMULATED is refused', () => bad((d) => { d.notes[0] = 'Test values for hosting.'; }, /SIMULATED/));
test('contract: simulated data whose provider does not say synthetic is refused', () => bad((d) => { d.provenance.provider.name = 'Measurement service'; }, /provider.name must say/));
test('contract: real data using the synthetic- prefix is refused', () => { const d = makeDataset({ permission: 'granted' }); d.dataset_id = 'synthetic-real'; assert.ok(errs(d).some((m) => /reserved 'synthetic-' prefix/.test(m))); });
test('contract: real data with an identifier in the reserved synthetic range is refused', () => { const d = makeDataset({ permission: 'granted' }); d.observations[0].source.probe_id = SYNTHETIC_ID_BASE + 5; assert.ok(errs(d).some((m) => /reserved synthetic range but the data is not marked simulated/.test(m))); });
test('contract: a dataset without the simulated field is refused (the marker is required)', () => { const d = synth(); delete d.provenance.simulated; assert.ok(errs(d).some((m) => /simulated: required/.test(m))); });
test('contract: the home view must agree with the dataset about being simulated', () => bad((h) => { h.attribution.simulated = false; h.attribution.text = 'Measurements from RIPE Atlas.'; h.dataset_id = 'ripe-atlas.test'; }, /differs from the dataset provenance/, 'home'));
test('contract: a simulated home view whose text does not start with SIMULATED is refused', () => bad((h) => { h.attribution.text = 'Test values for hosting.'; }, /SIMULATED/, 'home'));
test('contract: a real home view with the synthetic- prefix is refused', () => { const d = makeDataset({ permission: 'granted' }), h = curateHome(d); h.dataset_id = 'synthetic-x'; assert.ok(errs(h).some((m) => /reserved 'synthetic-' prefix/.test(m))); });

// ---- gates: faults fail before any site tree exists ----
const fails = (fn, code) => assert.throws(fn, (e) => e instanceof GateFailure && e.code === code, `expected GateFailure ${code}`);
test('faults: validation, quality and permission each fail the matching gate', () => {
  fails(() => build(synth({ fault: 'validation' })), 'validation'); fails(() => build(synth({ fault: 'quality' })), 'quality'); fails(() => build(synth({ fault: 'permission' })), 'permission');
});
test('faults: collection fault throws a provider-style failure; unknown faults are rejected', () => { assert.throws(() => synth({ fault: 'collection' }), /simulated provider outage/); assert.throws(() => synth({ fault: 'bogus' }), /unknown fault/); });
test('faults: the list of faults is fixed and includes none', () => assert.deepEqual(FAULTS, ['none', 'validation', 'quality', 'permission', 'collection']));

// ---- CLI: no network, exit codes, nothing written on failure, faults impossible on real data ----
function setup({ control = true, permission = 'synthetic' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idata-syn-')), c = path.join(dir, 'config'); fs.mkdirSync(c);
  fs.copyFileSync(path.join(root, 'config', 'nodes.json'), path.join(c, 'nodes.json'));
  fs.writeFileSync(path.join(c, 'control.json'), JSON.stringify({ enabled: control, surfaces: { home: true, dashboard: true }, reason: control ? null : 'test' }));
  fs.writeFileSync(path.join(c, 'publication.json'), JSON.stringify({ permission_status: permission }));
  return { dir, c, site: path.join(dir, 'site') };
}
const exec = (args) => new Promise((resolve) => { const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d)); p.on('close', (status) => resolve({ status, stdout: out, stderr: err })); });
// --api-base points at a closed port: any attempt to reach a provider would exit 4, so exit 0 proves that no request was made
const run = (s, extra = []) => exec([path.join(root, 'src', 'collect.mjs'), '--out', s.site, '--config-dir', s.c, '--api-base', 'http://127.0.0.1:9/api/v2', '--pacing', '0', '--backoff', '1', '--timeout', '500', '--now', NOWISO, ...extra]);

test('cli: synthetic + enabled writes a valid simulated site and makes no network request (exit 0 against a closed port)', async () => {
  const s = setup(), r = await run(s); assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /SIMULATED/);
  const home = JSON.parse(fs.readFileSync(path.join(s.site, 'v1/views/home.json'), 'utf8')); assert.equal(home.attribution.simulated, true); assert.equal(home.pairs.length, 45);
  assert.deepEqual(fs.readdirSync(s.site).sort(), ['robots.txt', 'v1']);
});
test('cli: each fault exits with its gate code and writes no site tree', async () => {
  for (const [fault, code] of [['validation', 2], ['quality', 2], ['permission', 3], ['collection', 4]]) { const s = setup(), r = await run(s, ['--fault', fault]); assert.equal(r.status, code, `${fault}: ${r.stderr}`); assert.ok(!fs.existsSync(s.site), fault); }
});
test('cli: --fault none behaves as no fault; an unknown fault exits 2 and writes nothing', async () => {
  const a = setup(), ra = await run(a, ['--fault', 'none']); assert.equal(ra.status, 0, ra.stderr);
  const b = setup(), rb = await run(b, ['--fault', 'bogus']); assert.equal(rb.status, 2); assert.ok(!fs.existsSync(b.site));
});
const setFault = (s, permission, rehearsal_fault) => fs.writeFileSync(path.join(s.c, 'publication.json'), JSON.stringify({ permission_status: permission, rehearsal_fault }));
test('cli: a rehearsal_fault in config/publication.json drives the same gates as --fault (so a reviewed commit can rehearse them)', async () => {
  for (const [fault, code] of [['validation', 2], ['quality', 2], ['permission', 3], ['collection', 4]]) { const s = setup(); setFault(s, 'synthetic', fault); const r = await run(s); assert.equal(r.status, code, `${fault}: ${r.stderr}`); assert.ok(!fs.existsSync(s.site), fault); }
  const ok = setup(); setFault(ok, 'synthetic', 'none'); const r = await run(ok); assert.equal(r.status, 0, r.stderr);
});
test('cli: --fault wins over the config fault; an unknown config fault exits 2 and writes nothing', async () => {
  const a = setup(); setFault(a, 'synthetic', 'validation'); const ra = await run(a, ['--fault', 'permission']); assert.equal(ra.status, 3, ra.stderr);
  const b = setup(); setFault(b, 'synthetic', 'bogus'); const rb = await run(b); assert.equal(rb.status, 2); assert.ok(!fs.existsSync(b.site));
});
test('cli: a leftover config fault on real-data permission states fails the run loudly instead of being ignored (exit 3, no provider request)', async () => {
  for (const status of ['granted', 'not_required', 'pending']) { const s = setup(); setFault(s, status, 'validation'); const r = await run(s); assert.equal(r.status, 3, `${status}: ${r.stderr}`); assert.ok(!fs.existsSync(s.site)); }
});
test('cli: fault injection is refused for real-data permission states, before any provider request', async () => {
  for (const status of ['granted', 'not_required', 'pending']) { const s = setup({ permission: status }), r = await run(s, ['--fault', 'validation']); assert.equal(r.status, 3, `${status}: ${r.stderr}`); assert.ok(!fs.existsSync(s.site)); }
});
test('cli: a disabled control still deploys the kill-switch site in synthetic mode, with no dataset', async () => {
  const s = setup({ control: false }), r = await run(s); assert.equal(r.status, 0, r.stderr); const c = JSON.parse(fs.readFileSync(path.join(s.site, 'v1/control.json'), 'utf8')); assert.equal(c.enabled, false); assert.ok(!fs.existsSync(path.join(s.site, 'v1/views')));
});
test('cli: whatever supported state the committed configuration is in (data on, kill switch engaged, or a rehearsal fault) it stays synthetic and the collector behaves as documented', async () => {
  // This test runs in CI BEFORE the collector. It must therefore accept every state an operator may legitimately commit: pinning "enabled" or "no fault"
  // would make the Tests step fail first, so the kill switch could never deploy and a rehearsal fault could never reach the gate it is meant to exercise.
  const pub = JSON.parse(fs.readFileSync(path.join(root, 'config', 'publication.json'), 'utf8')), con = JSON.parse(fs.readFileSync(path.join(root, 'config', 'control.json'), 'utf8')), fault = pub.rehearsal_fault ?? 'none';
  assert.equal(pub.permission_status, 'synthetic');   // Gate 2B stays synthetic-only in every state
  assert.ok(FAULTS.includes(fault), `unknown rehearsal_fault ${fault}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idata-cfg-')), site = path.join(dir, 'site'), r = await exec([path.join(root, 'src', 'collect.mjs'), '--out', site, '--api-base', 'http://127.0.0.1:9/api/v2', '--timeout', '500']);
  if (con.enabled !== true) {   // kill switch engaged: control-only tree, no data view, no provider activity
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'v1/control.json'), 'utf8')).enabled, false); assert.ok(!fs.existsSync(path.join(site, 'v1/views')));
  } else if (fault === 'none') {   // normal synthetic publication
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(JSON.parse(fs.readFileSync(path.join(site, 'v1/views/home.json'), 'utf8')).attribution.simulated, true);
  } else {   // a rehearsal fault fails exactly the gate it names and writes no site at all
    assert.equal(r.status, { validation: 2, quality: 2, permission: 3, collection: 4 }[fault], r.stderr + r.stdout); assert.ok(!fs.existsSync(site));
  }
});
