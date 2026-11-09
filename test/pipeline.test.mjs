// Guarded HTTP, publication gates and the collector CLI end to end (against a local mock of the RIPE API).
import test from 'node:test'; import assert from 'node:assert/strict';
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createClient, RateLimited, BudgetExceeded, FetchFailed } from '../src/http.mjs';
import { buildSite, buildControlOnlySite, GateFailure } from '../src/build.mjs';
import { validateDocument, scanLeaks } from '../src/contract.mjs';
import { startMock } from './helpers/mock-ripe.mjs';
import { loadConfig, NOW } from './helpers/ripe-fixtures.mjs';
import { SCHEMA, clone, makeDataset } from './helpers/model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), schemaText = fs.readFileSync(path.join(root, 'contracts', 'internet-model.v1.schema.json'), 'utf8');
const quiet = async () => {};
const client = (m, o = {}) => createClient({ host: 'atlas.ripe.net', allowInsecureHost: m.host, backoffMs: 1, sleep: quiet, ...o });
const url = (m, id = loadConfig().nodes[0].measurement_id) => `http://${m.host}/api/v2/measurements/${id}/latest/?probe_ids=1`;
const cfg = loadConfig();

// ---- guarded HTTP ----
test('http: success returns parsed JSON and counts one request', async () => { const m = await startMock({ config: cfg }); const c = client(m); const j = await c.getJson(url(m)); assert.ok(Array.isArray(j)); assert.equal(c.state.requests, 1); await m.close(); });
test('http: one 429 with Retry-After is retried and succeeds', async () => { const m = await startMock({ config: cfg, failFirst: { status: 429, count: 1, headers: { 'retry-after': '1' } } }); const c = client(m); assert.ok(Array.isArray(await c.getJson(url(m)))); assert.equal(c.state.rate429, 1); await m.close(); });
test('http: a second 429 in the same run aborts the whole run', async () => { const m = await startMock({ config: cfg, failFirst: { status: 429, count: 5 } }); await assert.rejects(client(m).getJson(url(m)), RateLimited); await m.close(); });
test('http: 5xx is retried with backoff and then succeeds', async () => { const m = await startMock({ config: cfg, failFirst: { status: 503, count: 2 } }); const c = client(m); assert.ok(Array.isArray(await c.getJson(url(m)))); assert.equal(c.state.requests, 3); await m.close(); });
test('http: persistent 5xx fails after the retry limit', async () => { const m = await startMock({ config: cfg, failFirst: { status: 500, count: 99 } }); const c = client(m, { retries: 2 }); await assert.rejects(c.getJson(url(m)), FetchFailed); assert.equal(c.state.requests, 3); await m.close(); });
test('http: a 404 is not retried', async () => { const m = await startMock({ config: cfg }); const c = client(m); await assert.rejects(c.getJson(url(m, 1)), FetchFailed); assert.equal(c.state.requests, 1); await m.close(); });
test('http: timeout becomes a FetchFailed', async () => { const m = await startMock({ config: cfg, delayMs: 300 }); await assert.rejects(client(m, { timeoutMs: 40, retries: 0 }).getJson(url(m)), /timeout/); await m.close(); });
test('http: redirects are refused', async () => { const m = await startMock({ config: cfg, redirect: true }); await assert.rejects(client(m).getJson(url(m)), /redirect/); await m.close(); });
test('http: the request budget is a hard cap', async () => { const m = await startMock({ config: cfg }); const c = client(m, { maxRequests: 2 }); await c.getJson(url(m)); await c.getJson(url(m)); await assert.rejects(c.getJson(url(m)), BudgetExceeded); await m.close(); });
test('http: an oversized body is refused', async () => { const m = await startMock({ config: cfg, bodyBytes: 5000 }); await assert.rejects(client(m, { maxBytes: 1000 }).getJson(url(m)), /cap/); await m.close(); });
test('http: only the configured HTTPS host is allowed', async () => {
  const c = createClient({ host: 'atlas.ripe.net', sleep: quiet });
  for (const u of ['https://example.org/x', 'http://atlas.ripe.net/x', 'https://atlas.ripe.net.evil.example/x', 'file:///etc/passwd']) await assert.rejects(c.getJson(u), FetchFailed, u);
  assert.equal(c.state.requests, 0);
});

