// Pre-publication audit of the ENTIRE git history (every blob of every commit, plus commit metadata). Local, read-only.
// Flags: IP addresses, credentials, e-mail addresses, local paths, raw RIPE Atlas response signatures, large or binary files.
// A finding is either "allowed" (listed, with the reason) or "blocking". Exit 1 if anything is blocking.   node scripts/audit-history.mjs
import { execFileSync } from 'node:child_process'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', root, ...a], { encoding: 'buffer', maxBuffer: 1 << 28 });
const gits = (...a) => git(...a).toString('utf8');

const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g, IPV6 = /(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4})?|::(?:[0-9a-f]{1,4}:?){1,7}/gi;
const docRange = (ip) => /^(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip) || /^127\./.test(ip) || ip === '0.0.0.0';
const RULES = [
  ['credential', /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer [A-Za-z0-9._-]{20,}|(?:api[_-]?key|secret|passw(?:or)?d|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
  ['email', /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ['local path', /[A-Za-z]:\\Users|[A-Za-z]:\/Users|\/Users\/[a-z]|\/home\/[a-z]+\/|AppData\\/],
  ['raw RIPE result signature', /"prb_id"\s*:\s*\d+|"stored_timestamp"\s*:\s*\d+|"msm_id"\s*:\s*\d+\s*,\s*"prb_id"/]
];
const ALLOWED_EMAIL = /noreply@anthropic\.com$/;
const findings = [];
const add = (kind, where, text, allowed, why) => findings.push({ kind, where, text: String(text).slice(0, 90), allowed, why });

// metadata of every commit (author, committer, message)
for (const l of gits('log', '--all', '--format=%H%x09%an <%ae>%x09%cn <%ce>%x09%B%x1e').split('\x1e').filter((x) => x.trim())) {
  const [h, a, c, ...msg] = l.trim().split('\t'); const m = msg.join('\t');
  add('author identity (public on push)', h.slice(0, 7), a + (a === c ? '' : ' | ' + c), true, 'the same identity is already public in the website repository history');
  for (const [k, re] of RULES) { const mm = m.match(re); if (mm && !(k === 'email' && ALLOWED_EMAIL.test(mm[0]))) add(k, h.slice(0, 7) + ' (message)', mm[0], false, 'in a commit message'); }
}
// every distinct blob of every commit
const seen = new Map();
for (const c of gits('rev-list', '--all').trim().split('\n')) for (const line of gits('ls-tree', '-r', '--long', c).trim().split('\n')) { const m = line.match(/^\d+ blob ([0-9a-f]{40})\s+(\d+|-)\t(.+)$/); if (m && !seen.has(m[1] + m[3])) seen.set(m[1] + m[3], { blob: m[1], size: +m[2], file: m[3] }); }
let nBlobs = 0, bytes = 0; const files = new Set();
for (const { blob, size, file } of seen.values()) {
  nBlobs++; bytes += size; files.add(file); const buf = git('cat-file', 'blob', blob), txt = buf.toString('utf8');
  if (buf.includes(0)) add('binary file', file, '', false, 'binary content is not expected');
  if (size > 100 * 1024) add('large file', file, size + ' bytes', false, 'unexpectedly large');
  if (/^(out|site|node_modules)\//.test(file) || /\.(log|env|pem|key)$/.test(file) || /(^|\/)\.env/.test(file)) add('unwanted path', file, '', false, 'generated output or secret-like file name');
  txt.split('\n').forEach((ln, i) => {
    for (const ip of ln.match(IPV4) || []) { if (docRange(ip)) continue; if (file === 'config/nodes.json') add('IP address', `${file}:${i + 1}`, ip, true, 'RIPE-published address of a public data-centre anchor, used only to verify results, never published'); else add('IP address', `${file}:${i + 1}`, ip, false, 'unexpected address'); }
    for (const ip of ln.match(IPV6) || []) { if (/^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$/.test(ip)) continue; if (/^(::1?|2001:0?db8:.*)$/i.test(ip)) continue; if (/[a-f:]{3}/i.test(ip) && ip.length > 4) add('IPv6-like string', `${file}:${i + 1}`, ip, false, 'IPv6 address outside the documentation range'); }
    for (const [k, re] of RULES) { const mm = ln.match(re); if (!mm) continue; if (k === 'email' && ALLOWED_EMAIL.test(mm[0])) continue; add(k, `${file}:${i + 1}`, mm[0], false, 'matched ' + k); }
  });
}
const blocking = findings.filter((f) => !f.allowed), allowed = findings.filter((f) => f.allowed);
console.log(`commits: ${gits('rev-list', '--all', '--count').trim()}, distinct file versions scanned: ${nBlobs}, distinct paths: ${files.size}, bytes: ${bytes}`);
const group = {}; for (const f of allowed) (group[f.kind + ' | ' + f.why] ||= []).push(f); for (const [k, v] of Object.entries(group)) console.log(`ALLOWED  ${k}: ${v.length} occurrence(s), e.g. ${v.slice(0, 2).map((x) => x.where + ' ' + x.text).join('; ')}`);
for (const f of blocking) console.log(`BLOCKING ${f.kind}: ${f.where} ${f.text} (${f.why})`);
console.log(blocking.length ? `\n${blocking.length} blocking finding(s)` : '\nNo blocking finding: no credential, no e-mail address other than commit author identities, no local path, no raw RIPE result, no unexpected address, no binary or large file.');
process.exitCode = blocking.length ? 1 : 0;
