// Adapter and curation behaviour on synthetic RIPE-shaped data, including every quirk seen on the real API.
import test from 'node:test'; import assert from 'node:assert/strict';
import { validateDocument, scanLeaks } from '../src/contract.mjs';
import { curateHome } from '../src/curate.mjs';
import { plan } from '../src/adapters/ripe-atlas-ping.mjs';
import { loadConfig } from './helpers/ripe-fixtures.mjs';
import { SCHEMA, clone, makeDataset, makeModel } from './helpers/model.mjs';

const valid = (d, o) => assert.deepEqual(validateDocument(SCHEMA, d, o), []);
const find = (d, id) => d.observations.find((o) => o.id === id);

test('plan: ten requests, one per target, each asking for the other nine probes, 10 results, lookback of one day', () => {
  const p = plan(loadConfig()); assert.equal(p.length, 10);
  for (const s of p) assert.match(s.url, /\/measurements\/\d+\/latest\/\?probe_ids=(\d+,){8}\d+&versions=10&lookback_days=1$/);
});
test('baseline: 90 observations, strictly valid, nothing dropped', () => { const d = makeDataset(); assert.equal(d.observations.length, 90); assert.deepEqual(d.coverage.dropped, {}); valid(d); });
test('response shape: array and keyed-object responses give identical datasets', () => assert.deepEqual(makeDataset({ q: { shape: 'object' } }), makeDataset({ q: { shape: 'array' } })));
test('junk rows (null, strings, numbers, rows without fields) are ignored', () => assert.deepEqual(makeDataset({ q: { junk: true } }).observations, makeDataset().observations));
test('self-pair rows returned by the API never become observations', () => { const d = makeDataset({ q: { self: true } }); assert.equal(d.observations.length, 90); assert.ok(d.observations.every((o) => o.src !== o.dst)); });
test('stale rows: a probe whose only result is from 2021 yields no observation and is counted, not shown as live', () => {
  const d = makeDataset({ q: { stale: ['syd'] } });
  assert.equal(d.observations.length, 81); assert.equal(d.observations.filter((o) => o.src === 'syd').length, 0);
  assert.equal(d.coverage.dropped.stale_rows, 9); assert.equal(d.coverage.dropped.no_fresh_result, 9); valid(d);
});
test('wrong destination address: the row is dropped and counted', () => { const d = makeDataset({ q: { wrongDst: ['ash'] } }); assert.equal(d.coverage.dropped.wrong_destination, 9); assert.equal(find(d, 'ping:ash>fra').results, 9); valid(d); });
test('future timestamp: the row is dropped and counted', () => { const d = makeDataset({ q: { future: ['lon'] } }); assert.equal(d.coverage.dropped.future_timestamp, 9); valid(d); });
test('impossible RTT (5 s): rows dropped, no observation, never published', () => { const d = makeDataset({ q: { impossible: ['tyo'] } }); assert.equal(d.observations.filter((o) => o.src === 'tyo').length, 0); assert.ok(d.coverage.dropped.implausible_rtt > 0); valid(d); });
test('RTT below the speed-of-light bound: pairs dropped and counted', () => { const d = makeDataset({ q: { fast: ['ash'] } }); assert.equal(d.observations.filter((o) => o.src === 'ash').length, 0); assert.equal(d.coverage.dropped.below_fibre_bound, 9); valid(d); });
test('packet loss is aggregated over the window and flagged, without lowering quality', () => {
  const o = find(makeDataset({ q: { loss: { fra: 1 } } }), 'ping:fra>ash'); assert.equal(o.loss.sent, 30); assert.equal(o.loss.rcvd, 29); assert.equal(o.loss.pct, 3.3);
  assert.deepEqual(o.quality, { level: 'good', flags: ['loss_observed'] });
});
test('total loss: rtt is null and loss is 100 percent, still a valid observation', () => { const d = makeDataset({ q: { dead: ['gru'] } }), o = find(d, 'ping:gru>ash'); assert.equal(o.rtt_ms, null); assert.equal(o.loss.pct, 100); valid(d); });
test('few results lower quality: 3 results is degraded, 2 is poor', () => {
  assert.deepEqual(find(makeDataset({ q: { few: { lax: 3 } } }), 'ping:lax>ash').quality, { level: 'degraded', flags: ['few_results'] });
  assert.equal(find(makeDataset({ q: { few: { lax: 2 } } }), 'ping:lax>ash').quality.level, 'poor');
});
test('unsynchronised probe clock is flagged', () => assert.deepEqual(find(makeDataset({ q: { lts: { tyo: 5000 } } }), 'ping:tyo>ash').quality, { level: 'degraded', flags: ['clock_unsynced'] }));
test('observations older than 15 minutes at generation are flagged aged', () => assert.ok(makeDataset({ q: { age: 1200 } }).observations.every((o) => o.quality.flags.includes('aged') && o.quality.level === 'degraded')));
test('privacy: no probe address, target address or provider free text reaches the dataset', () => {
  const text = JSON.stringify(makeDataset()), cfg = loadConfig();
  assert.equal(scanLeaks(JSON.parse(text)).length, 0);
  for (const bad of ['192.0.2.', '198.51.100.', ...cfg.nodes.map((n) => n.target_ip), 'src_addr', 'fqdn']) assert.ok(!text.includes(bad), bad);
});

