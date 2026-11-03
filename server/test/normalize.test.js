import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyContest, normalizeParty } from '../src/normalize.js';

const cases = {
  // senate
  'United States Senator': ['senate', null], 'U. S. SENATOR': ['senate', null], 'FOR UNITED STATES SENATOR': ['senate', null],
  'US Senator 6 YR': ['senate', null], 'U.S. SENATOR': ['senate', null], 'For U.S. Senator (Unexpired term ending 1-3-2029)': ['senate', null],
  // governor
  'Governor / Lieutenant Governor': ['governor', null], 'Governor and Lt. Governor': ['governor', null], 'GOV. AND LT. GOV': ['governor', null],
  'Governor/Lt. Governor': ['governor', null], 'FOR GOVERNOR AND LIEUTENANT GOVERNOR': ['governor', null], 'Governor': ['governor', null],
  // house
  'Representative to the 120th United States Congress - District 1': ['house', '1'], 'United States Representative District 3': ['house', '3'],
  'U.S. Representative in Congress Dist. 2': ['house', '2'], 'FOR REPRESENTATIVE IN CONGRESS THIRD CONGRESSIONAL DISTRICT': ['house', '3'],
  'REP. IN CONGRESS D13': ['house', '13'], 'Representative in Congress 2nd District': ['house', '2'], 'Congress Dist. 1': ['house', '1'],
  'United States House of Representatives': ['house', null], 'U.S. Representative 7th': ['house', '7'], 'REPRESENTATIVE IN CONGRESS 17TH DISTRICT': ['house', '17'],
  'United States Representative, District 13': ['house', '13'], 'US Representative 16': ['house', '16'], 'U. S. REPRESENTATIVE DISTRICT 1': ['house', '1'],
  'For Representative to Congress (8th District)': ['house', '8'], 'US Representative, District 5': ['house', '5'],
};
const ignored = ['Lieutenant Governor', 'LIEUTENANT GOVERNOR', 'State Senator - District 1', 'State Representative, District 57',
  'SENATOR IN THE GENERAL ASSEMBLY 46TH DISTRICT', 'Representative in the General Assembly 51st District',
  'State Board of Education Member - Congressional District 1', 'Regent of the University of Colorado - Congressional District 2',
  'Secretary of State', 'Governor of Wayne State University', 'FOR STATE SENATOR TWENTY-FIRST LEGISLATIVE DISTRICT'];

test('classifies federal contests across naming styles', () => {
  for (const [name, [office, district]] of Object.entries(cases)) {
    assert.deepEqual(classifyContest(name), { office, district }, name);
  }
});
test('ignores state-level and lieutenant contests', () => {
  for (const name of ignored) assert.equal(classifyContest(name, ['A', 'B']), null, name);
});
test('measures are yes/no contests, judicial retention is not', () => {
  assert.deepEqual(classifyContest('Amendment 81 (CONSTITUTIONAL)', ['Yes/For', 'No/Against']), { office: 'measure', district: null });
  assert.equal(classifyContest('Justice of the Colorado Supreme Court - Smith', ['Yes', 'No']), null);
});
test('party labels', () => {
  assert.equal(normalizeParty('DEM').party, 'DEM');
  assert.equal(normalizeParty('Democratic-Farmer-Labor').party, 'DEM');
  assert.equal(normalizeParty('REP').party, 'REP');
  assert.deepEqual(normalizeParty('LBR'), { party: 'OTHER', known: true });
  assert.deepEqual(normalizeParty('Whig'), { party: 'OTHER', known: false });
  assert.deepEqual(normalizeParty(''), { party: 'OTHER', known: true });
});
