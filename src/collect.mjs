// Collector CLI. Local use and the (inactive) workflow call this.
//   node src/collect.mjs --dry-run                 collect from the live API, write documents to out/, publish nothing
//   node src/collect.mjs --out site                collect, run every gate, write the site tree (refused while permission is pending)
//   node src/collect.mjs --out site --control-only deploy the kill-switch site without calling the provider
// A disabled config/control.json automatically selects control-only: no provider request is made.
// Exit codes: 0 ok, 2 a validation or quality gate failed, 3 publication not permitted, 4 collection failed (network, rate limit, budget).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { loadSchema } from './contract.mjs';
import { createClient, RateLimited, BudgetExceeded, FetchFailed } from './http.mjs';
import * as ripe from './adapters/ripe-atlas-ping.mjs';
import { collectSynthetic, FAULTS } from './adapters/fixture-ping.mjs';
import { buildSite, buildControlOnlySite, permissionGate, GateFailure, EXIT } from './build.mjs';
import { curateHome, controlDocument } from './curate.mjs';
import { validateDocument } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt = null) => { const i = process.argv.indexOf(name); return i < 0 ? dflt : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const write = (dir, rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

export async function main() {
  const cfgDir = arg('--config-dir', path.join(root, 'config')), outDir = arg('--out', null), dry = process.argv.includes('--dry-run') || !outDir;
  const schemaFile = path.join(root, 'contracts', 'internet-model.v1.schema.json'), schemaText = fs.readFileSync(schemaFile, 'utf8'), schema = JSON.parse(schemaText);
  const nodesCfg = readJson(path.join(cfgDir, 'nodes.json')), controlCfg = readJson(path.join(cfgDir, 'control.json')), publication = readJson(path.join(cfgDir, 'publication.json'));
  const nowMs = arg('--now') ? Date.parse(arg('--now')) : Date.now(), nowIso = new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z'), site = outDir || path.join(root, 'out', 'site');
  try {
    // Synthetic mode (Gate 2B rehearsal): permission_status 'synthetic' selects the fixture adapter, which makes NO network request of any kind.
    // Faults rehearse the failure gates and are accepted only in synthetic mode, so they can never touch real data.
    // The fault comes from --fault (the workflow's manual-run choice) or, when that is "none", from config/publication.json "rehearsal_fault"
    // (so a rehearsal can be driven by a reviewed commit alone, with no token). A leftover fault in the config of non-synthetic data fails the run loudly.
    const synthetic = publication.permission_status === 'synthetic', cliFault = arg('--fault', 'none'), fault = cliFault !== 'none' ? cliFault : (publication.rehearsal_fault ?? 'none');
    if (!FAULTS.includes(fault)) throw new GateFailure('validation', `unknown fault ${JSON.stringify(fault)}`, [`allowed: ${FAULTS.join(', ')}`]);
    if (fault !== 'none' && !synthetic) throw new GateFailure('permission', 'fault injection is only available while permission_status is synthetic', [`permission_status=${publication.permission_status}`]);
    if (controlCfg.enabled !== true || process.argv.includes('--control-only')) {
      const r = buildControlOnlySite({ schemaText, controlConfig: controlCfg, nowIso, schema });
      for (const [rel, text] of r.files) write(site, rel, text);
      console.log(`control-only site written to ${site} (feature disabled; no provider request made)`); return EXIT.ok;
    }
    if (!dry && publication.permission_status === 'pending') throw new GateFailure('permission', 'publication permission is pending: refusing before any provider request', ['config/publication.json']);
    const testHost = arg('--allow-host', null), apiBase = arg('--api-base', ripe.API_BASE), fetchedAt = nowIso, generatedAt = Math.floor((arg('--now') ? nowMs : Date.now()) / 1000);
    let dataset, client = { state: { requests: 0, bytes: 0 } };
    if (synthetic) dataset = collectSynthetic(nodesCfg, { nowSeconds: generatedAt, fetchedAt, fault });
    else {
      client = createClient({ host: 'atlas.ripe.net', allowInsecureHost: testHost, maxRequests: 25, timeoutMs: Number(arg('--timeout', 20000)), backoffMs: Number(arg('--backoff', 1000)) });
      const raw = await ripe.fetchRaw(nodesCfg, client, { apiBase, pacingMs: Number(arg('--pacing', 1000)) });
      dataset = ripe.normalize(raw, nodesCfg, { generatedAt, fetchedAt, permissionStatus: publication.permission_status });
    }
    if (dry) {   // local inspection only: strict-validate and write to out/, never a site tree
      const dErr = validateDocument(schema, dataset), home = curateHome(dataset), hErr = validateDocument(schema, home, { dataset }), control = controlDocument({ ...controlCfg, enabled: true }, nowIso);
      const o = path.join(root, 'out'); write(o, 'dataset.json', JSON.stringify(dataset) + '\n'); write(o, 'home.json', JSON.stringify(home) + '\n'); write(o, 'control.json', JSON.stringify(control) + '\n');
      console.log(`dry run: ${client.state.requests} requests, ${client.state.bytes} bytes; observations ${dataset.observations.length}/${dataset.coverage.expected}; home pairs ${home.pairs.length}, gaps ${home.gaps.length}; dropped ${JSON.stringify(dataset.coverage.dropped)}`);
      console.log(`validation: dataset ${dErr.length ? 'FAIL ' + dErr.slice(0, 3).join(' | ') : 'ok'}; home view ${hErr.length ? 'FAIL ' + hErr.slice(0, 3).join(' | ') : 'ok'}; written to ${o} (not publishable: dry run)`);
      return dErr.length || hErr.length ? EXIT.gate : EXIT.ok;
    }
    const r = buildSite({ schema, schemaText, controlConfig: controlCfg, publication, dataset, nowIso });
    for (const [rel, text] of r.files) write(site, rel, text);
    write(path.join(root, 'out'), 'dataset.json', JSON.stringify(dataset) + '\n');
    console.log(`site written to ${site}: ${r.report.pairs} pairs, ${r.report.gaps} gaps, home view ${r.report.homeBytes} bytes; ${client.state.requests} requests${synthetic ? ' (SIMULATED data, fault: ' + fault + ')' : ''}`); return EXIT.ok;
  } catch (e) {
    if (e instanceof GateFailure) { console.error(`GATE ${e.code}: ${e.message}`); e.details.slice(0, 8).forEach((d) => console.error('  ' + d)); return e.code === 'permission' ? EXIT.permission : EXIT.gate; }
    if (e instanceof RateLimited || e instanceof BudgetExceeded || e instanceof FetchFailed) { console.error(`COLLECTION ${e.name}: ${e.message}`); return EXIT.collection; }
    throw e;
  }
}
// process.exitCode, not process.exit(): exiting while aborted connections are still closing can crash Node on Windows (fail-fast 0xC0000409).
if (process.argv[1] && process.argv[1].endsWith('collect.mjs')) main().then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 1; });
