/**
 * Gear counter v2 on drawn gears (no photo files needed). Run with plain node (jest runs these loops far slower):
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs --test mobile/__tests__/v2.synthetic.test.mjs
 * Accuracy on real photos is measured by v2.corpus.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { countTeethV2 } from '../src/algorithm/gearCounterV2.js';

/** Dark gear on bright paper. tilt = minor/major axis ratio of the outline (1 = camera straight above). */
function drawGear({ size = 640, teeth, cx = size / 2, cy = size / 2, tipR = 0.3 * size, tilt = 1, lobeDepth = null }) {
  const rgba = new Uint8Array(size * size * 4);
  const depth = lobeDepth ?? Math.min(0.28 * tipR, (2 * Math.PI * tipR / teeth) * 0.55);   // chain teeth: height about half the pitch
  let seed = 12345;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff - 0.5) * 8; };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = (y - cy) / tilt;
      const rho = Math.hypot(dx, dy), phase = ((Math.atan2(dy, dx) / (2 * Math.PI)) * teeth % 1 + 1) % 1;
      // one tooth per period: flat tip (30 %), linear flanks, flat root
      const t = phase < 0.3 ? 1 : phase < 0.5 ? 1 - (phase - 0.3) / 0.2 : phase < 0.8 ? 0 : (phase - 0.8) / 0.2;
      const inside = rho < tipR - depth * (1 - t) && rho > 0.45 * tipR;
      const v = (inside ? 70 : 225) + noise() + 10 * (x / size);       // slight light gradient
      const i = (y * size + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = Math.max(0, Math.min(255, v)); rgba[i + 3] = 255;
    }
  }
  return { rgba, size };
}

for (const c of [
  { teeth: 11 }, { teeth: 15, cx: 250, cy: 380 }, { teeth: 24, tipR: 150 }, { teeth: 36, tilt: 0.9 }, { teeth: 52, tipR: 260 },
]) {
  test(`counts ${c.teeth} teeth${c.tilt ? ' (tilted)' : ''}`, () => {
    const g = drawGear(c);
    const r = countTeethV2(g.rgba, g.size, g.size);
    assert.equal(r.toothCount, c.teeth, JSON.stringify(r.diag));
    assert.equal(r.abstainReason, null);
    assert.ok(r.confidence > 0.5);
  });
}

test('blank paper: abstains with no-gear', () => {
  const rgba = new Uint8Array(400 * 400 * 4).fill(230);
  const r = countTeethV2(rgba, 400, 400);
  assert.equal(r.toothCount, 0);
  assert.equal(r.abstainReason, 'no-gear');
});

test('gear half outside the frame: abstains, does not guess', () => {
  const g = drawGear({ teeth: 24, cx: 620, tipR: 250 });
  const r = countTeethV2(g.rgba, g.size, g.size);
  assert.equal(r.toothCount, 0);
  assert.ok(['cut-off', 'unclear', 'no-gear', 'not-teeth'].includes(r.abstainReason), r.abstainReason);
});

test('shallow lobes (spider arms, not chain teeth): abstains with not-teeth', () => {
  const g = drawGear({ teeth: 9, lobeDepth: 12 });
  const r = countTeethV2(g.rgba, g.size, g.size);
  assert.equal(r.toothCount, 0);
  assert.equal(r.abstainReason, 'not-teeth');
});
