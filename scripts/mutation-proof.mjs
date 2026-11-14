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
  ['src/contract.mjs', 'const e = [...scanLeaks(doc)];', 'const e = [];', 'IP-literal scan removed'],
  // Gate 2B: synthetic marking, fault injection, workflow policy
  ['src/collect.mjs', "if (fault !== 'none' && !synthetic) throw", 'if (false) throw', 'fault injection allowed on real-data permission states'],
  ['src/collect.mjs', 'if (synthetic) dataset = collectSynthetic(', 'if (false) dataset = collectSynthetic(', 'synthetic mode no longer selects the no-network fixture adapter'],
  ['src/contract.mjs', "if (sim !== (pv.provider.id === 'fixture'))", 'if (false)', 'simulated flag no longer tied to the fixture provider'],
  ['src/contract.mjs', "if (sim !== (pv.publication.permission_status === 'synthetic'))", 'if (false)', 'simulated flag no longer tied to the synthetic permission status'],
  ['src/contract.mjs', "if (!datasetId.startsWith('synthetic-'))", 'if (false)', 'simulated data no longer needs the synthetic- dataset prefix'],
  ['src/contract.mjs', 'if (!(v > SYNTHETIC_ID_BASE)) e.push', 'if (false) e.push', 'simulated data may use real-looking identifiers'],
  ['src/contract.mjs', 'if (v > SYNTHETIC_ID_BASE) e.push', 'if (false) e.push', 'real data may use the reserved synthetic identifier range'],
  ['src/contract.mjs', 'if (/ripe\\.net/i.test(v)) e.push', 'if (false) e.push', 'simulated data may point at RIPE'],
  ['src/contract.mjs', 'if (ctx.dataset && simV !== (ctx.dataset.provenance.simulated === true))', 'if (false)', 'home view may disagree with the dataset about being simulated'],
  ['src/contract.mjs', 'if (simV && !/^SIMULATED/.test(at0.text))', 'if (false)', 'simulated home view may omit the SIMULATED attribution'],
  ['src/curate.mjs', 'simulated: true, disclaimer:', 'simulated: false, disclaimer:', 'simulated home view not flagged simulated'],
  ['src/curate.mjs', "sim = dataset.provenance.simulated === true;", 'sim = false;', 'home view ignores the dataset simulated flag'],
  ['src/build.mjs', "if (status === 'synthetic' && provider !== 'fixture') throw", 'if (false) throw', 'synthetic permission may publish a real provider dataset'],
  ['src/adapters/fixture-ping.mjs', 'anchor_id: SYNTHETIC_ID_BASE + 1 + i', 'anchor_id: 1838 + i', 'synthetic identifiers leave the reserved range'],
  ['.github/workflows/collect-and-deploy.yml', 'run: node src/collect.mjs --out site --fault "${FAULT:-none}"', 'run: node src/collect.mjs --out site --fault ${{ inputs.fault }}', 'dispatch input interpolated into a shell command'],
  ['.github/workflows/collect-and-deploy.yml', '      id-token: write', '      id-token: write\n      contents: write', 'deploy job gains contents write'],
  ['.github/workflows/collect-and-deploy.yml', "    - cron: '17,47 * * * *'", "    - cron: '0,30 * * * *'", 'the schedule changed from the approved one'],
  ['.github/workflows/collect-and-deploy.yml', 'persist-credentials: false', 'persist-credentials: true', 'checkout keeps the job credentials'],
  ['.github/workflows/collect-and-deploy.yml', 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/checkout@v7', 'an action pinned by tag instead of commit SHA'],
  ['.github/workflows/collect-and-deploy.yml', '        run: node --test', '        run: node --test\n      - run: git push origin HEAD', 'a step that pushes to a repository'],
  ['.github/workflows/collect-and-deploy.yml', '        run: node --test', '        run: |\n          node --test\n          curl -s https://example.org/x', 'a multi-line run block that calls out to the network'],
  // failed-gate bypass: constructs that would let a failed gate still publish (GitHub runs a step only after success unless one of these overrides it)
  ['.github/workflows/collect-and-deploy.yml', 'run: node src/collect.mjs --out site --fault "${FAULT:-none}"', 'run: node src/collect.mjs --out site --fault "${FAULT:-none}"\n        continue-on-error: true', 'failed-gate bypass: the collect step may fail without failing the job'],
  ['.github/workflows/collect-and-deploy.yml', '        with:\n          path: site', '        if: always()\n        with:\n          path: site', 'failed-gate bypass: the upload step runs even after a failed gate'],
  ['.github/workflows/collect-and-deploy.yml', '    needs: build', '    needs: build\n    if: ${{ always() }}', 'failed-gate bypass: the deploy job runs even after a failed build']
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
