// Adapter: RIPE Atlas public anchoring-mesh ping measurements -> normalized dataset (contract v1).
//   plan()       the fixed list of API requests (one /latest/ call per target node, 10 for ten nodes)
//   fetchRaw()   runs the plan through the guarded client
//   normalize()  raw responses -> dataset. Copies only whitelisted numbers; strings come from config, never from the provider.
// Guards (each counted in coverage.dropped): rows with the wrong destination, future timestamps, rows older than 6 h,
// inconsistent packet counts, implausible RTT, RTT below the speed-of-light-in-fibre bound. Self pairs are never produced.
import { hav } from '../contract.mjs';

export const PROVIDER = { id: 'ripe-atlas', name: 'RIPE Atlas', operator: 'RIPE NCC', url: 'https://atlas.ripe.net/', terms_url: 'https://www.ripe.net/about-us/legal/ripe-atlas-service-terms-and-conditions/', attribution: 'Measurements by RIPE Atlas, a service of the RIPE NCC.' };
export const POLICY = { maxAgeS: 6 * 3600, futureSlackS: 120, windowResults: 10, packets: 3, agedS: 900, fewResults: 5, minRtt: 0.05, maxRtt: 2000, fibreSlack: 0.95, clockUnsyncedS: 3600 };
export const API_BASE = 'https://atlas.ripe.net/api/v2';

export function plan(config, apiBase = API_BASE) {
  return config.nodes.map((dst) => ({
    node: dst.id,
    url: `${apiBase}/measurements/${dst.measurement_id}/latest/?probe_ids=${config.nodes.filter((s) => s.id !== dst.id).map((s) => s.probe_id).join(',')}&versions=${POLICY.windowResults}&lookback_days=1`
  }));
}

export async function fetchRaw(config, client, { apiBase = API_BASE, pacingMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const out = new Map(); let first = true;
  for (const step of plan(config, apiBase)) { if (!first && pacingMs) await sleep(pacingMs); first = false; out.set(step.node, await client.getJson(step.url)); }
  return out;
}

const isoZ = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const r1 = (x) => Math.round(x * 10) / 10;
const median = (v) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// The docs say /latest/ is keyed by probe id; the live API returned an array. Accept both, ignore anything that is not an object.
const rowsOf = (resp) => (Array.isArray(resp) ? resp : resp && typeof resp === 'object' ? Object.values(resp).flat() : []).filter((r) => r && typeof r === 'object');

export function normalize(rawByNode, config, { generatedAt, fetchedAt, collectorVersion = '0.0.0-gate2a', permissionStatus = 'pending' }) {
  const nodes = config.nodes, dropped = {}, bump = (k) => { dropped[k] = (dropped[k] || 0) + 1; }, observations = [];
  for (const dst of nodes) {
    const list = rowsOf(rawByNode.get(dst.id));
    for (const src of nodes) {
      if (src.id === dst.id) continue;
      const rows = list.filter((r) => r.prb_id === src.probe_id).sort((a, b) => b.timestamp - a.timestamp).slice(0, POLICY.windowResults), good = [];
      for (const r of rows) {
        if (r.dst_addr !== dst.target_ip || r.msm_id !== dst.measurement_id) { bump('wrong_destination'); continue; }
        if (!Number.isInteger(r.timestamp)) { bump('bad_counts'); continue; }
        if (r.timestamp > generatedAt + POLICY.futureSlackS) { bump('future_timestamp'); continue; }
        if (generatedAt - r.timestamp > POLICY.maxAgeS) { bump('stale_rows'); continue; }
        if (!(Number.isInteger(r.sent) && Number.isInteger(r.rcvd) && r.sent >= 1 && r.rcvd >= 0 && r.rcvd <= r.sent)) { bump('bad_counts'); continue; }
        if (r.rcvd > 0 && !(r.min >= POLICY.minRtt && r.max <= POLICY.maxRtt && r.min <= r.avg && r.avg <= r.max)) { bump('implausible_rtt'); continue; }
        good.push(r);
      }
      if (!good.length) { bump('no_fresh_result'); continue; }
      const sent = good.reduce((x, r) => x + r.sent, 0), rcvd = good.reduce((x, r) => x + r.rcvd, 0), withRtt = good.filter((r) => r.rcvd > 0);
      const ts = good.map((r) => r.timestamp), first = Math.min(...ts), last = Math.max(...ts);
      let rtt = null;
      if (withRtt.length) {
        const best = Math.min(...withRtt.map((r) => r.min)), floor = hav(src, dst) / 100;
        if (best < floor * POLICY.fibreSlack) { bump('below_fibre_bound'); continue; }
        rtt = { min: r1(best), median: r1(median(withRtt.map((r) => r.avg))), last: r1([...withRtt].sort((a, b) => b.timestamp - a.timestamp)[0].avg) };
      }
      const flags = []; if (good.length < POLICY.fewResults) flags.push('few_results'); if (generatedAt - last > POLICY.agedS) flags.push('aged');
      if (good.some((r) => r.lts < 0 || r.lts > POLICY.clockUnsyncedS)) flags.push('clock_unsynced'); if (sent > rcvd) flags.push('loss_observed');
      const n = flags.filter((f) => f !== 'loss_observed').length, level = good.length >= 3 && n === 0 ? 'good' : good.length >= 3 && n === 1 ? 'degraded' : 'poor';
      observations.push({ id: `ping:${src.id}>${dst.id}`, type: 'ping', src: src.id, dst: dst.id, observed: { first: isoZ(first), last: isoZ(last) }, results: good.length, rtt_ms: rtt,
        loss: { sent, rcvd, pct: r1(100 * (sent - rcvd) / sent) }, quality: { level, flags }, source: { measurement_id: dst.measurement_id, probe_id: src.probe_id } });
    }
  }
  observations.sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: 'lateeflaw.internet-dataset', schema_version: '1.0', dataset_id: config.dataset_id, generated_at: isoZ(generatedAt),
    provenance: { provider: PROVIDER, method: { kind: 'ping', protocol: 'ICMP', af: 4, interval_s: 240, packets_per_result: POLICY.packets, window_results_max: POLICY.windowResults, selection: 'Curated RIPE Atlas anchors in data centres, public anchoring-mesh ping measurements', api: API_BASE + '/' },
      fetched_at: fetchedAt, collector: { version: collectorVersion }, publication: { permission_status: permissionStatus } },
    endpoints: nodes.map((n) => ({ id: n.id, kind: 'anchor', label: n.label, country: n.country, geo: { lat: n.lat, lon: n.lon, precision_km: 1 }, refs: { anchor_id: n.anchor_id, probe_id: n.probe_id } })).sort((a, b) => a.id.localeCompare(b.id)),
    observations,
    coverage: { endpoints: nodes.length, expected: nodes.length * (nodes.length - 1), published: observations.length, dropped },
    notes: ['All endpoints are RIPE Atlas anchors in data centres. Coordinates are rounded to 0.01 degree, about 1 km.', 'Observations are measured ping results between two endpoints. They are not traceroutes and carry no route information.']
  };
}
