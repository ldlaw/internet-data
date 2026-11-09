// Contract validation for contracts/internet-model.v1.schema.json. No dependencies.
//   validateSchema   a small JSON Schema subset (type, const, enum, pattern, min/max, items, required, properties, additionalProperties, local $ref)
//   semantic         rules JSON Schema cannot express: referential integrity, arithmetic, ordering, physical bound, view-to-dataset consistency
//   validateDocument both, selecting the definition from the document's own 'schema' field
// Strict mode (collector CI): unknown fields are errors. Tolerant mode (consumers): unknown fields are ignored.
import fs from 'node:fs';

const D2R = Math.PI / 180;
export const hav = (a, b) => { const R = 6371, dLa = (b.lat - a.lat) * D2R, dLo = (b.lon - a.lon) * D2R, h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
export const iso = (t) => Date.parse(t) / 1000;
export const loadSchema = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function validateSchema(root, schema, data, { strict = true } = {}) {
  const errors = [];
  const resolve = (ref) => { if (!ref.startsWith('#/')) throw new Error('only local $ref supported: ' + ref); return ref.slice(2).split('/').reduce((o, k) => o[k], root); };
  const isType = (v, t) => t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : t === 'null' ? v === null : t === 'array' ? Array.isArray(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === t;
  const kind = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  (function walk(s, v, p) {
    if (s.$ref) return walk(resolve(s.$ref), v, p);
    if (s.type) { const ts = [].concat(s.type); if (!ts.some((t) => isType(v, t))) { errors.push(`${p || '/'}: expected ${ts.join('|')}, got ${kind(v)}`); return; } }
    if ('const' in s && v !== s.const) errors.push(`${p || '/'}: must equal ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some((e) => e === v)) errors.push(`${p || '/'}: ${JSON.stringify(v)} not in [${s.enum.join(', ')}]`);
    if (typeof v === 'string') {
      if (s.minLength != null && v.length < s.minLength) errors.push(`${p}: shorter than ${s.minLength}`);
      if (s.maxLength != null && v.length > s.maxLength) errors.push(`${p}: longer than ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern).test(v)) errors.push(`${p}: ${JSON.stringify(v.slice(0, 40))} does not match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (s.minimum != null && v < s.minimum) errors.push(`${p}: ${v} below minimum ${s.minimum}`);
      if (s.maximum != null && v > s.maximum) errors.push(`${p}: ${v} above maximum ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems != null && v.length < s.minItems) errors.push(`${p}: fewer than ${s.minItems} items`);
      if (s.maxItems != null && v.length > s.maxItems) errors.push(`${p}: more than ${s.maxItems} items`);
      if (s.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length) errors.push(`${p}: items not unique`);
      if (s.items) v.forEach((x, i) => walk(s.items, x, `${p}/${i}`));
    } else if (v !== null && typeof v === 'object') {
      for (const k of s.required || []) if (!(k in v)) errors.push(`${p}/${k}: required`);
      for (const k of Object.keys(v)) {
        if (s.properties && k in s.properties) walk(s.properties[k], v[k], `${p}/${k}`);
        else if (strict && s.additionalProperties === false) errors.push(`${p}/${k}: unknown field (strict mode rejects it)`);
      }
    }
  })(schema, data, '');
  return errors;
}

// privacy control: no IPv4 or IPv6 literal may appear in any string of a published document
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/;
const IPV6 = /(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4})?|::(?:[0-9a-f]{1,4}:?){1,7}/i;   // full 8 groups, or any '::' form; a hh:mm:ss time never matches
export function scanLeaks(v, p = '') {
  const e = [];
  if (typeof v === 'string') { if (IPV4.test(v) || IPV6.test(v)) e.push(`${p || '/'}: contains an IP address literal`); }
  else if (Array.isArray(v)) v.forEach((x, i) => e.push(...scanLeaks(x, `${p}/${i}`)));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) e.push(...scanLeaks(v[k], `${p}/${k}`));
  return e;
}

