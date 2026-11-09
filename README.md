# internet-data

Collects public Internet measurements, normalizes them into one validated model and publishes small static views for lateeflaw.info (a homepage globe now, an Internet Intelligence Dashboard at `/intelligence/` later).

**Status: local development only (Gate 2A).** There is no GitHub repository, no remote, no deployment, no schedule. Nothing derived from RIPE Atlas may be published until the RIPE NCC has answered in writing (`config/publication.json`).

- `contracts/` the versioned JSON Schema
- `src/` adapter (RIPE Atlas ping), normalization, curation, publication gate, guarded HTTP, collector CLI
- `config/` the ten anchors, the kill switch, the publication permission
- `test/` synthetic RIPE-shaped fixtures only; no real measurement data is stored here
- `docs/OPERATIONS.md` how it runs, the kill switch and its drill, setup permissions
- `docs/CONTRACTS.md` the model and the 90-to-45 reduction rules

```
npm test
```

No dependencies: Node 20 or newer, built-in modules only.
