// Statewide Clarity sites publish no precinct-reporting figure. Snapshots stored before 0.5.4 still carry precinct
// counts derived from details.json (Colorado: 1542 / 4230 = "37% in"); the API must never serve them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, writeSnapshot } from '../src/db.js';
import { createResults } from '../src/results.js';

const cand = (name, party) => ({ name, party, partyRaw: party });
function legacy(source = 'clarity') {
  const db = openDb(':memory:');
  writeSnapshot(db, {
    source, fetchedAt: '2026-11-04T03:31:00Z', version: '384788', sourceUpdatedAt: '2026-11-04T03:30:56Z',
    election: { sourceKey: 'CO/127407', state: 'CO', scope: 'state', name: 'CO' },
    turnout: [{ level: 'state', name: 'CO', registered: 4085721, ballotsCast: 1981127, turnoutPct: 48.49, precinctsReporting: 1544, precinctsTotal: 4297 }],
    races: [
      { office: 'senate', key: '1', name: 'United States Senator', choices: [cand('John Hickenlooper', 'DEM'), cand('Mark Baisley', 'REP')],
        units: [
          { level: 'state', name: 'CO', votes: [1177544, 671760], precinctsReporting: 1542, precinctsTotal: 4230, pctReporting: 36.5 },
          { level: 'county', countyFips: '08031', name: 'Denver', votes: [300000, 60000], precinctsReporting: 300, precinctsTotal: 400, pctReporting: 75 },
        ] },
      { office: 'measure', key: '9', name: 'Amendment 80', statewide: true, choices: [cand('Yes/For', 'OTHER'), cand('No/Against', 'OTHER')],
        units: [{ level: 'state', name: 'CO', votes: [800000, 900000], yes: 800000, no: 900000, precinctsReporting: 1542, precinctsTotal: 4230, pctReporting: 36.5 }] },
    ],
  });
  return createResults(db, [{ id: source, name: source, targets: () => [] }]);
}

test('legacy statewide Clarity snapshot: precinct fields are served null everywhere (state, county, national, contests, measures, turnout)', () => {
  const res = legacy();
  const st = res.state('CO', 'senate');
  assert.deepEqual([st.statewide.pctReporting, st.statewide.precinctsReporting, st.statewide.precinctsTotal], [null, null, null]);
  const denver = st.counties.find((c) => c.fips === '08031');
  assert.deepEqual([denver.pctReporting, denver.precinctsReporting, denver.precinctsTotal], [null, null, null]);
  assert.deepEqual([st.statewide.turnout.precinctsReporting, st.statewide.turnout.precinctsTotal], [null, null]);
  assert.equal(st.statewide.turnout.ballotsCast, 1981127); // the ballots-cast line stays
  assert.equal(st.statewide.countiesTotal, undefined); // legacy snapshot: no county counts yet, so no reporting figure at all
  const n = res.national('senate').states.find((s) => s.state === 'CO');
  assert.deepEqual([n.pctReporting, n.precinctsReporting, n.precinctsTotal], [null, null, null]);
  const contests = res.contests('CO');
  const rows = contests.contests ?? contests.groups?.flatMap((g) => g.contests ?? g.rows ?? []) ?? [];
  for (const c of rows) assert.equal(c.pctReporting ?? null, null, c.name);
  const m = res.measures('CO').measures.find((x) => /Amendment 80/.test(x.name));
  assert.equal(m.pctReporting, null);
  assert.equal(m.yes, 800000); // counts untouched
});

test('the same snapshot from a source that publishes precincts keeps them', () => {
  const st = legacy('ncsbe').state('CO', 'senate');
  assert.equal(st.statewide.pctReporting, 36.5);
  assert.equal(st.statewide.precinctsTotal, 4230);
});