// ---- publication gates ----
const ctl = (o = {}) => ({ enabled: true, surfaces: { home: true, dashboard: true }, reason: null, ...o });
const NOWISO = '2026-11-09T00:50:27Z';
const build = (o) => buildSite({ schema: SCHEMA, schemaText, controlConfig: ctl(), publication: { permission_status: 'granted' }, dataset: makeDataset({ permission: 'granted' }), nowIso: NOWISO, ...o });
const fixtureDataset = (status) => { const d = makeDataset({ permission: status }); d.provenance.provider = { ...d.provenance.provider, id: 'fixture', name: 'Test fixture', operator: 'Test', attribution: 'Synthetic test data.' }; return d; };
const fails = (fn, code) => assert.throws(fn, (e) => e instanceof GateFailure && e.code === code, `expected GateFailure ${code}`);

test('gate: permission pending blocks publication of any dataset', () => fails(() => build({ publication: { permission_status: 'pending' }, dataset: makeDataset({ permission: 'pending' }) }), 'permission'));
test('gate: granted RIPE data publishes a valid site tree (control, home view, schema)', () => {
  const r = build(); assert.equal(r.mode, 'publish'); assert.deepEqual([...r.files.keys()].sort(), ['robots.txt', 'v1/control.json', 'v1/schema/internet-model.json', 'v1/views/home.json']);
  const home = JSON.parse(r.files.get('v1/views/home.json')); assert.deepEqual(validateDocument(SCHEMA, home, { dataset: r.dataset }), []); assert.equal(home.pairs.length, 45); assert.equal(scanLeaks(home).length, 0);
});
test('gate: the dataset itself is never part of the site tree (it stays a CI artifact)', () => assert.ok(![...build().files.keys()].some((k) => k.includes('dataset'))));
test('gate: synthetic permission may publish only a fixture provider, marked simulated', () => {
  fails(() => build({ publication: { permission_status: 'synthetic' }, dataset: makeDataset({ permission: 'synthetic' }) }), 'permission');
  const r = build({ publication: { permission_status: 'synthetic' }, dataset: fixtureDataset('synthetic') }); assert.equal(JSON.parse(r.files.get('v1/views/home.json')).attribution.simulated, true);
});
test('gate: a fixture dataset can never be published as real data', () => fails(() => build({ dataset: fixtureDataset('granted') }), 'permission'));
test('gate: dataset and config disagreeing about permission is refused', () => fails(() => build({ publication: { permission_status: 'granted' }, dataset: makeDataset({ permission: 'not_required' }) }), 'permission'));
test('gate: an unknown permission status is refused', () => fails(() => build({ publication: { permission_status: 'yes' }, dataset: makeDataset({ permission: 'yes' }) }), 'permission'));
test('gate: fewer than half the pairs with data is refused (quality), the previous deployment stays', () => {
  const others = cfg.nodes.map((n) => n.id), per = {}; for (const id of ['syd', 'tyo', 'sin', 'lon', 'gru', 'dxb']) per[id] = { missing: others };
  fails(() => build({ dataset: makeDataset({ permission: 'granted', q: { missing: ['syd', 'tyo', 'sin', 'lon', 'gru', 'dxb'] }, perNode: per }) }), 'quality');
});
test('gate: an invalid dataset is refused (validation)', () => { const d = makeDataset({ permission: 'granted' }); d.observations[0].loss.rcvd = 99; fails(() => build({ dataset: d }), 'validation'); });
test('gate: a leaked address in any string is refused', () => { const d = makeDataset({ permission: 'granted' }); d.notes[0] = 'seen from 192.0.2.5'; fails(() => build({ dataset: d }), 'validation'); });
test('gate: disabled control builds a control-only site with no dataset needed', () => {
  const r = buildSite({ schema: SCHEMA, schemaText, controlConfig: ctl({ enabled: false, reason: 'maintenance' }), publication: { permission_status: 'pending' }, dataset: null, nowIso: NOWISO });
  assert.equal(r.mode, 'control-only'); assert.deepEqual([...r.files.keys()].sort(), ['robots.txt', 'v1/control.json', 'v1/schema/internet-model.json']);
  const c = JSON.parse(r.files.get('v1/control.json')); assert.deepEqual([c.enabled, c.surfaces.home, c.surfaces.dashboard, c.reason], [false, false, false, 'maintenance']); assert.deepEqual(validateDocument(SCHEMA, c), []);
});
test('gate: enabled but no dataset is refused', () => fails(() => build({ dataset: null }), 'validation'));

