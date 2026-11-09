// Contract conformance: valid documents pass; every mutant (a deliberately broken copy) must be rejected with the expected message.
import test from 'node:test'; import assert from 'node:assert/strict';
import { validateDocument, scanLeaks } from '../src/contract.mjs';
import { controlDocument } from '../src/curate.mjs';
import { SCHEMA, clone, makeModel, subsetConfig } from './helpers/model.mjs';

const cfg3 = subsetConfig(['ash', 'fra', 'jnb']);
const base = (o = {}) => { const m = makeModel({ config: cfg3, ...o }); return { ds: clone(m.dataset), hv: clone(m.home) }; };
const ctl = () => controlDocument({ enabled: true, surfaces: { home: true, dashboard: true } }, '2026-11-09T00:50:27Z');
const ok = (doc, o = {}) => validateDocument(SCHEMA, doc, { strict: true, ...o });

test('valid: full ten-node model passes strict and tolerant validation, home view conforms to its dataset', () => {
  const { dataset, home } = makeModel();
  assert.deepEqual(ok(dataset), []); assert.deepEqual(validateDocument(SCHEMA, dataset, { strict: false }), []);
  assert.deepEqual(ok(home, { dataset }), []); assert.equal(home.pairs.length, 45); assert.equal(home.coverage.directed_available, 90);
});
test('valid: 3-node example is self-consistent (every pair references a node in the document)', () => {
  const { ds, hv } = base(); const ids = new Set(ds.endpoints.map((e) => e.id));
  assert.equal(ds.observations.length, 6); assert.ok(ds.observations.every((o) => ids.has(o.src) && ids.has(o.dst)));
  assert.ok(hv.pairs.every((p) => hv.nodes.some((n) => n.id === p.src) && hv.nodes.some((n) => n.id === p.dst)));
  assert.deepEqual(ok(ds), []); assert.deepEqual(ok(hv, { dataset: ds }), []); assert.deepEqual(ok(ctl()), []);
});

