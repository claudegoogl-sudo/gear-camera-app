/**
 * PAP-1611 — PAP-1583 Small/Mid/Large re-baseline on backfill pairs under
 * cropped geometry (HEAD vs 86b4458^).  Measurement only; no algorithm
 * changes.  Sibling of pap1609.xl_rebaseline.js — same pipeline, slice
 * discovery filter swapped.
 *
 * Slice bands (per PAP-1052 audit memory; PAP-1612 spec):
 *   small : actual ∈ [10, 13]
 *   mid   : actual ∈ [14, 19]
 *   large : actual ∈ [20, 28]
 *
 * Modes (env):
 *   SLICE=small|mid|large MODE=measure COMMIT_LABEL=head|prev   — runs the
 *     algorithm on every <slice> backfill pair and emits per-row JSON to
 *     debug-reports/pap1611_<slice>_<label>_rows_2026-05-20.json.
 *   SLICE=small|mid|large MODE=merge — joins head+prev JSONs on tdStamp,
 *     emits AC1 CSV (pap1611_<slice>_rebaseline_2026-05-20.csv) + AC2 tally
 *     + AC3 verdict (HOLD / REOPEN / AMBIGUOUS) to
 *     pap1611_<slice>_rebaseline_summary_2026-05-20.json.
 *
 * Pairing window: ≤30s. Tolerance: tol=0 strict. Confidence band advisory
 * |Δconf|≤0.10. PAP-1611 AC3 sign convention: PAP-1583 on-record S/M/L
 * deltas were negative — REOPEN ⇔ Δ ≤ −5pp confirms the bisect direction.
 */
jest.mock('expo-file-system/legacy', () => ({}), { virtual: true });
jest.mock('expo-image-manipulator', () => ({}), { virtual: true });

const fs = require('fs');
const path = require('path');
const { decode } = require('jpeg-js');
const runner = require('./lib/harness-runner');
runner.silenceConsole();

const TD = path.resolve(__dirname, '..', '..', 'training-data');
const DR = path.resolve(__dirname, '..', '..', 'debug-reports');
const TARGET = 900;
const PAIR_WINDOW_MS = 30_000;

const SLICE_BANDS = {
  small: { lo: 10, hi: 13 },
  mid:   { lo: 14, hi: 19 },
  large: { lo: 20, hi: 28 },
};

const SLICE = (process.env.SLICE || '').toLowerCase();
if (!SLICE_BANDS[SLICE]) {
  throw new Error(`PAP-1611: env SLICE must be one of small|mid|large (got ${JSON.stringify(SLICE)})`);
}
const { lo: SLICE_LO, hi: SLICE_HI } = SLICE_BANDS[SLICE];

const MODE = (process.env.MODE || 'measure').toLowerCase();
const COMMIT_LABEL = (process.env.COMMIT_LABEL || 'head').toLowerCase();
const HEAD_JSON = path.join(DR, `pap1611_${SLICE}_head_rows_2026-05-20.json`);
const PREV_JSON = path.join(DR, `pap1611_${SLICE}_prev_rows_2026-05-20.json`);
const OUT_CSV = path.join(DR, `pap1611_${SLICE}_rebaseline_2026-05-20.csv`);
const OUT_SUMMARY = path.join(DR, `pap1611_${SLICE}_rebaseline_summary_2026-05-20.json`);

function toMs(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

function discoverSlicePairs() {
  const drDirs = [];
  for (const d of fs.readdirSync(DR).sort()) {
    if (!d.startsWith('report_')) continue;
    const p = path.join(DR, d);
    let files;
    try { files = new Set(fs.readdirSync(p)); } catch { continue; }
    if (!files.has('cropped.jpg') || !files.has('report.json')) continue;
    const stamp = d.replace('report_', '');
    const ms = toMs(stamp);
    if (ms != null) drDirs.push({ dir: d, stamp, ms });
  }
  drDirs.sort((a, b) => a.ms - b.ms);

  const tdStamps = [];
  for (const f of fs.readdirSync(TD).sort()) {
    const m = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}Z)_meta\.json$/.exec(f);
    if (!m) continue;
    const stamp = m[1];
    const ms = toMs(stamp);
    if (ms != null) tdStamps.push({ stamp, ms });
  }
  tdStamps.sort((a, b) => a.ms - b.ms);
  const tdKeys = tdStamps.map((x) => x.ms);

  const pairs = [];
  for (const dr of drDirs) {
    let lo = 0, hi = tdKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tdKeys[mid] < dr.ms) lo = mid + 1; else hi = mid;
    }
    let best = null;
    for (const i of [lo - 1, lo]) {
      if (i < 0 || i >= tdStamps.length) continue;
      const d = Math.abs(tdStamps[i].ms - dr.ms);
      if (best == null || d < best.d) best = { td: tdStamps[i], d };
    }
    if (best && best.d <= PAIR_WINDOW_MS) {
      const actual = readActual(best.td.stamp);
      if (actual >= SLICE_LO && actual <= SLICE_HI) {
        pairs.push({ dr, td: best.td, deltaMs: best.d, actual });
      }
    }
  }
  return pairs;
}

