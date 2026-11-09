# Operations

Status: local development only. No GitHub repository exists, nothing is deployed, nothing is scheduled. Everything below describes how the system is meant to run once the owner creates the repository (Gate 2B).

## What runs

`.github/workflows/collect-and-deploy.yml` runs `node --test`, then `node src/collect.mjs --out site`, then deploys `site/` with the custom Pages workflow. It runs twice an hour (minutes 17 and 47), on manual dispatch, and on any push that touches `config/`, `src/`, `contracts/` or the workflow itself. No commits are made and no secrets are used.

`src/collect.mjs` behaves as follows:

| Situation | Result |
|---|---|
| `config/control.json` has `enabled: false` | Builds a control-only site (the kill switch). **No provider request is made.** Exit 0 |
| `config/publication.json` is `pending` | Refuses **before any provider request**. Exit 3 |
| Provider unreachable, a second 429, request budget reached | Writes nothing. Exit 4. The job fails before deploy, so the previous deployment stays online |
| A validation gate fails (schema, leak scan, direction, coverage) or fewer than half the pairs have data | Writes nothing. Exit 2 |
| Everything passes | Writes `site/v1/control.json`, `site/v1/views/home.json`, `site/v1/schema/internet-model.json`, `site/robots.txt` |

The normalized dataset (all 90 directed observations) is validated and kept only as a 7-day CI artifact. It is not published until the dashboard phase.

## Publication gate

`config/publication.json` holds `permission_status`:

| Value | Meaning |
|---|---|
| `pending` | RIPE NCC has not answered. Nothing derived from RIPE may be published. This is the committed default |
| `granted`, `not_required` | RIPE NCC answered in writing. RIPE-derived views may be published |
| `synthetic` | Only the clearly simulated `fixture` provider may be published (used to rehearse Pages without any RIPE-derived data) |

Do not change this file without the RIPE NCC's written answer. The gate is enforced in code and covered by tests and mutation proofs.

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
| Actions | Default workflow permission can stay read-only: the deploy job declares `pages: write` and `id-token: write` itself. Confirm in Gate 2B that this is not blocked. Enable "Require actions to be pinned to a full-length commit SHA" |
| Environment | `github-pages` is created automatically; add a deployment rule so only `main` can deploy |
| Push | Your existing git credential, only after you authorize it |
| Re-verify | Every `uses:` SHA in the workflow, against the actions' current releases |

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
npm test                      # every test (97 data-side tests at the time of writing)
node src/collect.mjs --dry-run   # about 10 anonymous requests to the RIPE Atlas API; writes out/ only, never a site tree
node scripts/mutation-proof.mjs  # breaks one rule at a time in a copy and requires the suite to fail
```
