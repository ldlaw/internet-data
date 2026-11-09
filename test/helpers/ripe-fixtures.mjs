// SYNTHETIC RIPE Atlas-shaped responses for tests. No real measurement data is stored in this repository: values come from a seeded model,
// the field names, shapes and quirks (array instead of keyed object, stale 2021 rows, self rows) come from observing the real API.
// Probe-side addresses use the documentation ranges (RFC 5737) so tests can assert that no address ever reaches a published document.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { hav } from '../../src/contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const loadConfig = () => JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'config', 'nodes.json'), 'utf8'));
export const NOW = Date.parse('2026-11-09T00:50:27Z') / 1000;

const prng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export function row(src, dst, ts, rtt, { sent = 3, rcvd = 3, lts = 90, dstAddr = dst.target_ip, prb = src.probe_id, msm = dst.measurement_id } = {}) {
  const rs = Array.from({ length: sent }, (_, i) => (i < rcvd ? { rtt: +(rtt + i * 0.07).toFixed(3) } : { x: '*' }));
  const ok = rs.filter((r) => 'rtt' in r).map((r) => r.rtt);
  const o = { fw: 5130, mver: '2.6.4', lts, dst_name: dstAddr, af: 4, dst_addr: dstAddr, src_addr: '192.0.2.' + (hash(src.id) % 200 + 1), proto: 'ICMP', ttl: 54, size: 64, result: rs, dup: 0, rcvd, sent,
    msm_id: msm, prb_id: prb, timestamp: ts, msm_name: 'Ping', from: '198.51.100.' + (hash(src.id) % 200 + 1), type: 'ping', group_id: msm - 1, step: 240, stored_timestamp: ts + 40 };
  if (ok.length) { o.min = Math.min(...ok); o.max = Math.max(...ok); o.avg = +(ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(6); }
  return o;
}

// q: quirks. { shape: 'array'|'object', stale: [srcId], self: true, wrongDst: [srcId], future: [srcId], impossible: [srcId], fast: [srcId], loss: {srcId: lostPackets}, few: {srcId: n}, lts: {srcId: v}, missing: [srcId], age: seconds, junk: true }
export function latestFor(config, dstId, { now = NOW, q = {} } = {}) {
  const dst = config.nodes.find((n) => n.id === dstId), rows = [], age = q.age ?? 100;
  for (const src of config.nodes) {
    if (src.id === dst.id && !q.self) continue;
    if ((q.missing || []).includes(src.id)) continue;
    const rnd = prng(hash(src.id + dst.id)), base = Math.max(0.4, hav(src, dst) / 100 * (1.25 + rnd() * 0.8));
    if ((q.stale || []).includes(src.id)) { rows.push(row(src, dst, 1619621889, Math.max(0.4, hav(src, dst) / 100 * 1.6), {})); continue; }   // the real API returned only a 2021 row for such a probe
    const n = (q.few || {})[src.id] ?? 10;
    for (let k = 0; k < n; k++) {
      const ts = Math.floor(now - age - k * 240 - rnd() * 40), lost = (q.loss || {})[src.id] && k === 0 ? q.loss[src.id] : 0;
      let rtt = base + (rnd() - 0.5) * 0.6; if ((q.fast || []).includes(src.id)) rtt = 5; if ((q.impossible || []).includes(src.id)) rtt = 5000;
      let r = row(src, dst, ts, rtt, { sent: 3, rcvd: (q.dead || []).includes(src.id) ? 0 : 3 - lost, lts: (q.lts || {})[src.id] ?? 90 });
      if ((q.future || []).includes(src.id) && k === 0) r.timestamp = now + 3600;
      if ((q.wrongDst || []).includes(src.id) && k === 0) r = row(src, dst, ts, rtt, { dstAddr: '203.0.113.9' });
      rows.push(r);
    }
  }
  if (q.junk) rows.push(null, 'x', 7, { prb_id: 1 });
  rows.sort((a, b) => a && b ? 0 : 0);
  if (q.shape === 'object') { const o = {}; for (const r of rows) if (r && r.prb_id) (o[r.prb_id] = o[r.prb_id] || []).push(r); return o; }
  return rows;
}
export const allLatest = (config, opts = {}) => { const m = new Map(); for (const n of config.nodes) m.set(n.id, latestFor(config, n.id, { ...opts, q: { ...(opts.q || {}), ...(opts.perNode && opts.perNode[n.id] || {}) } })); return m; };
