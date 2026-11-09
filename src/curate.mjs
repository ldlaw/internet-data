// Publication layer: dataset -> small curated views. Pure functions, no I/O.
//
// Home view: 90 directed observations are reduced to one entry per unordered pair (45 for ten nodes).
// What is preserved when reducing (and checked by the contract against the dataset):
//   direction     each kept pair is an observation that exists in the dataset exactly as src > dst; it is never mirrored or averaged
//   timestamps    observed_first and observed (the raw first and last result times of that observation)
//   provenance    measurement_id and probe_id of that observation
//   quality       level and flags of that observation
//   missing data  reverse = 'present' | 'missing' for the direction that was not kept; gaps[] lists unordered pairs with no usable
//                 observation in either direction; coverage counts directed and unordered pairs, so nothing disappears silently
// Rule: keep the direction with the most recent last-observation time; ties go to the lexicographically smaller observation id.

const ukey = (a, b) => [a, b].sort().join('|');

export function curateHome(dataset) {
  const by = new Map(dataset.observations.map((o) => [o.id, o]));
  const best = new Map();
  for (const o of dataset.observations) {
    const k = ukey(o.src, o.dst), cur = best.get(k);
    if (!cur || o.observed.last > cur.observed.last || (o.observed.last === cur.observed.last && o.id < cur.id)) best.set(k, o);
  }
  const ids = dataset.endpoints.map((e) => e.id).sort(), gaps = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (!best.has(ukey(ids[i], ids[j]))) gaps.push({ a: ids[i], b: ids[j] });
  const picked = [...best.values()].sort((a, b) => a.id.localeCompare(b.id));
  const lasts = picked.map((o) => o.observed.last).sort(), n = ids.length, p = dataset.provenance.provider, sim = dataset.provenance.simulated === true;
  return {
    schema: 'lateeflaw.home-view', schema_version: '1.0', generated_at: dataset.generated_at, dataset_id: dataset.dataset_id, selection: 'freshest-direction',
    attribution: sim
      ? { text: 'SIMULATED test data. These are not real measurements. They exist to test hosting, caching and the kill switch.', url: p.url, terms_url: p.terms_url, simulated: true, disclaimer: 'Simulated values for a hosting test. Arcs join the endpoints for display only. They are not measurements, traceroutes or routes.' }
      : { text: `Measurements from ${p.name}, a service of the ${p.operator}.`, url: p.url, terms_url: p.terms_url, simulated: false, disclaimer: 'Arcs join the two measured endpoints for display only. They are not traceroutes or verified routes.' },
    freshness: { newest_observation: lasts[lasts.length - 1] || dataset.generated_at, oldest_observation: lasts[0] || dataset.generated_at },
    coverage: { directed_expected: n * (n - 1), directed_available: dataset.observations.length, pairs_expected: n * (n - 1) / 2, pairs_published: picked.length, pairs_missing: gaps.length },
    nodes: dataset.endpoints.map((e) => ({ id: e.id, label: e.label, country: e.country, lat: e.geo.lat, lon: e.geo.lon })),
    pairs: picked.map((o) => ({ src: o.src, dst: o.dst, rtt_median: o.rtt_ms ? o.rtt_ms.median : null, rtt_min: o.rtt_ms ? o.rtt_ms.min : null, loss_pct: o.loss.pct, sent: o.loss.sent,
      observed_first: o.observed.first, observed: o.observed.last, quality: o.quality.level, flags: o.quality.flags, measurement_id: o.source.measurement_id, probe_id: o.source.probe_id,
      reverse: by.has(`ping:${o.dst}>${o.src}`) ? 'present' : 'missing' })),
    gaps
  };
}

export function controlDocument(config, nowIso) {
  const on = config.enabled === true;
  return { schema: 'lateeflaw.internet-control', schema_version: '1.0', updated_at: nowIso, enabled: on, surfaces: { home: on && config.surfaces.home === true, dashboard: on && config.surfaces.dashboard === true }, reason: on ? null : String(config.reason || 'disabled').slice(0, 80) };
}