// Simulated data is marked in five independent places that must agree: provenance.simulated, permission_status 'synthetic', provider id 'fixture',
// a dataset id starting 'synthetic-', and identifiers in a reserved range (above 4,000,000,000) that no real RIPE Atlas id has reached. The rules
// below make every combination other than "all five say synthetic" or "all five say real" a validation error, in the dataset and in the home view.
export const SYNTHETIC_ID_BASE = 4000000000;
const syntheticRules = (e, { simulated, datasetId, ids, urls, texts }) => {
  if (simulated) {
    if (!datasetId.startsWith('synthetic-')) e.push(`dataset_id '${datasetId}' must start with 'synthetic-' for simulated data`);
    for (const [k, v] of Object.entries(texts)) if (!/simulated|synthetic/i.test(v)) e.push(`${k} must say that the data is simulated`);
    for (const [k, v] of Object.entries(urls)) if (/ripe\.net/i.test(v)) e.push(`${k} must not point at RIPE for simulated data`);
    ids.forEach(([k, v]) => { if (!(v > SYNTHETIC_ID_BASE)) e.push(`${k} ${v} must be above ${SYNTHETIC_ID_BASE} (the reserved synthetic range)`); });
  } else {
    if (datasetId.startsWith('synthetic-')) e.push(`dataset_id '${datasetId}' uses the reserved 'synthetic-' prefix but the data is not marked simulated`);
    ids.forEach(([k, v]) => { if (v > SYNTHETIC_ID_BASE) e.push(`${k} ${v} is in the reserved synthetic range but the data is not marked simulated`); });
  }
};
const qualityLevel = (flags, results) => { const n = ['few_results', 'aged', 'clock_unsynced'].filter((x) => flags.has(x)).length; return results >= 3 && n === 0 ? 'good' : results >= 3 && n === 1 ? 'degraded' : 'poor'; };
const ukey = (a, b) => [a, b].sort().join('|');

