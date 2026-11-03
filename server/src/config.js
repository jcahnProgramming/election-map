import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_DIR = process.env.CONFIG_DIR ?? path.join(ROOT, 'config');

const changelog = JSON.parse(readFileSync(path.join(ROOT, 'CHANGELOG.json'), 'utf8'));

export const config = {
  port: Number(process.env.PORT ?? 3710),
  dataDir: process.env.DATA_DIR ?? path.join(ROOT, 'data'),
  pollIntervalMs: Math.max(15, Number(process.env.POLL_INTERVAL_SECONDS ?? 60)) * 1000,
  maxBackoffMs: 10 * 60 * 1000,
  userAgent: `election-map/${changelog.releases?.[0]?.version ?? '0'} (live public results dashboard; +https://election.jamiecahn.com)`,
  version: changelog.releases?.[0]?.version ?? '0.0.0',
  clientDist: path.join(ROOT, 'client', 'dist'),
};

/** Read a JSON file under config/, or a fallback when it doesn't exist. */
export function readConfig(rel, fallback) {
  const p = path.join(CONFIG_DIR, rel);
  if (!existsSync(p)) return fallback;
  return JSON.parse(readFileSync(p, 'utf8'));
}
