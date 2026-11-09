// Publication gate: decides whether a site tree may be produced, and produces it. Pure: returns files, never writes.
// A failed gate throws GateFailure and the workflow stops BEFORE deploy, so the previous deployment stays online.
import { validateDocument } from './contract.mjs';
import { curateHome, controlDocument } from './curate.mjs';

export class GateFailure extends Error { constructor(code, message, details = []) { super(message); this.name = 'GateFailure'; this.code = code; this.details = details; } }
export const EXIT = { ok: 0, gate: 2, permission: 3, collection: 4 };
const MAX_HOME_BYTES = 32 * 1024, MIN_PAIR_SHARE = 0.5;
const json = (o) => JSON.stringify(o) + '\n';

// control-only: the kill switch. Needs no provider call and no dataset; works even if the provider is down.
export function buildControlOnlySite({ schemaText, controlConfig, nowIso, schema }) {
  const control = controlDocument({ ...controlConfig, enabled: false }, nowIso), errs = validateDocument(schema, control);
  if (errs.length) throw new GateFailure('validation', 'control document invalid', errs);
  return { mode: 'control-only', files: new Map([['v1/control.json', json(control)], ['v1/schema/internet-model.json', schemaText], ['robots.txt', 'User-agent: *\nDisallow: /\n']]), report: { pairs: 0 } };
}

export function permissionGate(publication, dataset) {
  const status = publication.permission_status, provider = dataset.provenance.provider.id;
  if (status === 'pending') throw new GateFailure('permission', 'publication permission is pending: derived data must not be published', [`config/publication.json permission_status=${status}`]);
  if (status === 'synthetic' && provider !== 'fixture') throw new GateFailure('permission', "permission_status 'synthetic' may only publish provider 'fixture'", [`provider=${provider}`]);
  if ((status === 'granted' || status === 'not_required') && provider === 'fixture') throw new GateFailure('permission', 'a fixture dataset must not be published as real data', [`provider=${provider}`]);
  if (!['granted', 'not_required', 'synthetic'].includes(status)) throw new GateFailure('permission', `unknown permission_status ${JSON.stringify(status)}`);
  if (dataset.provenance.publication.permission_status !== status) throw new GateFailure('permission', 'dataset permission_status differs from config/publication.json', [dataset.provenance.publication.permission_status, status]);
}

export function buildSite({ schema, schemaText, controlConfig, publication, dataset, nowIso }) {
  if (controlConfig.enabled !== true) return buildControlOnlySite({ schemaText, controlConfig, nowIso, schema });
  if (!dataset) throw new GateFailure('validation', 'a dataset is required when the feature is enabled');
  permissionGate(publication, dataset);
  const dErr = validateDocument(schema, dataset); if (dErr.length) throw new GateFailure('validation', 'dataset failed strict validation', dErr);
  const home = curateHome(dataset), hErr = validateDocument(schema, home, { dataset }); if (hErr.length) throw new GateFailure('validation', 'home view failed strict validation', hErr);
  const control = controlDocument(controlConfig, nowIso), cErr = validateDocument(schema, control); if (cErr.length) throw new GateFailure('validation', 'control failed strict validation', cErr);
  const c = home.coverage; if (c.pairs_published < Math.ceil(MIN_PAIR_SHARE * c.pairs_expected)) throw new GateFailure('quality', `only ${c.pairs_published} of ${c.pairs_expected} pairs have data (minimum ${Math.ceil(MIN_PAIR_SHARE * c.pairs_expected)})`);
  const homeText = json(home); if (Buffer.byteLength(homeText) > MAX_HOME_BYTES) throw new GateFailure('quality', `home view is ${Buffer.byteLength(homeText)} bytes, above the ${MAX_HOME_BYTES} byte cap`);
  return { mode: 'publish', files: new Map([['v1/control.json', json(control)], ['v1/views/home.json', homeText], ['v1/schema/internet-model.json', schemaText], ['robots.txt', 'User-agent: *\nDisallow: /\n']]), report: { pairs: home.pairs.length, gaps: home.gaps.length, homeBytes: Buffer.byteLength(homeText) }, dataset, home, control };
}
