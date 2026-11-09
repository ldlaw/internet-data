// Mutation proof: copy the repo to a temp folder, break ONE rule in the copy, run the whole suite, and require it to FAIL.
// A mutant that survives means a rule is not actually protected by a test. Usage: node scripts/mutation-proof.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = [  // [file, exact text to replace, replacement, what it breaks]
  ['src/adapters/ripe-atlas-ping.mjs', 'generatedAt - r.timestamp > POLICY.maxAgeS', 'false', 'stale-row guard removed (2021 rows would be shown as live)'],
  ['src/adapters/ripe-atlas-ping.mjs', 'best < floor * POLICY.fibreSlack', 'false', 'speed-of-light bound removed'],
  ['src/adapters/ripe-atlas-ping.mjs', 'r.dst_addr !== dst.target_ip || r.msm_id !== dst.measurement_id', 'false', 'destination check removed'],
  ['src/adapters/ripe-atlas-ping.mjs', 'if (src.id === dst.id) continue;', '', 'self pairs no longer skipped'],
  ['src/adapters/ripe-atlas-ping.mjs', 'r.timestamp > generatedAt + POLICY.futureSlackS', 'false', 'future-timestamp guard removed'],
  ['src/curate.mjs', 'o.observed.last > cur.observed.last ||', 'o.observed.last < cur.observed.last ||', 'keeps the STALEST direction'],
  ['src/curate.mjs', "src: o.src, dst: o.dst, rtt_median", "src: o.dst, dst: o.src, rtt_median", 'mirrors the direction of every pair'],
  ['src/curate.mjs', "reverse: by.has(`ping:${o.dst}>${o.src}`) ? 'present' : 'missing'", "reverse: 'present'", 'reverse flag always present (hides missing data)'],
  ['src/curate.mjs', 'if (!best.has(ukey(ids[i], ids[j]))) gaps.push', 'if (false) gaps.push', 'gaps silently dropped'],
  ['src/build.mjs', ["if (status === 'pending') throw", "if (!['granted', 'not_required', 'synthetic'].includes(status)) throw"], ['if (false) throw', 'if (false) throw'], 'publication permission gate removed (both the pending check and the unknown-status check, which back each other up)'],
  ['src/build.mjs', 'c.pairs_published < Math.ceil(MIN_PAIR_SHARE * c.pairs_expected)', 'false', 'quality gate removed'],
  ['src/http.mjs', 'if (state.rate429 >= 2)', 'if (false)', 'a second 429 no longer aborts the run'],
  ['src/http.mjs', 'if (state.requests >= maxRequests)', 'if (false)', 'request budget removed'],
  ['src/collect.mjs', "if (!dry && publication.permission_status === 'pending')", 'if (false)', 'collector calls the provider even while permission is pending'],
  ['src/contract.mjs', 'else if (strict && s.additionalProperties === false)', 'else if (false)', 'strict mode no longer rejects unknown (leaked) fields'],
  ['src/contract.mjs', 'const e = [...scanLeaks(doc)];', 'const e = [];', 'IP-literal scan removed']
];
const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7); let survived = 0, ran = 0;
for (const [file, from, to, what] of M) {
  if (only && !what.includes(only)) continue; ran++;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idata-mut-')); fs.cpSync(root, dir, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules|out|site)([\\/]|$)/.test(s) });
  const f = path.join(dir, file); let t = fs.readFileSync(f, 'utf8'); const froms = [].concat(from), tos = [].concat(to); let bad = false;
  froms.forEach((x, i) => { const n = t.split(x).length - 1; if (n !== 1) { console.log(`ERROR  pattern found ${n} times in ${file}: ${x}`); bad = true; } else t = t.replace(x, () => tos[i]); });
  if (bad) { survived++; continue; }
  fs.writeFileSync(f, t);
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=30000'], { cwd: dir, encoding: 'utf8', timeout: 150000 });
  const killed = r.status !== 0; if (!killed) survived++;
  console.log(`${killed ? 'KILLED  ' : 'SURVIVED'} ${what}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${ran - survived} of ${ran} mutants killed`); process.exitCode = survived ? 1 : 0;
