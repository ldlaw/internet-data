// Verifies every pinned action SHA in the workflow against the OFFICIAL upstream repository, two independent ways (read-only, unauthenticated):
//   1. GitHub REST API: repository identity, commit exists in that repository, tag points at the pinned SHA, SHA is reachable from the default branch, latest release
//   2. git protocol: git ls-remote https://github.com/<owner>/<repo> for the tag (and its dereferenced commit)
// A composite action pulls in further actions of its own (upload-pages-artifact uses upload-artifact); those nested pins are read from the action's own
// action.yml AT THE PINNED SHA and verified the same way, so nothing the workflow runs is left unchecked.
// usage: node scripts/verify-action-shas.mjs     exit 1 if anything does not match
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'collect-and-deploy.yml'), 'utf8');
const H = { 'user-agent': 'internet-data-gate2b-preflight (read-only GET)', accept: 'application/vnd.github+json' };
const api = async (p) => { const r = await fetch('https://api.github.com' + p, { headers: H }); if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`); return r.json(); };
const raw = async (repo, sha, f) => { const r = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${f}`, { headers: { 'user-agent': H['user-agent'] } }); return r.ok ? r.text() : null; };
const USES = /uses:\s*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})\s*#\s*(v[\w.]+)/g;
let bad = 0; const ok = (c, msg) => { if (!c) bad++; return (c ? 'ok  ' : 'FAIL') + ' ' + msg; };
const seen = new Set();

async function verify(repo, sha, tag, via) {
  if (seen.has(repo + sha)) return; seen.add(repo + sha);
  const lines = [`${repo}@${sha.slice(0, 12)} (${tag})${via ? '  [pulled in by ' + via + ']' : ''}`];
  let nested = [];
  try {
    const r = await api(`/repos/${repo}`); lines.push(ok(r.owner.login === 'actions' && !r.fork && !r.archived && r.full_name === repo, `repository ${r.full_name}: owner ${r.owner.login}, fork ${r.fork}, archived ${r.archived}, default branch ${r.default_branch}`));
    const c = await api(`/repos/${repo}/commits/${sha}`); lines.push(ok(c.sha === sha, `commit exists in this repository: ${c.sha.slice(0, 12)}, ${c.commit.committer.date}, signature verified by GitHub: ${c.commit.verification.verified} (${c.commit.verification.reason})`));
    const ref = await api(`/repos/${repo}/git/ref/tags/${tag}`); let tagSha = ref.object.sha; if (ref.object.type === 'tag') tagSha = (await api(`/repos/${repo}/git/tags/${tagSha}`)).object.sha;
    lines.push(ok(tagSha === sha, `API: tag ${tag} points at ${tagSha.slice(0, 12)}`));
    const cmp = await api(`/repos/${repo}/compare/${r.default_branch}...${sha}`); lines.push(ok(['identical', 'behind'].includes(cmp.status), `SHA is on the default branch history (compare status "${cmp.status}", ${cmp.behind_by} commits behind the tip)`));
    const rel = await api(`/repos/${repo}/releases/latest`); lines.push(`${rel.tag_name === tag ? 'ok  ' : 'NOTE'} latest release is ${rel.tag_name} (${rel.published_at.slice(0, 10)})${rel.tag_name === tag ? '' : ', newer than the pinned tag'}`);
    const out = execFileSync('git', ['ls-remote', `https://github.com/${repo}`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf8' }).trim().split('\n').map((l) => l.split('\t')), deref = out.find((x) => x[1].endsWith('^{}')) || out[0];
    lines.push(ok(deref[0] === sha, `git ls-remote (independent): ${deref[1]} = ${deref[0].slice(0, 12)}`));
    const manifest = (await raw(repo, sha, 'action.yml')) || (await raw(repo, sha, 'action.yaml')) || '';
    const using = (manifest.match(/using:\s*['"]?([\w.-]+)/) || [])[1]; const loose = [...manifest.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]).filter((u) => !/^\.\//.test(u));
    nested = [...manifest.matchAll(USES)].map((m) => ({ repo: m[1], sha: m[2], tag: m[3] }));
    lines.push(ok(loose.length === nested.length, `runtime "${using}"; nested actions: ${loose.length ? loose.join(', ') : 'none'}${loose.length === nested.length ? '' : ' (one or more are NOT pinned to a commit SHA with a version comment)'}`));
  } catch (e) { bad++; lines.push('FAIL ' + e.message); }
  console.log(lines.join('\n   ') + '\n');
  for (const n of nested) await verify(n.repo, n.sha, n.tag, `${repo}@${tag}`);
}

const uses = [...wf.matchAll(USES)].map((m) => ({ repo: m[1], sha: m[2], tag: m[3] }));
console.log(`${uses.length} pinned actions found in the workflow\n`);
for (const u of uses) await verify(u.repo, u.sha, u.tag, null);
console.log(bad ? `${bad} check(s) FAILED` : `All ${seen.size} pinned SHAs (${uses.length} in the workflow, ${seen.size - uses.length} nested) match their official upstream repositories.`); process.exitCode = bad ? 1 : 0;
