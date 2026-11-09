import { loadConfig, allLatest, NOW } from './ripe-fixtures.mjs';
import { normalize } from '../../src/adapters/ripe-atlas-ping.mjs';
import { curateHome } from '../../src/curate.mjs';
import { loadSchema } from '../../src/contract.mjs';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
export const SCHEMA = loadSchema(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'internet-model.v1.schema.json'));
export const isoZ = (s) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
export const clone = (o) => JSON.parse(JSON.stringify(o));
export function subsetConfig(ids) { const c = loadConfig(); c.nodes = c.nodes.filter((n) => ids.includes(n.id)); return c; }
export function makeDataset({ config = loadConfig(), q, perNode, now = NOW, permission = 'pending' } = {}) {
  return normalize(allLatest(config, { now, q, perNode }), config, { generatedAt: now, fetchedAt: isoZ(now - 23), permissionStatus: permission });
}
export const makeModel = (opts) => { const dataset = makeDataset(opts); return { dataset, home: curateHome(dataset) }; };
