// Every researched ballot-measure file must follow docs/measures-data.md: a missing value is fine, an unsourced one is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'elections');
const files = existsSync(base)
  ? readdirSync(base).flatMap((ek) => {
    const d = path.join(base, ek, 'measures');
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f)) : [];
  })
  : [];

const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);
const sourced = (x, where) => {
  if (x == null || x.value == null) return;
  assert.ok(isUrl(x.source_url), `${where}: a value without an official source_url`);
};

test('measure files: valid, every value sourced, gated values carry `reviewed`', () => {
  assert.ok(files.length > 0, 'no measure files found');
  for (const file of files) {
    const rel = path.relative(base, file);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    assert.match(path.basename(file), /^[A-Z]{2}\.json$/, rel);
    assert.ok(Array.isArray(doc.measures), `${rel}: measures must be a list`);
    const ids = new Set();
    for (const m of doc.measures) {
      const at = `${rel} ${m.measure_id}`;
      assert.ok(m.measure_id, `${rel}: measure without measure_id`);
      assert.ok(!ids.has(m.measure_id), `${at}: duplicate measure_id`);
      ids.add(m.measure_id);
      assert.ok(m.official_title?.value, `${at}: official_title is required`);
      for (const k of ['official_title', 'official_summary', 'opposition_committee_name']) sourced(m[k], `${at} ${k}`);
      if (m.full_text?.value) assert.ok(isUrl(m.full_text.source_url), `${at} full_text: no source_url`);
      if (m.full_text?.url) assert.ok(isUrl(m.full_text.url), `${at} full_text.url`);
      if (m.placed_by) {
        assert.ok(['initiative', 'legislative_referral', 'other'].includes(m.placed_by.type), `${at}: placed_by.type`);
        assert.ok(isUrl(m.placed_by.source_url), `${at}: placed_by without source_url`);
      }
      for (const k of ['proponent_website', 'opposition_website']) {
        if (m[k]?.value == null) continue;
        sourced(m[k], `${at} ${k}`);
        assert.equal(typeof m[k].reviewed, 'boolean', `${at} ${k}: needs a reviewed flag`);
      }
      for (const p of m.party_positions ?? []) {
        assert.ok(p.party, `${at}: party position without a party`);
        assert.ok(['support', 'oppose', 'no_position'].includes(p.position), `${at}: position ${p.position}`);
        assert.ok(isUrl(p.source_url), `${at} ${p.party}: position without the party's own source`);
        assert.equal(typeof p.reviewed, 'boolean', `${at} ${p.party}: needs a reviewed flag`);
      }
      if (m.legislative_vote) {
        assert.ok(Array.isArray(m.legislative_vote.chambers) && m.legislative_vote.chambers.length, `${at}: legislative_vote.chambers`);
        assert.ok(isUrl(m.legislative_vote.roll_call_url) || isUrl(m.legislative_vote.source_url), `${at}: roll call without a source`);
        for (const c of m.legislative_vote.chambers) {
          assert.ok(c.chamber && Number.isInteger(c.yes) && Number.isInteger(c.no), `${at}: chamber ${JSON.stringify(c).slice(0, 80)}`);
        }
      }
    }
  }
});
