# Contracts (v1)

One shared, versioned model for the homepage globe and a future dashboard. `contracts/internet-model.v1.schema.json` is the source of truth (JSON Schema 2020-12). `src/contract.mjs` validates it, plus the rules JSON Schema cannot express.

## Documents

| Schema name | Purpose | Published in Gate 2 |
|---|---|---|
| `lateeflaw.internet-dataset` | Rich normalized model: every directed observation, raw first and last observation times, measurement and probe IDs, quality indicators, provenance, coverage | No (validated in CI, kept as a short-lived artifact) |
| `lateeflaw.home-view` | Curated subset for the homepage | Yes, once permission is clear |
| `lateeflaw.internet-control` | Kill switch shared by every consumer | Yes |
| `lateeflaw.internet-catalog` | Index of datasets and views for the dashboard | Later |

## Strict and tolerant validation

Collector CI validates in **strict** mode: an unknown field is an error, and no string may contain an IPv4 or IPv6 literal. Strict mode is the privacy control. Browsers validate in **tolerant** mode: unknown fields are ignored and unknown observation types are skipped, so a minor version can add fields without breaking old pages. A different major version is rejected.

## Reducing 90 directed observations to the 45-pair home view

The home view keeps one direction per unordered pair. What is preserved, and checked against the dataset by `validateDocument(..., { dataset })`:

| Preserved | How |
|---|---|
| **Direction** | Every kept pair is an observation that exists in the dataset exactly as `src > dst`. It is never mirrored, averaged or merged |
| **Which direction** | The one with the most recent last-observation time; ties go to the smaller observation id |
| **Timestamps** | `observed_first` and `observed` are the raw first and last result times of that observation |
| **Provenance** | `measurement_id` and `probe_id` of that observation |
| **Quality** | `quality` level and `flags` of that observation |
| **Missing data** | `reverse` says whether the other direction has a usable observation (`present` or `missing`); `gaps` lists unordered pairs with no usable observation in either direction; `coverage` counts directed and unordered pairs. Nothing disappears silently |

## Freshness

The consumer computes two clocks from the document: publication age (now minus `generated_at`) and each pair's measurement age (now minus `observed`). Pair classes: recent up to 75 minutes, aging up to 3 hours, old up to 24 hours, expired beyond that. Page states: RECENT, AGING, OLD, EXPIRED, plus a clock-suspect case. The wording is "Recent measurements", never "Live". See `GATE1-REFINEMENT.md` in the website review pack for the full table.

## Adding another provider later (not built)

A new adapter supplies a provider block (terms, attribution, its own permission status), `plan`, `fetch` and `normalize` functions that return endpoints and observations of new kinds and types, and request limits. It is an additive minor version: new `endpoint.kind` and observation `type` values. Browsers skip types they do not know. Each provider has its own permission gate.
