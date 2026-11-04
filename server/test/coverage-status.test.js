// config/coverage-status.json says why each state does or doesn't have live results. It must cover every state, use
// only the known statuses, and agree with the adapters: a state is "live" exactly when an enabled statewide target polls it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES } from '../src/geo.js';
import { loadAdapters } from '../src/adapters/index.js';
import { COVERAGE_STATUSES } from '../src/results.js';

const cfg = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'coverage-status.json'), 'utf8'));

test('coverage status: every state, known statuses only', () => {
  for (const s of STATES) {
    const c = cfg.states[s.abbr];
    assert.ok(c, `${s.abbr} missing`);
    assert.ok(COVERAGE_STATUSES.includes(c.status), `${s.abbr}: ${c.status}`);
  }
  assert.equal(Object.keys(cfg.states).length, STATES.length);
});

test('coverage status: "live" exactly when an enabled statewide adapter target polls the state', async () => {
  const adapters = await loadAdapters();
  const polled = new Set(adapters.flatMap((a) => a.targets()).filter((t) => t.scope === 'state' && t.enabled !== false).map((t) => t.state));
  for (const s of STATES) {
    const live = cfg.states[s.abbr].status === 'live';
    assert.equal(live, polled.has(s.abbr), `${s.abbr}: coverage-status says ${cfg.states[s.abbr].status} but statewide adapter ${polled.has(s.abbr) ? 'exists' : 'does not exist'} (flip it in config/coverage-status.json with the adapter change)`);
  }
});
