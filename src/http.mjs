// Guarded HTTP for the collector: one fixed HTTPS host, a hard request budget, timeouts, bounded retries with backoff,
// Retry-After handling, abort on a second 429, no redirects, a response size cap. Provider-neutral.
export class RateLimited extends Error { constructor(m) { super(m); this.name = 'RateLimited'; } }
export class BudgetExceeded extends Error { constructor(m) { super(m); this.name = 'BudgetExceeded'; } }
export class FetchFailed extends Error { constructor(m, url, status) { super(m); this.name = 'FetchFailed'; this.url = url; this.status = status; } }

export function createClient({ host, maxRequests = 25, timeoutMs = 20000, retries = 3, backoffMs = 1000, maxBytes = 2 * 1024 * 1024, userAgent = 'internet-data-collector/0.0.0 (read-only GET; https://lateeflaw.info)',
  allowInsecureHost = null, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const state = { requests: 0, rate429: 0, bytes: 0, log: [] };
  async function getJson(url) {
    const u = new URL(url);
    const okInsecure = allowInsecureHost && u.protocol === 'http:' && u.host === allowInsecureHost;
    if (!okInsecure && (u.protocol !== 'https:' || u.hostname !== host)) throw new FetchFailed(`refusing ${u.protocol}//${u.host}: only https://${host} is allowed`, url);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (state.requests >= maxRequests) throw new BudgetExceeded(`request budget of ${maxRequests} reached`);
      state.requests++;
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs), t0 = Date.now();
      try {
        const res = await fetchImpl(url, { signal: ctl.signal, redirect: 'manual', credentials: 'omit', headers: { 'user-agent': userAgent, accept: 'application/json', connection: 'close' } });
        if (res.status >= 300 && res.status < 400) throw new FetchFailed(`redirect ${res.status} refused`, url, res.status);
        if (res.status === 429) {
          state.rate429++;
          if (state.rate429 >= 2) throw new RateLimited('second 429 in this run, aborting the whole run');
          const ra = Number(res.headers.get('retry-after')); await sleep(Math.min(30000, Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs * 2 ** attempt)); lastErr = new FetchFailed('429 Too Many Requests', url, 429); continue;
        }
        if (res.status >= 500) { lastErr = new FetchFailed(`server error ${res.status}`, url, res.status); await sleep(backoffMs * 2 ** attempt); continue; }
        if (!res.ok) throw new FetchFailed(`HTTP ${res.status}`, url, res.status);   // 4xx other than 429: not retried
        const len = Number(res.headers.get('content-length')); if (Number.isFinite(len) && len > maxBytes) throw new FetchFailed(`response of ${len} bytes exceeds the ${maxBytes} byte cap`, url, res.status);
        const text = await res.text(); if (text.length > maxBytes) throw new FetchFailed(`response exceeds the ${maxBytes} byte cap`, url, res.status);
        state.bytes += text.length; state.log.push({ url, status: res.status, ms: Date.now() - t0, bytes: text.length });
        try { return JSON.parse(text); } catch { throw new FetchFailed('response is not valid JSON', url, res.status); }
      } catch (e) {
        if (e instanceof RateLimited || e instanceof BudgetExceeded || (e instanceof FetchFailed && e.status && e.status < 500 && e.status !== 429)) throw e;
        if (e instanceof FetchFailed && !e.status) throw e;
        lastErr = e.name === 'AbortError' ? new FetchFailed(`timeout after ${timeoutMs} ms`, url) : e;
        if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
      } finally { clearTimeout(timer); }
    }
    throw lastErr instanceof FetchFailed ? lastErr : new FetchFailed(String(lastErr && lastErr.message || lastErr), url);
  }
  return { getJson, state };
}