// ---- curation: 90 directed observations to 45 pairs ----
test('curate: 90 directed observations become 45 pairs, every kept pair is a real directed observation', () => {
  const { dataset, home } = makeModel(); assert.equal(home.pairs.length, 45); assert.equal(home.gaps.length, 0); valid(home, { dataset });
  for (const p of home.pairs) assert.ok(find(dataset, `ping:${p.src}>${p.dst}`));
});
test('curate: keeps the freshest direction (not an average, not mirrored)', () => {
  const { dataset, home } = makeModel({ perNode: { fra: { age: 100 }, ash: { age: 900 } } });
  const p = home.pairs.find((x) => [x.src, x.dst].sort().join() === 'ash,fra'); assert.equal(`${p.src}>${p.dst}`, 'ash>fra');   // the observation whose destination is fra is the fresher one
  valid(home, { dataset });
});
test('curate: equal times are resolved to the smaller observation id, deterministically', () => {
  const ds = makeDataset(), a = find(ds, 'ping:ash>fra'), b = find(ds, 'ping:fra>ash'); b.observed.last = a.observed.last; b.observed.first = a.observed.first;
  const p = curateHome(ds).pairs.find((x) => [x.src, x.dst].sort().join() === 'ash,fra'); assert.equal(`${p.src}>${p.dst}`, 'ash>fra');
  assert.deepEqual(curateHome(ds), curateHome(clone(ds)));
});
test('curate: missing-data semantics. reverse is reported, and pairs with no data in either direction are listed as gaps', () => {
  const others = loadConfig().nodes.map((n) => n.id).filter((x) => x !== 'syd');
  const both = makeModel({ q: { missing: ['syd'] }, perNode: { syd: { missing: others } } });   // syd neither sends nor receives
  assert.equal(both.home.gaps.length, 9); assert.deepEqual(both.home.gaps[0], { a: 'ash', b: 'syd' }); assert.equal(both.home.pairs.length, 36); assert.equal(both.home.coverage.pairs_missing, 9); valid(both.home, { dataset: both.dataset });
  const one = makeModel({ q: { missing: ['syd'] } }), q = one.home.pairs.find((x) => x.src === 'ash' && x.dst === 'syd'); assert.equal(q.reverse, 'missing'); assert.equal(one.home.gaps.length, 0); valid(one.home, { dataset: one.dataset });
});
test('curate: provenance, raw timestamps and quality survive the reduction', () => {
  const { dataset, home } = makeModel({ q: { loss: { fra: 2 } } }), p = home.pairs.find((x) => x.src === 'fra' && x.dst === 'ash') || home.pairs.find((x) => x.src === 'ash' && x.dst === 'fra'), o = find(dataset, `ping:${p.src}>${p.dst}`);
  assert.equal(p.observed_first, o.observed.first); assert.equal(p.observed, o.observed.last); assert.equal(p.measurement_id, o.source.measurement_id); assert.equal(p.probe_id, o.source.probe_id); assert.deepEqual(p.flags, o.quality.flags);
});
test('curate: the dataset is not mutated', () => { const ds = makeDataset(), copy = clone(ds); curateHome(ds); assert.deepEqual(ds, copy); });
