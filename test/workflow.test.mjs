// Policy checks on the workflow file and the collector source: least privilege, pinned actions, no secrets, no way to reach another repository,
// no unattended schedule during the rehearsal, gates before deploy.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { FAULTS } from '../src/adapters/fixture-ping.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'collect-and-deploy.yml'), 'utf8');
// comments (whole-line and trailing) are removed so only executable YAML is checked
const code = wf.split('\n').map((l) => l.replace(/\s+#.*$/, '')).filter((l) => l.trim() && !/^\s*#/.test(l)).join('\n') + '\n';
const JOB = /^ {2}[\w-]+:\s*$/;
const section = (name) => { const lines = code.split('\n'), i = lines.findIndex((l) => l === `  ${name}:`); if (i < 0) return ''; let j = i + 1; while (j < lines.length && !JOB.test(lines[j])) j++; return lines.slice(i + 1, j).join('\n'); };
// every shell command of every step: "run: x", "- run: x" (dash on the same line) and block scalars ("run: |" followed by more-indented lines)
const runBlocks = () => {
  const lines = code.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*([|>][-+]?)?\s*(.*)$/); if (!m) continue;
    if (!m[2]) { out.push(m[3]); continue; }
    const indent = lines[i].match(/^\s*/)[0].length, body = []; while (i + 1 < lines.length && (lines[i + 1].match(/^\s*/)[0].length > indent)) body.push(lines[++i].trim()); out.push(body.join('\n'));
  }
  return out;
};

