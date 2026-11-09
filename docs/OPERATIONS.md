# Operations

Status: **Gate 2B hosting rehearsal with SIMULATED data only.** What this repository publishes right now is a synthetic test fixture, marked simulated in its schema and in every document. It contains no RIPE Atlas data and no real measurement. The collector does not contact any provider while `config/publication.json` is `synthetic`. Nothing is scheduled.

## What runs

`.github/workflows/collect-and-deploy.yml` runs `node --test`, then `node src/collect.mjs --out site --fault "${FAULT:-none}"`, then deploys `site/` with the custom Pages workflow. It runs on manual dispatch and on any push to `main` that touches `config/`, `src/`, `contracts/` or the workflow itself. **The schedule is disabled** for the rehearsal (a schedule would keep republishing simulated data unattended); the intended cron is kept in a comment for Gate 3. No commits are made and no secrets are used. The job token is scoped to this repository, so the workflow cannot modify any other repository, and a policy test fails the build if a step could (cross-repository checkout, `git push`, `gh`, `curl`, tokens, the website's name).

`src/collect.mjs` behaves as follows:

| Situation | Result |
|---|---|
| `config/control.json` has `enabled: false` | Builds a control-only site (the kill switch). **No provider request is made.** Exit 0 |
| `config/publication.json` is `pending` | Refuses **before any provider request**. Exit 3 |
| `config/publication.json` is `synthetic` | Uses the fixture adapter: simulated values from a seeded distance model, **no network request of any kind**, same normalization and gates as real data |
| `--fault` other than `none` while permission is not `synthetic` | Refused. Exit 3. Faults can never touch real data |
| Provider unreachable, a second 429, request budget reached (or the `collection` fault) | Writes nothing. Exit 4. The job fails before deploy, so the previous deployment stays online |
| A validation gate fails (schema, leak scan, direction, coverage, simulated-marking) or fewer than half the pairs have data (or the `validation` / `quality` faults) | Writes nothing. Exit 2 |
| The `permission` fault (synthetic data claiming a real provider) | Writes nothing. Exit 3 |
| Everything passes | Writes `site/v1/control.json`, `site/v1/views/home.json`, `site/v1/schema/internet-model.json`, `site/robots.txt` |

The normalized dataset (all 90 directed observations) is validated and then discarded. It is **not uploaded as a workflow artifact**: in a public repository anyone signed in to GitHub can download artifacts, so an artifact would be a publication that bypasses the permission gate. It stays unpublished until the dashboard phase.

### Rehearsing the failure gates

Two ways, both only while `permission_status` is `synthetic`:

- Run the workflow manually (Actions, collect-and-deploy, Run workflow) and pick a fault: `validation`, `quality`, `permission` or `collection`.
- Commit `"rehearsal_fault": "<fault>"` in `config/publication.json` (the push runs the workflow). This needs no token and leaves the fault visible in the git history. Set it back to `none` afterwards.

The run must fail at the collect step, the deploy job must be skipped, and the published `v1/` documents must stay exactly as they were (same `generated_at`, same ETag). A leftover fault on any other permission status fails the run loudly (exit 3).

## Publication gate

`config/publication.json` holds `permission_status`:

| Value | Meaning |
|---|---|
| `pending` | RIPE NCC has not answered. Nothing derived from RIPE may be published. This is the committed default |
| `granted`, `not_required` | RIPE NCC answered in writing. RIPE-derived views may be published |
| `synthetic` | Only the clearly simulated `fixture` provider may be published (used to rehearse Pages without any RIPE-derived data). The collector switches to the fixture adapter and makes no network request. Committed for Gate 2B |

Simulated data is marked in five independent places that the contract requires to agree: `provenance.simulated`, `permission_status: synthetic`, provider id `fixture`, a dataset id starting `synthetic-`, and identifiers above 4,000,000,000 (no real RIPE Atlas id has reached that range). Real data may not use the prefix or the range. The home view repeats it in `attribution.simulated`, and its text starts with `SIMULATED`.

Do not change this file to `granted` or `not_required` without the RIPE NCC's written answer. The gate is enforced in code and covered by tests and mutation proofs.

## Immediate disable (kill switch)

Stopping the schedule is **not** a disable: the last deployment would stay online and keep ageing for up to 24 hours. A disable has to change what is served, and the page has to obey it. The page fetches `v1/control.json` first, fails closed, and re-checks it on focus at most every five minutes.

| Layer | Action | Expected effect (targets; to be timed in the Gate 2B drill) |
|---|---|---|
| 0 | Per visit: `?globe=reference` shows the unchanged reference globe (it exists today). Until launch the layer only runs with `?globe=data` | Instant |
| 1 | Edit `config/control.json` in the GitHub web UI: set `"enabled": false`, commit to `main`. The push runs the workflow, which skips the provider and deploys a control-only site | New page loads within about 3 minutes. Works even if the provider is down |
| 2 | Repository Settings, Pages: unpublish the site (menu wording to confirm in Gate 2B), or delete the repository | Documents disappear; the page treats a 404 as off |
| 3 | In the production repo, flip the client flag (one-line commit) | About 30 s to deploy, but browsers may reuse cached HTML for up to 10 minutes |
| Open tabs | Automatic re-check of `control.json` on focus, at most once per 5 minutes; three consecutive outages also disable | Within about 5 minutes of the next focus |
| Safety net | Expiry: pulses stop at 75 minutes, everything returns to the reference globe at 24 hours | Automatic |

Disabling removes every overlay the layer added (links, markers, chip, panel, styles) and returns the unchanged reference globe. To re-enable, set `"enabled": true` and let the next run publish data; tabs that were disabled stay disabled until reloaded.

### Drill (Gate 2B acceptance test)

1. With the layer running in a browser tab, set `enabled: false` in `config/control.json` and note the time of the commit.
2. Poll `https://<origin>/v1/control.json` until it shows `"enabled": false`; record the delay.
3. Load the page with `?globe=data` in a new tab; record when it first shows the reference globe.
4. Focus the already open tab; record when it returns to the reference globe.
5. Record all four timings in the review pack. Targets: 3 minutes for step 3, 5 minutes for step 4.

## Setting up (owner, web UI, no token)

| Step | Requirement |
|---|---|
| Create the repository | Signed in as the account owner. Public and empty (GitHub Pages on the Free plan needs a public repository). Suggested name: `internet-data` |
| Configure Pages | Settings, Pages, Source: **GitHub Actions**. Needs admin or maintain (the owner has it) |
| Actions | Settings, Actions, General: allow GitHub-owned actions only; require actions to be pinned to a full-length commit SHA; workflow permissions read-only (the deploy job declares `pages: write` and `id-token: write` itself) |
| Environment | `github-pages` is created automatically; add a deployment rule so only `main` can deploy |
| Push | Your existing git credential, only after you authorize it |
| Re-verify | `node scripts/verify-action-shas.mjs` checks every `uses:` SHA (and the one the Pages composite action pulls in) against the official upstream repositories, over the API and with `git ls-remote` |

Not needed: personal access tokens, repository secrets, DNS changes. A custom domain for the data origin (`data.lateeflaw.info`) is a later decision that needs a DNS record.

## Failure modes

| Symptom | Cause | Response |
|---|---|---|
| Workflow run fails at the collect step with exit 3 | `permission_status` is `pending` | Expected until RIPE NCC answers |
| Exit 4 | Provider outage, rate limit, budget | Nothing is deployed; the site's chip ages and falls back by itself |
| Exit 2 | A gate failed | Read the log; the previous deployment stays online |
| The schedule stops running | GitHub disables scheduled workflows in a public repo after 60 days without repository activity | GitHub emails the owner; re-enable with one click. The site falls back to the reference globe in the meantime |
| Chip says "Measurements from N h ago" | Collector is late or down | Check recent workflow runs |

## Local commands

```
npm test                         # every test (the count is printed by the runner)
node src/collect.mjs --out site  # builds the site tree for the committed configuration (synthetic: no network at all)
node src/collect.mjs --out site --fault validation   # rehearse a failure gate (synthetic only)
node scripts/mutation-proof.mjs  # breaks one rule at a time in a copy and requires the suite to fail
node scripts/audit-history.mjs   # scans every blob and commit message for addresses, credentials, e-mail, local paths, raw RIPE results
node scripts/verify-action-shas.mjs   # checks the pinned action SHAs against upstream (needs the network)
```
