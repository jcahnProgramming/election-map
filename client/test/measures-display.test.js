import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionDisplay, websiteLabel, displayDomain } from '../src/calc.js';

test('party positions: Support / Oppose / Neutral, and "No published position" when nothing is reviewed', () => {
  assert.equal(positionDisplay('support').label, 'Support');
  assert.equal(positionDisplay('oppose').label, 'Oppose');
  assert.equal(positionDisplay('no_position').label, 'Neutral');
  assert.equal(positionDisplay(null).label, 'No published position');
  assert.equal(positionDisplay(undefined).label, 'No published position');
  // Neutral position colours, never party blue / red.
  for (const p of ['support', 'oppose', 'no_position', null]) assert.ok(!['#4F86F7', '#EF5B5B'].includes(positionDisplay(p).color));
});

test('campaign websites: labelled by side, plain "Campaign website" when the side is unclear', () => {
  assert.equal(websiteLabel({ side: 'support' }), 'Yes campaign');
  assert.equal(websiteLabel({ side: 'oppose' }), 'No campaign');
  assert.equal(websiteLabel({ side: null }), 'Campaign website');
  assert.equal(displayDomain('https://www.CAFairElections.org'), 'www.CAFairElections.org');
  assert.equal(displayDomain('https://voteyeson37.com/'), 'voteyeson37.com');
});