test('every action is pinned to a full 40-character commit SHA', () => {
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]); assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
});
test('only GitHub-owned actions are used', () => { for (const m of code.matchAll(/uses:\s*([\w.-]+)\//g)) assert.equal(m[1], 'actions'); });
test('exactly four actions are used: checkout, setup-node, upload-pages-artifact, deploy-pages', () => {
  const names = [...code.matchAll(/uses:\s*([\w.-]+\/[\w.-]+)@/g)].map((m) => m[1]).sort(); assert.deepEqual(names, ['actions/checkout', 'actions/deploy-pages', 'actions/setup-node', 'actions/upload-pages-artifact']);
});
test('the workflow-level permission is read-only contents', () => { const top = code.match(/^permissions:\n((?: {2}.*\n)+)/m)[1].trim().split('\n').map((s) => s.trim()); assert.deepEqual(top, ['contents: read']); });
test('write permissions exist only on the deploy job, and are exactly pages and id-token', () => {
  assert.equal((code.match(/: write/g) || []).length, 2); const d = section('deploy'); assert.match(d, /pages: write/); assert.match(d, /id-token: write/); assert.ok(!/: write/.test(section('build')));
});
test('the only permission scopes ever named are contents, pages and id-token (nothing for issues, pull requests, actions, packages, deployments or statuses)', () => {
  const names = new Set([...code.matchAll(/^\s+([a-z-]+): (?:read|write)$/gm)].map((m) => m[1])); assert.deepEqual([...names].sort(), ['contents', 'id-token', 'pages']);
});
test('no secrets, tokens, pull_request triggers or inline credentials', () => {
  for (const bad of [/secrets\./, /GITHUB_TOKEN/, /pull_request/, /pull_request_target/, /workflow_run/, /repository_dispatch/, /issue_comment/, /github\.event\.(issue|pull_request|comment)/, /persist-credentials:\s*true/, /--force/, /(?<![\w-])token:/, /ssh-key/]) assert.ok(!bad.test(code), String(bad));
  assert.match(code, /persist-credentials:\s*false/);
});
test('the workflow cannot reach another repository: no cross-repository checkout, no git write, no network tool, no website name', () => {
  assert.ok(!/^\s*repository:/m.test(code), 'checkout of another repository'); assert.ok(!/^\s*ref:/m.test(code));
  for (const r of runBlocks()) assert.ok(!/\b(git\s+(push|commit|config|remote|tag)|gh\s|curl|wget|ssh|scp|rsync|npm\s+(publish|install)|docker|sudo)\b/.test(r), r);
  assert.ok(!/lateeflaw/i.test(code), 'the workflow must not name the website repository or domain'); assert.ok(!/github-script/.test(code));
});
test('the only run commands are node tests and the collector (nothing else executes)', () => { assert.deepEqual(runBlocks(), ['node --test', 'node src/collect.mjs --out site --fault "${FAULT:-none}"']); });
test('no expression is interpolated into a shell command: the dispatch input reaches the script only through an env variable', () => {
  for (const r of runBlocks()) assert.ok(!/\$\{\{/.test(r), r);
  assert.match(code, /env:\n {10}FAULT: \$\{\{ inputs\.fault \}\}\n {8}run:/);
});
test('the dispatch input is a fixed choice that matches the collector fault list exactly', () => {
  const opts = code.match(/options: \[([^\]]+)\]/)[1].split(',').map((s) => s.trim()); assert.deepEqual(opts, FAULTS); assert.match(code, /type: choice/); assert.match(code, /default: none/);
});
test('no schedule is active during the rehearsal, and the planned schedule (commented) avoids the :00 and :30 peaks', () => {
  assert.ok(!/^\s*schedule:/m.test(code) && !/cron:/.test(code), 'an active schedule would republish simulated data unattended');
  const planned = wf.match(/cron: '([^']+)'/)[1]; assert.ok(!/^(0|30)[ ,]/.test(planned), planned);
  assert.match(code, /workflow_dispatch/); assert.match(code, /paths:\s*\['config\/\*\*'/);
});
test('jobs are time-limited, serialized, and deploy depends on a build that runs the tests and the gates first', () => {
  assert.equal((code.match(/timeout-minutes:\s*10/g) || []).length, 2); assert.match(code, /concurrency:\n {2}group: pages\n {2}cancel-in-progress: false/); assert.match(section('deploy'), /needs: build/);
  const b = section('build'); assert.ok(b.indexOf('node --test') < b.indexOf('src/collect.mjs') && b.indexOf('src/collect.mjs') < b.indexOf('upload-pages-artifact'));
});
test('a failed gate cannot publish: nothing overrides GitHub\'s default that a step or job runs only after everything before it succeeded', () => {
  // GitHub skips every later step, and every job that "needs" this one, after a failure, unless one of these constructs says otherwise.
  for (const bad of [/^\s*(?:-\s+)?if:/m, /continue-on-error/, /\balways\(\)/, /\bfailure\(\)/, /\bcancelled\(\)/, /\bsuccess\(\)/, /\bneeds\.[\w-]+\.(result|outcome)/, /\.outcome\b/, /\.conclusion\b/]) assert.ok(!bad.test(code), String(bad));
  const jobs = code.slice(code.indexOf('\njobs:\n')).match(/^ {2}[\w-]+:\s*$/gm).map((s) => s.trim());
  assert.deepEqual(jobs, ['build:', 'deploy:'], 'a third job could be a "needs" target that always succeeds');
  assert.equal((code.match(/^\s+needs:/gm) || []).length, 1); assert.match(section('deploy'), /^ {4}needs: build$/m);   // a plain string, not a list
});
test('only the site tree is uploaded for Pages, and nothing else is uploaded anywhere (no artifact can expose the unpublished dataset)', () => {
  assert.match(code, /upload-pages-artifact@[0-9a-f]{40}\n {8}with:\n {10}path: site\n/); assert.ok(!/upload-artifact/.test(code)); assert.equal((code.match(/path:/g) || []).length, 1);
});
test('the deploy job uses the github-pages environment', () => assert.match(section('deploy'), /name: github-pages/));

// ---- the collector source ----
const srcFiles = (d = path.join(root, 'src')) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? srcFiles(path.join(d, e.name)) : [path.join(d, e.name)]);
test('source: no environment access, no child processes, no reference to the website, no token', () => {
  for (const f of srcFiles()) { const t = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); for (const bad of [/process\.env/, /child_process/, /lateeflaw\.github\.io/, /GITHUB_TOKEN/, /\beval\(/, /new Function/]) assert.ok(!bad.test(t), `${path.relative(root, f)}: ${bad}`); }
});
test('source: only src/http.mjs can touch the network, and only to one fixed host', () => {
  for (const f of srcFiles()) { const t = fs.readFileSync(f, 'utf8'), isHttp = f.endsWith(path.join('src', 'http.mjs')); const uses = /\bfetch\b|node:http|node:https|node:net|XMLHttpRequest|WebSocket/.test(t.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')); assert.equal(uses, isHttp, path.relative(root, f)); }
  assert.match(fs.readFileSync(path.join(root, 'src', 'collect.mjs'), 'utf8'), /host: 'atlas\.ripe\.net'/);
});
test('source: the fixture adapter cannot make a request (it imports no http client except its error class)', () => {
  const t = fs.readFileSync(path.join(root, 'src', 'adapters', 'fixture-ping.mjs'), 'utf8'); assert.ok(!/createClient|getJson|\bfetch\b/.test(t));
});