function readActual(stamp) {
  const p = path.join(TD, `${stamp}_meta.json`);
  try {
    const raw = fs.readFileSync(p, 'utf8').replace(/[^\x00-\x7F]+/g, '?');
    const m = JSON.parse(raw);
    return Number(m.actual_tooth_count || m.actualTeethCount || 0) || 0;
  } catch { return 0; }
}

function readBuild(drStamp) {
  try {
    const rep = JSON.parse(fs.readFileSync(path.join(DR, `report_${drStamp}`, 'report.json'), 'utf8').replace(/[^\x00-\x7F]+/g, '?'));
    const bm = /\((\d+)\)/.exec(rep.build || '');
    return bm ? bm[1] : '?';
  } catch { return '?'; }
}

function decodeDownAndMask(filePath) {
  const { bilinearDownsampleRgba } = require('../src/algorithm/gearCounter');
  const { applyCircularMask } = require('../src/algorithm/imageUtils');
  const raw = decode(fs.readFileSync(filePath), { useTArray: true });
  const down = bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  const maskR = 0.49 * Math.min(down.width, down.height);
  applyCircularMask(down.rgba, down.width, down.height, (down.width - 1) / 2, (down.height - 1) / 2, maskR);
  return down;
}

function runAlgo(rgba, w, h) {
  const { countTeethFromRgba } = require('../src/algorithm/gearCounter');
  try {
    const r = countTeethFromRgba(rgba, w, h);
    return {
      tc: r.toothCount || 0,
      conf: r.confidence || 0,
      method: r.methodUsed || '?',
      peakR: r.peakR || 0,
      rOuter: r.rOuter || 0,
    };
  } catch (e) { return { tc: 0, conf: 0, method: 'ERR:' + (e && e.message ? e.message.slice(0, 40) : '?'), peakR: 0, rOuter: 0 }; }
}

