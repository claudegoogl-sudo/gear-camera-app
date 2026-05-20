/**
 * PAP-1609 — PAP-1583 XL re-baseline on 72 XL backfill pairs under cropped
 * geometry (HEAD vs 86b4458^).  Measurement only; no algorithm changes.
 *
 * Modes (env):
 *   MODE=measure COMMIT_LABEL=head|prev   — runs the algorithm on every XL
 *     backfill pair (debug-reports/report_<stamp>/cropped.jpg paired <=30s
 *     with training-data/<stamp>_meta.json) and emits a JSON of per-row to
 *     debug-reports/pap1609_<label>_rows_2026-05-20.json.  The label only
 *     names the output file; the *actual* commit is whatever
 *     mobile/src/algorithm/gearCounter.js is currently checked out to.
 *     The orchestrating shell script does the checkout (see PAP-1609 doc).
 *
 *   MODE=merge                            — loads the two per-commit JSONs
 *     produced by the measure runs, joins on stamp, emits the AC1 CSV
 *     (debug-reports/pap1609_rebaseline_2026-05-20.csv) and prints the
 *     AC2 tally + AC3 verdict (HOLD / REOPEN / AMBIGUOUS).
 *
 * Pairing window: ≤30s per board spec (the PAP-1604 scaffold used ≤60s).
 * Tolerance: tol=0 strict (feedback_zero_tolerance_no_softening).
 * Confidence band: |Δconf| ≤ 0.10 (per PAP-1607 A6); reported for AC2 noise.
 * XL band: actual ∈ [29, 60].
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
const XL_LO = 29;
const XL_HI = 60;

const MODE = (process.env.MODE || 'measure').toLowerCase();
const COMMIT_LABEL = (process.env.COMMIT_LABEL || 'head').toLowerCase();
const HEAD_JSON = path.join(DR, 'pap1609_head_rows_2026-05-20.json');
const PREV_JSON = path.join(DR, 'pap1609_prev_rows_2026-05-20.json');
const OUT_CSV = path.join(DR, 'pap1609_rebaseline_2026-05-20.csv');
const OUT_SUMMARY = path.join(DR, 'pap1609_rebaseline_summary_2026-05-20.json');

function toMs(stamp) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

function discoverXlPairs() {
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
      if (actual >= XL_LO && actual <= XL_HI) {
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
  // Lazily require the algorithm module so MODE=merge does NOT load it
  // (allowing the merge step to run on either commit's checkout without
  // re-decoding any image).
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
  // Hash of the currently-checked-out gearCounter.js — orthogonal to repo HEAD
  // so we can confirm the orchestrator successfully swapped the file.
  try {
    const p = path.resolve(__dirname, '..', 'src', 'algorithm', 'gearCounter.js');
    const buf = fs.readFileSync(p);
    return require('crypto').createHash('sha1').update(buf).digest('hex').slice(0, 12);
  } catch { return '?'; }
}

// ─────────────────────────────────────────────────────────────────────────
// Measure mode
// ─────────────────────────────────────────────────────────────────────────
describe('PAP-1609 XL re-baseline', () => {
  jest.setTimeout(60 * 60 * 1000);

  (MODE === 'measure' ? test : test.skip)(`measure (label=${COMMIT_LABEL})`, () => {
    const pairs = discoverXlPairs();
    const out = {
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
    process.stdout.write(`repoHead=${out.repoHead}  algoFileSha=${out.algoFileSha}  pairs=${out.pairs}\n`);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Merge mode
  // ───────────────────────────────────────────────────────────────────────
  (MODE === 'merge' ? test : test.skip)('merge head+prev and emit AC1 CSV + AC2 tally + AC3 verdict', () => {
    if (!fs.existsSync(HEAD_JSON) || !fs.existsSync(PREV_JSON)) {
      throw new Error(`missing input JSON(s): ${HEAD_JSON} or ${PREV_JSON}`);
    }
    const headIn = JSON.parse(fs.readFileSync(HEAD_JSON, 'utf8'));
    const prevIn = JSON.parse(fs.readFileSync(PREV_JSON, 'utf8'));

    if (headIn.algoFileSha === prevIn.algoFileSha) {
      throw new Error(`PAP-1609 invariant: head and prev have identical algoFileSha=${headIn.algoFileSha}; orchestrator did not swap gearCounter.js`);
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
      directionFlip: 0,        // |Δtc| > 0 with both confidences ≥ 0.5
      confBandViolations: 0,   // |Δconf| > 0.10 (advisory; PAP-1607 A6 noise band)
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

    // AC2 net Δ
    const pctHead = tally.n ? (100 * tally.headCorrect / tally.n) : 0;
    const pctPrev = tally.n ? (100 * tally.prevCorrect / tally.n) : 0;
    const netDeltaPp = pctHead - pctPrev;
    const flipRate = tally.n ? (100 * tally.directionFlip / tally.n) : 0;

    // AC3 verdict (per spec):
    //   HOLD       — HEAD > prev on XL by ≥10pp net
    //   REOPEN     — HEAD < prev by ≥5pp net, OR direction-flip rate > 20%
    //   AMBIGUOUS  — |net| ≤ 5pp
    let verdict;
    let verdictReason;
    if (flipRate > 20) {
      verdict = 'REOPEN';
      verdictReason = `direction-flip rate ${flipRate.toFixed(1)}% > 20%`;
    } else if (netDeltaPp >= 10) {
      verdict = 'HOLD';
      verdictReason = `XL net Δ +${netDeltaPp.toFixed(1)}pp ≥ +10pp (HEAD>prev confirms PAP-1583 revert direction)`;
    } else if (netDeltaPp <= -5) {
      verdict = 'REOPEN';
      verdictReason = `XL net Δ ${netDeltaPp.toFixed(1)}pp ≤ -5pp (HEAD<prev contradicts PAP-1583)`;
    } else if (Math.abs(netDeltaPp) <= 5) {
      verdict = 'AMBIGUOUS';
      verdictReason = `|XL net Δ| ${Math.abs(netDeltaPp).toFixed(1)}pp ≤ 5pp — neither HOLD nor REOPEN threshold met`;
    } else {
      // 5pp < netDeltaPp < 10pp — between AMBIGUOUS band and HOLD threshold
      verdict = 'AMBIGUOUS';
      verdictReason = `XL net Δ +${netDeltaPp.toFixed(1)}pp — between AMBIGUOUS ±5pp band and HOLD +10pp threshold`;
    }

    const summary = {
      generatedAt: new Date().toISOString(),
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

    process.stdout.write(`\nCSV    : ${OUT_CSV}\n`);
    process.stdout.write(`Summary: ${OUT_SUMMARY}\n\n`);
    process.stdout.write(`Pairs (head|prev): ${headIn.rows.length} | ${prevIn.rows.length}  joined: ${tally.n}\n`);
    process.stdout.write(`HEAD  correct: ${tally.headCorrect}/${tally.n} (${pctHead.toFixed(1)}%)   algoSha=${headIn.algoFileSha} repoHead=${headIn.repoHead}\n`);
    process.stdout.write(`prev  correct: ${tally.prevCorrect}/${tally.n} (${pctPrev.toFixed(1)}%)   algoSha=${prevIn.algoFileSha} repoHead=${prevIn.repoHead}\n`);
    process.stdout.write(`Net Δ        : ${netDeltaPp >= 0 ? '+' : ''}${netDeltaPp.toFixed(1)}pp\n`);
    process.stdout.write(`WIN/LOSS/NCC/NCW/NCA: ${tally.WIN}/${tally.LOSS}/${tally.NO_CHANGE_CORRECT}/${tally.NO_CHANGE_WRONG}/${tally.NO_CHANGE_ABSTAIN}\n`);
    process.stdout.write(`Direction flips    : ${tally.directionFlip} (${flipRate.toFixed(1)}%)  confBand viol: ${tally.confBandViolations}\n`);
    process.stdout.write(`\nAC3 verdict: ${verdict}\n  reason: ${verdictReason}\n`);
  });
});
