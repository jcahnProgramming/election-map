import { test } from 'node:test';
import assert from 'node:assert/strict';

test('AK: the feed names measures by petition number only; they resolve to the official Ballot Measure 2 / 3 entries', async () => {
  const { findMeasureInfo, resetMeasureInfo, publicInfo } = await import('../src/measureinfo.js');
  resetMeasureInfo();
  const m2 = findMeasureInfo('2026-general', 'AK', 'BM#2 24ESEG', 'BM#2 24ESEG');
  const m3 = findMeasureInfo('2026-general', 'AK', 'BM#3 25USCV', 'BM#3 25USCV');
  assert.equal(m2?.measure_id, 'Ballot Measure 2');
  assert.equal(m3?.measure_id, 'Ballot Measure 3');
  assert.equal(publicInfo(m3).officialTitle.value, 'United States Citizens Voter Act');
  assert.match(publicInfo(m2).officialTitle.value, /^An Act to repeal a nonpartisan and open top four Primary/);
});
