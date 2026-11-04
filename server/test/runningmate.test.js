// Joint tickets (FL Governor / Lt. Governor): the running mate is stored in candidates.running_mate and served as
// runningMate; the headline name stays the top of the ticket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, writeSnapshot } from '../src/db.js';
import { createResults } from '../src/results.js';

test('running mate is stored and served; candidates without one have no runningMate field', () => {
  const db = openDb(':memory:');
  writeSnapshot(db, {
    source: 'fake', fetchedAt: '2026-11-04T01:30:00Z', version: '1',
    election: { sourceKey: 'FL/1', state: 'FL', scope: 'state', name: 'FL' },
    races: [{ office: 'governor', key: 'GOV', name: 'Governor and Lieutenant Governor',
      choices: [{ name: 'Byron Donalds', party: 'REP', partyRaw: 'REP', runningMate: 'Bryan Avila' },
        { name: 'David Jolly', party: 'DEM', partyRaw: 'DEM', runningMate: 'Gwen Graham' },
        { name: 'Write-in', party: 'OTHER', partyRaw: 'WRI' }],
      units: [{ level: 'state', name: 'FL', votes: [3875246, 3838531, 0] }] }],
  });
  assert.deepEqual(db.prepare('SELECT name, running_mate FROM candidates ORDER BY position').all(),
    [{ name: 'Byron Donalds', running_mate: 'Bryan Avila' }, { name: 'David Jolly', running_mate: 'Gwen Graham' }, { name: 'Write-in', running_mate: null }]);
  const res = createResults(db, [{ id: 'fake', name: 'Fake', targets: () => [] }]);
  const st = res.state('FL', 'governor');
  const c = st.statewide.candidates;
  assert.deepEqual(c.map((x) => [x.name, x.runningMate]), [['Byron Donalds', 'Bryan Avila'], ['David Jolly', 'Gwen Graham'], ['Write-in', undefined]]);
  assert.equal(st.statewide.leader, 'REP');
});