// ---- collector CLI end to end ----
function setup({ control = true, permission = 'granted' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idata-')), c = path.join(dir, 'config'); fs.mkdirSync(c);
  fs.copyFileSync(path.join(root, 'config', 'nodes.json'), path.join(c, 'nodes.json'));
  fs.writeFileSync(path.join(c, 'control.json'), JSON.stringify({ enabled: control, surfaces: { home: true, dashboard: true }, reason: control ? null : 'test' }));
  fs.writeFileSync(path.join(c, 'publication.json'), JSON.stringify({ permission_status: permission }));
  return { dir, c, site: path.join(dir, 'site') };
}
const exec = (args) => new Promise((resolve) => { const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d)); p.on('close', (status) => resolve({ status, stdout: out, stderr: err })); });
const run = (m, s, extra = []) => exec([path.join(root, 'src', 'collect.mjs'), '--out', s.site, '--config-dir', s.c, '--api-base', m ? m.base : 'http://127.0.0.1:9/api/v2', '--allow-host', m ? m.host : '127.0.0.1:9', '--pacing', '0', '--backoff', '1', '--now', '2026-11-09T00:50:27Z', ...extra]);

test('cli: granted + enabled collects ten requests and writes a valid, address-free site', async () => {
  const m = await startMock({ config: cfg }), s = setup(), r = await run(m, s);
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.equal(m.seen.length, 10);
  const home = JSON.parse(fs.readFileSync(path.join(s.site, 'v1/views/home.json'), 'utf8')); assert.equal(home.pairs.length, 45);
  for (const f of ['v1/control.json', 'v1/views/home.json']) { const t = fs.readFileSync(path.join(s.site, f), 'utf8'); for (const bad of ['192.0.2.', '198.51.100.', ...cfg.nodes.map((n) => n.target_ip)]) assert.ok(!t.includes(bad)); }
  await m.close();
});
test('cli: permission pending refuses BEFORE any provider request (exit 3)', async () => {
  const m = await startMock({ config: cfg }), s = setup({ permission: 'pending' }), r = await run(m, s);
  assert.equal(r.status, 3); assert.equal(m.seen.length, 0); assert.ok(!fs.existsSync(s.site)); await m.close();
});
test('cli: disabled control deploys the kill-switch site and makes no provider request', async () => {
  const m = await startMock({ config: cfg }), s = setup({ control: false, permission: 'pending' }), r = await run(m, s);
  assert.equal(r.status, 0, r.stderr); assert.equal(m.seen.length, 0); const c = JSON.parse(fs.readFileSync(path.join(s.site, 'v1/control.json'), 'utf8')); assert.equal(c.enabled, false); assert.ok(!fs.existsSync(path.join(s.site, 'v1/views'))); await m.close();
});
test('cli: two 429 responses abort the run (exit 4) and write nothing', async () => {
  const m = await startMock({ config: cfg, failFirst: { status: 429, count: 99 } }), s = setup(), r = await run(m, s);
  assert.equal(r.status, 4); assert.ok(!fs.existsSync(s.site)); await m.close();
});
test('cli: a provider outage (500) fails the run (exit 4) and writes nothing, so the previous deployment stays', async () => {
  const m = await startMock({ config: cfg, failFirst: { status: 500, count: 99 } }), s = setup(), r = await run(m, s, ['--timeout', '2000']);
  assert.equal(r.status, 4); assert.ok(!fs.existsSync(s.site)); await m.close();
});
test('cli: data with too many gaps fails the quality gate (exit 2) and writes no site', async () => {
  const others = cfg.nodes.map((n) => n.id), per = {}; for (const id of ['syd', 'tyo', 'sin', 'lon', 'gru', 'dxb']) per[id] = { missing: others };
  const m = await startMock({ config: cfg, q: { missing: ['syd', 'tyo', 'sin', 'lon', 'gru', 'dxb'] }, perNode: per }), s = setup(), r = await run(m, s);
  assert.equal(r.status, 2); assert.ok(!fs.existsSync(s.site)); await m.close();
});
test('cli: the collector refuses to talk to any host other than RIPE unless a test host is allowed', async () => {
  const s = setup(), r = await exec([path.join(root, 'src', 'collect.mjs'), '--out', s.site, '--config-dir', s.c, '--api-base', 'http://127.0.0.1:9/api/v2', '--pacing', '0']);
  assert.equal(r.status, 4); assert.match(r.stderr, /refusing/);
});