function gitHead() {
  try { return require('child_process').execSync('git rev-parse HEAD', { cwd: path.resolve(__dirname, '..', '..'), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return '?'; }
}

function algoFileSha() {
  try {
    const p = path.resolve(__dirname, '..', 'src', 'algorithm', 'gearCounter.js');
    const buf = fs.readFileSync(p);
    return require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 12);
  } catch { return '?'; }
}

describe(`PAP-1611 ${SLICE} re-baseline`, () => {
  jest.setTimeout(60 * 60 * 1000);

  (MODE === 'measure' ? test : test.skip)(`measure (slice=${SLICE} label=${COMMIT_LABEL})`, () => {
    const pairs = discoverSlicePairs();
    const out = {
      slice: SLICE,
      band: { lo: SLICE_LO, hi: SLICE_HI },
      label: COMMIT_LABEL,
      generatedAt: new Date().toISOString(),
      repoHead: gitHead(),
      algoFileSha: algoFileSha(),
      pairs: pairs.length,
      rows: [],
    };

    let i = 0;
    for (const p of pairs) {
      i++;
      const crPath = path.join(DR, `report_${p.dr.stamp}`, 'cropped.jpg');
      let res;
      try {
        const d = decodeDownAndMask(crPath);
        res = runAlgo(d.rgba, d.width, d.height);
      } catch (e) {
        res = { tc: 0, conf: 0, method: 'DECODE_ERR', peakR: 0, rOuter: 0 };
      }
      out.rows.push({
        tdStamp: p.td.stamp,
        drDir: `report_${p.dr.stamp}`,
        deltaMs: p.deltaMs,
        actual: p.actual,
        build: readBuild(p.dr.stamp),
        tc: res.tc,
        conf: Number(res.conf.toFixed(4)),
        method: res.method,
        peakR: Number(res.peakR.toFixed(4)),
        rOuter: Number(res.rOuter.toFixed(4)),
      });
      if (i % 10 === 0) process.stdout.write(`  [${i}/${pairs.length}]\n`);
    }

    const target = COMMIT_LABEL === 'prev' ? PREV_JSON : HEAD_JSON;
    fs.writeFileSync(target, JSON.stringify(out, null, 2));
    process.stdout.write(`\nJSON: ${target}\n`);
    process.stdout.write(`slice=${SLICE} band=[${SLICE_LO},${SLICE_HI}]  repoHead=${out.repoHead}  algoFileSha=${out.algoFileSha}  pairs=${out.pairs}\n`);
  });

  (MODE === 'merge' ? test : test.skip)(`merge head+prev (slice=${SLICE}) and emit AC1 CSV + AC2 tally + AC3 verdict`, () => {
    if (!fs.existsSync(HEAD_JSON) || !fs.existsSync(PREV_JSON)) {
      throw new Error(`missing input JSON(s): ${HEAD_JSON} or ${PREV_JSON}`);
    }
    const headIn = JSON.parse(fs.readFileSync(HEAD_JSON, 'utf8'));
    const prevIn = JSON.parse(fs.readFileSync(PREV_JSON, 'utf8'));

    if (headIn.algoFileSha === prevIn.algoFileSha) {
      throw new Error(`PAP-1611 invariant: head and prev have identical algoFileSha=${headIn.algoFileSha}; orchestrator did not swap gearCounter.js`);
    }

    const byStamp = new Map();
    for (const r of headIn.rows) byStamp.set(r.tdStamp, { head: r });
    for (const r of prevIn.rows) {
      const e = byStamp.get(r.tdStamp) || {};
      e.prev = r;
      byStamp.set(r.tdStamp, e);
    }

    const rows = [];
    const tally = {
      n: 0,
      headCorrect: 0,
      prevCorrect: 0,
      WIN: 0,
      LOSS: 0,
      NO_CHANGE_CORRECT: 0,
      NO_CHANGE_WRONG: 0,
      NO_CHANGE_ABSTAIN: 0,
      directionFlip: 0,
      confBandViolations: 0,
    };

    const stamps = Array.from(byStamp.keys()).sort();
    for (const stamp of stamps) {
      const e = byStamp.get(stamp);
      if (!e.head || !e.prev) continue;
      const a = e.head.actual;
      const h = e.head, p = e.prev;
      const headCorrect = h.tc > 0 && h.conf > 0 && h.tc === a;
      const prevCorrect = p.tc > 0 && p.conf > 0 && p.tc === a;
      let delta;
      if (headCorrect && !prevCorrect) delta = 'WIN';
      else if (!headCorrect && prevCorrect) delta = 'LOSS';
      else if (headCorrect && prevCorrect) delta = 'NO_CHANGE_CORRECT';
      else if ((h.conf === 0 || h.tc === 0) && (p.conf === 0 || p.tc === 0)) delta = 'NO_CHANGE_ABSTAIN';
      else delta = 'NO_CHANGE_WRONG';

      const dirFlip = (h.tc !== p.tc) && h.conf >= 0.5 && p.conf >= 0.5;
      const confDelta = Math.abs(h.conf - p.conf);

      tally.n++;
      if (headCorrect) tally.headCorrect++;
      if (prevCorrect) tally.prevCorrect++;
      tally[delta]++;
      if (dirFlip) tally.directionFlip++;
      if (confDelta > 0.10) tally.confBandViolations++;

      rows.push({
        tdStamp: stamp,
        drDir: h.drDir,
        deltaMs: h.deltaMs,
        actual: a,
        build: h.build,
        head_tc: h.tc, head_conf: h.conf, head_method: h.method, head_peakR: h.peakR, head_rOuter: h.rOuter,
        prev_tc: p.tc, prev_conf: p.conf, prev_method: p.method, prev_peakR: p.peakR, prev_rOuter: p.rOuter,
        head_correct: headCorrect ? 'Y' : 'N',
        prev_correct: prevCorrect ? 'Y' : 'N',
        delta_state: delta,
        dir_flip: dirFlip ? 'Y' : 'N',
        conf_delta: Number(confDelta.toFixed(4)),
      });
    }

    const header = [
      'tdStamp', 'drDir', 'deltaMs', 'actual', 'build',
      'head_tc', 'head_conf', 'head_method', 'head_peakR', 'head_rOuter',
      'prev_tc', 'prev_conf', 'prev_method', 'prev_peakR', 'prev_rOuter',
      'head_correct', 'prev_correct', 'delta_state', 'dir_flip', 'conf_delta',
    ].join(',');
    const lines = [header];
    for (const r of rows) {
      lines.push([
        r.tdStamp, r.drDir, r.deltaMs, r.actual, r.build,
        r.head_tc, r.head_conf, r.head_method, r.head_peakR, r.head_rOuter,
        r.prev_tc, r.prev_conf, r.prev_method, r.prev_peakR, r.prev_rOuter,
        r.head_correct, r.prev_correct, r.delta_state, r.dir_flip, r.conf_delta,
      ].join(','));
    }
    fs.writeFileSync(OUT_CSV, lines.join('\n') + '\n');

    const pctHead = tally.n ? (100 * tally.headCorrect / tally.n) : 0;
    const pctPrev = tally.n ? (100 * tally.prevCorrect / tally.n) : 0;
    const netDeltaPp = pctHead - pctPrev;
    const flipRate = tally.n ? (100 * tally.directionFlip / tally.n) : 0;

    // AC3 verdict (per PAP-1611 spec):
    //   HOLD       — Δ ≥ +10pp  (HEAD > prev)
    //   REOPEN     — Δ ≤  −5pp  (HEAD < prev, confirms PAP-1583 on-record S/M/L negative)
    //                  OR direction-flip rate > 20%
    //   AMBIGUOUS  — otherwise
    let verdict;
    let verdictReason;
    if (flipRate > 20) {
      verdict = 'REOPEN';
      verdictReason = `direction-flip rate ${flipRate.toFixed(1)}% > 20%`;
    } else if (netDeltaPp >= 10) {
      verdict = 'HOLD';
      verdictReason = `${SLICE} net Δ +${netDeltaPp.toFixed(1)}pp ≥ +10pp (HEAD>prev)`;
    } else if (netDeltaPp <= -5) {
      verdict = 'REOPEN';
      verdictReason = `${SLICE} net Δ ${netDeltaPp.toFixed(1)}pp ≤ -5pp (HEAD<prev confirms PAP-1583)`;
    } else {
      verdict = 'AMBIGUOUS';
      verdictReason = `${SLICE} net Δ ${netDeltaPp >= 0 ? '+' : ''}${netDeltaPp.toFixed(1)}pp — between AMBIGUOUS band and ±thresholds`;
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      slice: SLICE,
      band: { lo: SLICE_LO, hi: SLICE_HI },
      headRepoHead: headIn.repoHead, headAlgoFileSha: headIn.algoFileSha,
      prevRepoHead: prevIn.repoHead, prevAlgoFileSha: prevIn.algoFileSha,
      pairs_in_each: { head: headIn.rows.length, prev: prevIn.rows.length },
      paired: tally.n,
      ac1_csv: path.relative(path.resolve(__dirname, '..', '..'), OUT_CSV),
      ac2: {
        head_correct: tally.headCorrect, head_pct: Number(pctHead.toFixed(1)),
        prev_correct: tally.prevCorrect, prev_pct: Number(pctPrev.toFixed(1)),
        net_delta_pp: Number(netDeltaPp.toFixed(1)),
        WIN: tally.WIN,
        LOSS: tally.LOSS,
        NO_CHANGE_CORRECT: tally.NO_CHANGE_CORRECT,
        NO_CHANGE_WRONG: tally.NO_CHANGE_WRONG,
        NO_CHANGE_ABSTAIN: tally.NO_CHANGE_ABSTAIN,
        direction_flip: tally.directionFlip,
        direction_flip_pct: Number(flipRate.toFixed(1)),
        conf_band_violations: tally.confBandViolations,
      },
      ac3: { verdict, reason: verdictReason },
    };
    fs.writeFileSync(OUT_SUMMARY, JSON.stringify(summary, null, 2));

    process.stdout.write(`\nSlice  : ${SLICE} [${SLICE_LO},${SLICE_HI}]\n`);
    process.stdout.write(`CSV    : ${OUT_CSV}\n`);
    process.stdout.write(`Summary: ${OUT_SUMMARY}\n\n`);
    process.stdout.write(`Pairs (head|prev): ${headIn.rows.length} | ${prevIn.rows.length}  joined: ${tally.n}\n`);
    process.stdout.write(`HEAD  correct: ${tally.headCorrect}/${tally.n} (${pctHead.toFixed(1)}%)   algoSha=${headIn.algoFileSha}\n`);
    process.stdout.write(`prev  correct: ${tally.prevCorrect}/${tally.n} (${pctPrev.toFixed(1)}%)   algoSha=${prevIn.algoFileSha}\n`);
    process.stdout.write(`Net Δ        : ${netDeltaPp >= 0 ? '+' : ''}${netDeltaPp.toFixed(1)}pp\n`);
    process.stdout.write(`WIN/LOSS/NCC/NCW/NCA: ${tally.WIN}/${tally.LOSS}/${tally.NO_CHANGE_CORRECT}/${tally.NO_CHANGE_WRONG}/${tally.NO_CHANGE_ABSTAIN}\n`);
    process.stdout.write(`Direction flips    : ${tally.directionFlip} (${flipRate.toFixed(1)}%)  confBand viol: ${tally.confBandViolations}\n`);
    process.stdout.write(`\nAC3 verdict: ${verdict}\n  reason: ${verdictReason}\n`);
  });
});
