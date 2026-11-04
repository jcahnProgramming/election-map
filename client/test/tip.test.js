import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tipPosition, tipWidthBounds, isSheetWidth, TIP_MIN, TIP_MAX } from '../src/tip.js';

test('tooltip width: 320–420 px, shrunk to fit narrow viewports', () => {
  assert.equal(TIP_MIN, 320);
  assert.equal(TIP_MAX, 420);
  assert.deepEqual(tipWidthBounds(1440), [320, 420]);
  assert.deepEqual(tipWidthBounds(400), [320, 384]);
  assert.deepEqual(tipWidthBounds(300), [284, 284]);
});

test('tooltip position: beside the pointer, flipped and clamped inside the viewport', () => {
  const vw = 1280, vh = 800, w = 380, h = 300;
  assert.deepEqual(tipPosition({ x: 100, y: 100, w, h, vw, vh }), { left: 116, top: 116 });
  // Near the right edge: flips to the left of the pointer.
  assert.deepEqual(tipPosition({ x: 1200, y: 100, w, h, vw, vh }), { left: 1200 - 16 - w, top: 116 });
  // Near the bottom: flips above.
  assert.deepEqual(tipPosition({ x: 100, y: 700, w, h, vw, vh }), { left: 116, top: 700 - 16 - h });
  // Taller than the space either side: clamped to the margin, never off screen.
  const p = tipPosition({ x: 640, y: 400, w, h: 790, vw, vh });
  assert.equal(p.top, 8);
  for (let x = 0; x <= vw; x += 40) {
    const q = tipPosition({ x, y: 300, w: TIP_MAX, h, vw, vh });
    assert.ok(q.left >= 8 && q.left + TIP_MAX <= vw - 8, `x=${x}`);
  }
});

test('phone width shows a bottom sheet', () => {
  assert.equal(isSheetWidth(390), true);
  assert.equal(isSheetWidth(640), true);
  assert.equal(isSheetWidth(641), false);
});
