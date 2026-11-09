// Policy checks on the (inactive) workflow file: least privilege, pinned actions, no secrets, no fork-triggered runs, gates before deploy.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'collect-and-deploy.yml'), 'utf8');
// comments (whole-line and trailing) are removed so only executable YAML is checked
const code = wf.split('\n').map((l) => l.replace(/\s+#.*$/, '')).filter((l) => l.trim() && !/^\s*#/.test(l)).join('\n') + '\n';
const JOB = /^ {2}[\w-]+:\s*$/;
const section = (name) => { const lines = code.split('\n'), i = lines.findIndex((l) => l === `  ${name}:`); if (i < 0) return ''; let j = i + 1; while (j < lines.length && !JOB.test(lines[j])) j++; return lines.slice(i + 1, j).join('\n'); };

test('every action is pinned to a full 40-character commit SHA', () => {
  const uses = [...code.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]); assert.ok(uses.length >= 5);
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
});
test('only GitHub-owned actions are used', () => { for (const m of code.matchAll(/uses:\s*([\w.-]+)\//g)) assert.equal(m[1], 'actions'); });
test('the workflow-level permission is read-only contents', () => { const top = code.match(/^permissions:\n((?: {2}.*\n)+)/m)[1].trim().split('\n').map((s) => s.trim()); assert.deepEqual(top, ['contents: read']); });
test('write permissions exist only on the deploy job, and are exactly pages and id-token', () => {
  assert.equal((code.match(/: write/g) || []).length, 2); const d = section('deploy'); assert.match(d, /pages: write/); assert.match(d, /id-token: write/); assert.ok(!/: write/.test(section('build')));
});
test('no secrets, tokens, pull_request triggers or inline credentials', () => {
  for (const bad of [/secrets\./, /GITHUB_TOKEN/, /pull_request/, /pull_request_target/, /github\.event\.(issue|pull_request|comment)/, /persist-credentials:\s*true/, /--force/]) assert.ok(!bad.test(code), String(bad));
  assert.match(code, /persist-credentials:\s*false/);
});
test('schedule avoids the :00 and :30 peaks, and manual and config-push triggers exist', () => {
  const cron = code.match(/cron:\s*'([^']+)'/)[1]; assert.ok(!/^(0|30)[ ,]/.test(cron), cron); assert.match(code, /workflow_dispatch/); assert.match(code, /paths:\s*\['config\/\*\*'/);
});
test('jobs are time-limited, serialized, and deploy depends on a build that runs the tests and the gates first', () => {
  assert.equal((code.match(/timeout-minutes:\s*10/g) || []).length, 2); assert.match(code, /concurrency:\n {2}group: pages\n {2}cancel-in-progress: false/); assert.match(section('deploy'), /needs: build/);
  const b = section('build'); assert.ok(b.indexOf('node --test') < b.indexOf('src/collect.mjs') && b.indexOf('src/collect.mjs') < b.indexOf('upload-pages-artifact'));
});
test('only the site tree is uploaded for Pages, and the dataset artifact is short-lived', () => { assert.match(code, /upload-pages-artifact@[0-9a-f]{40}\n {8}with:\n {10}path: site\n/); assert.match(code, /retention-days:\s*7/); });
test('the deploy job uses the github-pages environment', () => assert.match(section('deploy'), /name: github-pages/));