const first = (d) => d.observations[0];
const M = [  // [name, which, mutate, expected message]
  ['old-example defect: observation references a node that is not in the document', 'ds', (d) => { first(d).dst = 'dxb'; first(d).id = `ping:${first(d).src}>dxb`; }, "unknown endpoint dst 'dxb'"],
  ['self pair', 'ds', (d) => { first(d).dst = first(d).src; first(d).id = `ping:${first(d).src}>${first(d).src}`; }, 'src equals dst'],
  ['duplicate observation id', 'ds', (d) => { d.observations.push(clone(first(d))); d.coverage.published++; }, 'duplicate id'],
  ['received more than sent', 'ds', (d) => { first(d).loss.rcvd = first(d).loss.sent + 1; }, 'rcvd exceeds sent'],
  ['loss percentage does not match counts', 'ds', (d) => { first(d).loss.pct = 12.5; }, 'loss.pct does not match'],
  ['rtt min above median', 'ds', (d) => { first(d).rtt_ms.min = first(d).rtt_ms.median + 5; }, 'min exceeds median'],
  ['observed.first after observed.last', 'ds', (d) => { const o = first(d); [o.observed.first, o.observed.last] = [o.observed.last, o.observed.first]; }, 'first is after observed.last'],
  ['observation newer than generated_at', 'ds', (d) => { first(d).observed.last = '2030-01-01T00:00:00Z'; }, 'after generated_at'],
  ['coverage.published wrong', 'ds', (d) => { d.coverage.published = 5; }, 'coverage.published'],
  ['leaked probe address field (strict rejects unknown fields)', 'ds', (d) => { first(d).src_addr = '192.0.2.7'; }, 'unknown field'],
  ['IPv4 literal hidden in a note', 'ds', (d) => { d.notes[0] = 'probe at 192.0.2.44 answered'; }, 'IP address literal'],
  ['IPv6 literal hidden in a note', 'ds', (d) => { d.notes[0] = 'from 2001:db8::1 was slow'; }, 'IP address literal'],
  ['markup in an endpoint label', 'ds', (d) => { d.endpoints[0].label = '<img src=x>'; }, 'does not match'],
  ['non-https provider URL', 'ds', (d) => { d.provenance.provider.url = 'http://atlas.ripe.net/'; }, 'does not match'],
  ['unsupported major version', 'ds', (d) => { d.schema_version = '2.0'; }, 'does not match'],
  ['timestamp with a UTC offset', 'ds', (d) => { d.generated_at = '2026-11-09T00:50:27+01:00'; }, 'does not match'],
  ['aged flag inconsistent with observation age', 'ds', (d) => { first(d).quality.flags.push('aged'); }, 'aged flag inconsistent'],
  ['quality level inconsistent with flags', 'ds', (d) => { first(d).quality.level = 'poor'; }, "should be 'good'"],
  ['RTT faster than light in fibre', 'ds', (d) => { d.observations.find((o) => o.id === 'ping:fra>ash').rtt_ms.min = 5; }, 'below the speed-of-light'],
  ['rtt null although packets were received', 'ds', (d) => { first(d).rtt_ms = null; }, 'rtt_ms must be null exactly when rcvd is 0'],
  ['unknown top-level field (strict rejects, tolerant ignores)', 'ds', (d) => { d.extra = 1; }, 'unknown field'],
  ['home: both directions of one pair', 'hv', (h) => { const p = clone(h.pairs[0]); h.pairs.push({ ...p, src: p.dst, dst: p.src }); h.coverage.pairs_published++; }, 'one per unordered pair'],
  ['home: value differs from the dataset', 'hv', (h) => { h.pairs[0].rtt_median += 1; }, 'values differ from the dataset'],
  ['home: pair references a node not in the view', 'hv', (h) => { h.pairs[0].dst = 'dxb'; }, "unknown endpoint dst 'dxb'"],
  ['home: freshness block inconsistent with its pairs', 'hv', (h) => { h.freshness.newest_observation = '2030-01-01T00:00:00Z'; }, 'freshness.newest_observation'],
  ['home: direction not present in the dataset (a mirrored pair; jnb has no outgoing data)', 'hv', (h) => { const p = h.pairs.find((x) => x.dst === 'jnb'); [p.src, p.dst] = [p.dst, p.src]; }, 'direction must be preserved', { q: { missing: ['jnb'] } }],
  ['home: reverse flag wrong', 'hv', (h) => { h.pairs[0].reverse = 'missing'; }, "reverse should be 'present'"],
  ['home: coverage.pairs_missing wrong', 'hv', (h) => { h.coverage.pairs_missing = 2; }, 'pairs_missing'],
  ['home: coverage.directed_available wrong', 'hv', (h) => { h.coverage.directed_available = 5; }, 'directed_available'],
  ['home: observed_first after observed', 'hv', (h) => { h.pairs[0].observed_first = '2030-01-01T00:00:00Z'; }, 'observed_first is after observed'],
  ['home: loss flag inconsistent', 'hv', (h) => { h.pairs[0].flags = ['loss_observed']; }, 'loss_observed flag inconsistent'],
  ['home: provenance probe_id dropped', 'hv', (h) => { delete h.pairs[0].probe_id; }, '/probe_id: required'],
  ['home: gap that the dataset can fill', 'hv', (h) => { const p = h.pairs.pop(); h.gaps.push({ a: [p.src, p.dst].sort()[0], b: [p.src, p.dst].sort()[1] }); h.coverage.pairs_published--; h.coverage.pairs_missing++; h.freshness = { newest_observation: h.pairs.map((x) => x.observed).sort().pop(), oldest_observation: h.pairs.map((x) => x.observed).sort()[0] }; }, 'the dataset has an observation for it'],
  ['home: freshest direction not chosen', 'hv', (h, d) => { const p = h.pairs[0], r = d.observations.find((o) => o.src === p.dst && o.dst === p.src); r.observed.last = '2026-11-09T00:55:00Z'; d.generated_at = '2026-11-09T01:00:00Z'; r.observed.first = '2026-11-09T00:20:00Z'; }, 'must keep the freshest direction'],
  ['control: enabled missing', 'ct', (c) => { delete c.enabled; }, '/enabled: required'],
  ['control: disabled but a surface still on', 'ct', (c) => { c.enabled = false; }, 'a surface is still true'],
  ['unknown document type', 'ct', (c) => { c.schema = 'lateeflaw.something-else'; }, "unknown or missing 'schema'"]
];
for (const [name, which, mut, want, mo] of M) {
  test(`mutant rejected: ${name}`, () => {
    const { ds, hv } = base(mo), doc = which === 'ds' ? ds : which === 'hv' ? hv : ctl();
    mut(doc, ds);
    const errs = ok(doc, which === 'hv' ? { dataset: ds } : {});
    assert.ok(errs.some((e) => e.includes(want)), `expected an error containing ${JSON.stringify(want)}, got ${JSON.stringify(errs.slice(0, 3))}`);
  });
}
test('more than 32 endpoints is rejected', () => {
  const { ds } = base(); while (ds.endpoints.length < 33) ds.endpoints.push({ ...clone(ds.endpoints[0]), id: 'x' + ds.endpoints.length });
  assert.ok(ok(ds).some((e) => e.includes('more than 32')));
});
test('forward compatibility: strict rejects unknown fields and observation types, tolerant accepts after skipping the unknown type', () => {
  const { ds } = base(); ds.extra = { f: 1 }; ds.observations.push({ id: 'bgp:x', type: 'bgp.updates', src: 'fra', dst: 'ash' });
  assert.ok(ok(ds).length > 0);
  const t = clone(ds); t.observations = t.observations.filter((o) => o.type === 'ping'); assert.deepEqual(validateDocument(SCHEMA, t, { strict: false }), []);
});
test('leak scan: IP literals are found, timestamps and versions are not', () => {
  const yes = ['probe 192.0.2.44 slow', '2001:db8::1', '2001:0db8:0000:0000:0000:ff00:0042:8329', '::1', 'build 198.51.100.99'], no = ['2026-11-09T00:50:27Z', '0.0.0-gate1', '12:34:56', '1.0'];
  for (const s of yes) assert.ok(scanLeaks(s).length > 0, s); for (const s of no) assert.equal(scanLeaks(s).length, 0, s);
});
