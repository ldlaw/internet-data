// A tiny local stand-in for atlas.ripe.net used by the collector tests. Test only: the collector refuses any non-RIPE host unless told to allow this one.
import http from 'node:http';
import { latestFor, NOW } from './ripe-fixtures.mjs';

// opts: { config, q, now, failFirst: {status, count, headers}, delayMs, bodyBytes, redirect, perNode }
export function startMock(opts) {
  const seen = []; let failed = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); seen.push(req.url);
    const m = u.pathname.match(/^\/api\/v2\/measurements\/(\d+)\/latest\/$/);
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (!m) return send(404, { error: { status: 404 } });
    if (opts.redirect) return send(302, '', { location: 'https://example.org/' });
    if (opts.failFirst && failed < opts.failFirst.count) { failed++; return send(opts.failFirst.status, { error: { status: opts.failFirst.status } }, opts.failFirst.headers || {}); }
    const dst = opts.config.nodes.find((n) => String(n.measurement_id) === m[1]); if (!dst) return send(404, { error: { status: 404 } });
    const go = () => {
      if (opts.bodyBytes) return send(200, JSON.stringify([{ pad: 'x'.repeat(opts.bodyBytes) }]));
      const want = new Set((u.searchParams.get('probe_ids') || '').split(',').map(Number));
      const rows = latestFor(opts.config, dst.id, { now: opts.now ?? NOW, q: { ...(opts.q || {}), ...(opts.perNode && opts.perNode[dst.id] || {}) } });
      send(200, Array.isArray(rows) ? rows.filter((r) => !r || !r.prb_id || want.has(r.prb_id)) : rows);
    };
    opts.delayMs ? setTimeout(go, opts.delayMs) : go();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ host: `127.0.0.1:${srv.address().port}`, base: `http://127.0.0.1:${srv.address().port}/api/v2`, seen, close: () => new Promise((r) => { srv.close(r); if (srv.closeAllConnections) srv.closeAllConnections(); }) })));
}