export function semantic(doc, ctx = {}) {
  const e = [...scanLeaks(doc)];
  const t = doc.schema;
  if (t === 'lateeflaw.internet-dataset') {
    const by = new Map(doc.endpoints.map((x) => [x.id, x]));
    if (by.size !== doc.endpoints.length) e.push('endpoints: duplicate id');
    const gen = iso(doc.generated_at), obsIds = new Set();
    if (iso(doc.provenance.fetched_at) > gen) e.push('provenance.fetched_at is after generated_at');
    const pv = doc.provenance, sim = pv.simulated === true;
    if (sim !== (pv.publication.permission_status === 'synthetic')) e.push("provenance.simulated must be true exactly when permission_status is 'synthetic'");
    if (sim !== (pv.provider.id === 'fixture')) e.push("provenance.simulated must be true exactly when the provider id is 'fixture'");
    syntheticRules(e, { simulated: sim, datasetId: doc.dataset_id,
      texts: { 'provider.name': pv.provider.name, 'provider.attribution': pv.provider.attribution, 'notes[0]': doc.notes[0] || '', 'method.selection': pv.method.selection },
      urls: { 'provider.url': pv.provider.url, 'provider.terms_url': pv.provider.terms_url, 'method.api': pv.method.api },
      ids: [...doc.endpoints.flatMap((x) => [[`endpoint ${x.id} anchor_id`, x.refs.anchor_id], [`endpoint ${x.id} probe_id`, x.refs.probe_id]]), ...doc.observations.flatMap((o) => [[`observation ${o.id} measurement_id`, o.source.measurement_id], [`observation ${o.id} probe_id`, o.source.probe_id]])] });
    if (sim && !/^SIMULATED/.test(doc.notes[0] || '')) e.push("notes[0] must begin with 'SIMULATED' for simulated data");
    for (const o of doc.observations) {
      const at = `observation ${o.id}`;
      if (obsIds.has(o.id)) e.push(`${at}: duplicate id`); obsIds.add(o.id);
      if (o.id !== `ping:${o.src}>${o.dst}`) e.push(`${at}: id does not match src and dst`);
      if (o.src === o.dst) e.push(`${at}: src equals dst`);
      const s = by.get(o.src), d = by.get(o.dst);
      if (!s) e.push(`${at}: unknown endpoint src '${o.src}'`); if (!d) e.push(`${at}: unknown endpoint dst '${o.dst}'`);
      if (iso(o.observed.first) > iso(o.observed.last)) e.push(`${at}: observed.first is after observed.last`);
      if (iso(o.observed.last) > gen) e.push(`${at}: observed.last is after generated_at`);
      const { sent, rcvd, pct } = o.loss;
      if (rcvd > sent) e.push(`${at}: rcvd exceeds sent`);
      if (sent > o.results * doc.provenance.method.packets_per_result) e.push(`${at}: sent exceeds results x packets_per_result`);
      if (Math.abs(pct - Math.round(1000 * (sent - rcvd) / sent) / 10) > 0.05) e.push(`${at}: loss.pct does not match sent and rcvd`);
      if ((rcvd === 0) !== (o.rtt_ms === null)) e.push(`${at}: rtt_ms must be null exactly when rcvd is 0`);
      if (o.rtt_ms) {
        if (o.rtt_ms.min > o.rtt_ms.median) e.push(`${at}: rtt min exceeds median`);
        if (o.rtt_ms.min > o.rtt_ms.last) e.push(`${at}: rtt min exceeds last`);
        if (s && d) { const floor = hav(s.geo, d.geo) / 100; if (o.rtt_ms.min < 0.95 * floor) e.push(`${at}: min RTT ${o.rtt_ms.min} ms is below the speed-of-light-in-fibre bound ${floor.toFixed(1)} ms`); }
      }
      const f = new Set(o.quality.flags);
      if ((o.results < 5) !== f.has('few_results')) e.push(`${at}: few_results flag inconsistent with results`);
      if ((gen - iso(o.observed.last) > 900) !== f.has('aged')) e.push(`${at}: aged flag inconsistent with observation age`);
      if ((pct > 0) !== f.has('loss_observed')) e.push(`${at}: loss_observed flag inconsistent with loss.pct`);
      if (o.quality.level !== qualityLevel(f, o.results)) e.push(`${at}: quality.level '${o.quality.level}' should be '${qualityLevel(f, o.results)}'`);
    }
    const n = doc.endpoints.length;
    if (doc.coverage.endpoints !== n) e.push('coverage.endpoints does not match endpoints length');
    if (doc.coverage.expected !== n * (n - 1)) e.push('coverage.expected must be n x (n-1)');
    if (doc.coverage.published !== doc.observations.length) e.push('coverage.published does not match observations length');
  } else if (t === 'lateeflaw.home-view') {
    const by = new Map(doc.nodes.map((x) => [x.id, x]));
    if (by.size !== doc.nodes.length) e.push('nodes: duplicate id');
    const seen = new Set(); let newest = '', oldest = '9';
    const at0 = doc.attribution, simV = at0.simulated === true;
    syntheticRules(e, { simulated: simV, datasetId: doc.dataset_id, texts: { 'attribution.text': at0.text, 'attribution.disclaimer': at0.disclaimer }, urls: { 'attribution.url': at0.url, 'attribution.terms_url': at0.terms_url },
      ids: doc.pairs.flatMap((p) => [[`pair ${p.src}>${p.dst} measurement_id`, p.measurement_id], [`pair ${p.src}>${p.dst} probe_id`, p.probe_id]]) });
    if (simV && !/^SIMULATED/.test(at0.text)) e.push("attribution.text must begin with 'SIMULATED' for simulated data");
    if (ctx.dataset && simV !== (ctx.dataset.provenance.simulated === true)) e.push('attribution.simulated differs from the dataset provenance.simulated');
    for (const p of doc.pairs) {
      const at = `pair ${p.src}>${p.dst}`;
      if (p.src === p.dst) e.push(`${at}: src equals dst`);
      if (!by.has(p.src)) e.push(`${at}: unknown endpoint src '${p.src}'`); if (!by.has(p.dst)) e.push(`${at}: unknown endpoint dst '${p.dst}'`);
      const u = ukey(p.src, p.dst); if (seen.has(u)) e.push(`${at}: both directions or a duplicate present, the home view keeps one per unordered pair`); seen.add(u);
      if (p.observed > newest) newest = p.observed; if (p.observed < oldest) oldest = p.observed;
      if (iso(p.observed_first) > iso(p.observed)) e.push(`${at}: observed_first is after observed`);
      if (iso(p.observed) > iso(doc.generated_at)) e.push(`${at}: observed is after generated_at`);
      if ((p.rtt_median === null) !== (p.rtt_min === null)) e.push(`${at}: rtt_median and rtt_min must both be null or both set`);
      if (p.rtt_median !== null && p.rtt_min > p.rtt_median) e.push(`${at}: rtt_min exceeds rtt_median`);
      if (p.rtt_median !== null) { const s = by.get(p.src), d = by.get(p.dst); if (s && d) { const floor = hav(s, d) / 100; if (p.rtt_min < 0.95 * floor) e.push(`${at}: rtt_min ${p.rtt_min} ms is below the fibre bound ${floor.toFixed(1)} ms`); } }
      if ((p.loss_pct > 0) !== p.flags.includes('loss_observed')) e.push(`${at}: loss_observed flag inconsistent with loss_pct`);
    }
    if (doc.pairs.length) { if (doc.freshness.newest_observation !== newest) e.push('freshness.newest_observation does not match the pairs'); if (doc.freshness.oldest_observation !== oldest) e.push('freshness.oldest_observation does not match the pairs'); }
    const gapKeys = new Set();
    for (const g of doc.gaps) {
      if (!by.has(g.a) || !by.has(g.b)) e.push(`gap ${g.a}|${g.b}: unknown node`);
      if (!(g.a < g.b)) e.push(`gap ${g.a}|${g.b}: ids must be sorted with a before b`);
      const k = ukey(g.a, g.b); if (gapKeys.has(k)) e.push(`gap ${k}: duplicate`); gapKeys.add(k);
      if (seen.has(k)) e.push(`gap ${k}: also present as a pair`);
    }
    const n = doc.nodes.length, c = doc.coverage;
    if (c.pairs_published !== doc.pairs.length) e.push('coverage.pairs_published does not match pairs length');
    if (c.pairs_missing !== doc.gaps.length) e.push('coverage.pairs_missing does not match gaps length');
    if (c.pairs_expected !== n * (n - 1) / 2) e.push('coverage.pairs_expected must be n x (n-1) / 2');
    if (c.pairs_published + c.pairs_missing !== c.pairs_expected) e.push('coverage: published plus missing must equal expected');
    if (c.directed_expected !== n * (n - 1)) e.push('coverage.directed_expected must be n x (n-1)');
    if (ctx.dataset) {   // conformance: the curated view must be a faithful, direction-preserving reduction of the dataset
      const ds = ctx.dataset, dn = new Map(ds.endpoints.map((x) => [x.id, x])), find = (s, d) => ds.observations.find((q) => q.src === s && q.dst === d);
      if (doc.dataset_id !== ds.dataset_id) e.push('dataset_id differs from the dataset');
      if (doc.nodes.length !== ds.endpoints.length) e.push('nodes must list every dataset endpoint');
      for (const nd of doc.nodes) { const x = dn.get(nd.id); if (!x || x.label !== nd.label || x.country !== nd.country || x.geo.lat !== nd.lat || x.geo.lon !== nd.lon) e.push(`node ${nd.id}: differs from the dataset endpoint`); }
      if (c.directed_available !== ds.observations.length) e.push('coverage.directed_available does not match the dataset');
      for (const p of doc.pairs) {
        const o = find(p.src, p.dst), r = find(p.dst, p.src);
        if (!o) { e.push(`pair ${p.src}>${p.dst}: no such observation in the dataset (direction must be preserved)`); continue; }
        const same = (o.rtt_ms ? o.rtt_ms.median : null) === p.rtt_median && (o.rtt_ms ? o.rtt_ms.min : null) === p.rtt_min && o.loss.pct === p.loss_pct && o.loss.sent === p.sent && o.observed.last === p.observed && o.observed.first === p.observed_first
          && o.quality.level === p.quality && JSON.stringify(o.quality.flags) === JSON.stringify(p.flags) && o.source.measurement_id === p.measurement_id && o.source.probe_id === p.probe_id;
        if (!same) e.push(`pair ${p.src}>${p.dst}: values differ from the dataset observation`);
        if ((r ? 'present' : 'missing') !== p.reverse) e.push(`pair ${p.src}>${p.dst}: reverse should be '${r ? 'present' : 'missing'}'`);
        if (r && (r.observed.last > o.observed.last || (r.observed.last === o.observed.last && r.id < o.id))) e.push(`pair ${p.src}>${p.dst}: the reverse direction is fresher, the view must keep the freshest direction`);
      }
      for (const g of doc.gaps) if (find(g.a, g.b) || find(g.b, g.a)) e.push(`gap ${g.a}|${g.b}: the dataset has an observation for it`);
    }
  } else if (t === 'lateeflaw.internet-control') {
    if (!doc.enabled && (doc.surfaces.home || doc.surfaces.dashboard)) e.push('enabled is false but a surface is still true');
  }
  return e;
}

export function validateDocument(schemaRoot, doc, opts = {}) {
  const def = schemaRoot['x-documents'][doc && doc.schema];
  if (!def) return [`unknown or missing 'schema' field: ${JSON.stringify(doc && doc.schema)}`];
  const errs = validateSchema(schemaRoot, { $ref: '#/$defs/' + def }, doc, { strict: opts.strict !== false });
  return errs.length ? errs : semantic(doc, opts);
}
