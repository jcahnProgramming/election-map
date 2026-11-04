import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageCopy, OFFICIAL_LINK_TEXT } from '../src/calc.js';
import { shade, legendItems } from '../src/shading.js';

test('reason-based copy for states without live results; never blames the state', () => {
  assert.deepEqual(coverageCopy('blocked'), { title: "Live results aren't available here.", detail: "This state's results site doesn't allow automated access." });
  assert.deepEqual(coverageCopy('no_feed'), { title: "Live results aren't available here.", detail: "This state doesn't publish statewide results in a form we can read live." });
  assert.deepEqual(coverageCopy('planned'), { title: 'Live results coming soon.', detail: "We haven't connected this state's official results yet." });
  assert.equal(coverageCopy(undefined).title, 'Live results coming soon.');
  assert.equal(OFFICIAL_LINK_TEXT, 'View official results ↗');
  for (const s of ['blocked', 'no_feed', 'planned']) assert.ok(!/fail|refus|won't|broken|fault/i.test(Object.values(coverageCopy(s)).join(' ')));
});

test('hatched "No live results here" for a race we have no source for', () => {
  const s = shade({ status: 'no-source' });
  assert.equal(s.label, 'No live results here');
  assert.match(s.fill, /url\(#/);
  if (typeof legendItems === 'function') assert.ok(legendItems().some((i) => i.label === 'No live results here'));
});
