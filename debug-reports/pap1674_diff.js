#!/usr/bin/env node
// PAP-1674 AC2/AC4: per-photo diff between two pap1674.audit.js CSV runs.
// Usage: node pap1674_diff.js <old.csv> <new.csv>
const fs = require('fs');

function loadCsv(p) {
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const row = {};
    header.forEach((h, j) => { row[h] = cols[j]; });
    rows.set(row.stamp, row);
  }
  return rows;
}

function state(r) {
  if (r.abstain === '1') return 'abstain';
  if (r.correct === '1') return 'correct';
  return 'wrong';
}

const [, , oldPath, newPath] = process.argv;
const oldRows = loadCsv(oldPath);
const newRows = loadCsv(newPath);

const transitions = {};
let churn = 0;
const churnRows = [];
for (const [stamp, nr] of newRows) {
  const or = oldRows.get(stamp);
  if (!or) continue;
  const os = state(or), ns = state(nr);
  if (os !== ns) {
    churn++;
    const key = `${os}->${ns}`;
    transitions[key] = (transitions[key] || 0) + 1;
    churnRows.push({ stamp, actual: nr.actual, bucket: nr.bucket, os, ns, oldTc: or.tc, newTc: nr.tc, budgetExhausted: nr.budgetExhausted });
  }
}

console.log(`old rows: ${oldRows.size}  new rows: ${newRows.size}`);
console.log(`churned photos: ${churn}`);
console.log('transitions:', JSON.stringify(transitions, null, 2));
console.log('\nper-photo churn:');
for (const c of churnRows) {
  console.log(`${c.stamp} actual=${c.actual}T bucket=${c.bucket} ${c.os}(tc=${c.oldTc})->${c.ns}(tc=${c.newTc}) budgetExhausted=${c.budgetExhausted}`);
}

const budgetFires = [...newRows.values()].filter(r => r.budgetExhausted === '1');
console.log(`\nbudgetExhausted fires in new run: ${budgetFires.length}/${newRows.size}`);
for (const r of budgetFires) {
  console.log(`  ${r.stamp} actual=${r.actual}T bucket=${r.bucket} tc=${r.tc} algorithmRuntimeMs=${r.algorithmRuntimeMs}`);
}

// Bucket-level accuracy comparison
const buckets = ['Small', 'Mid', 'Large', 'XL'];
function bucketStats(rows) {
  const s = {};
  for (const b of buckets) s[b] = { n: 0, correct: 0, abstain: 0, cw: 0 };
  for (const r of rows.values()) {
    const b = s[r.bucket];
    if (!b) continue;
    b.n++;
    if (r.abstain === '1') b.abstain++;
    else if (r.correct === '1') b.correct++;
    else b.cw++;
  }
  return s;
}
const oldStats = bucketStats(oldRows);
const newStats = bucketStats(newRows);
console.log('\nbucket    oldN oldCorrect oldAcc%  newN newCorrect newAcc%  deltaPP');
let oldTotal = { n: 0, correct: 0 };
let newTotal = { n: 0, correct: 0 };
for (const b of buckets) {
  const o = oldStats[b], n = newStats[b];
  oldTotal.n += o.n; oldTotal.correct += o.correct;
  newTotal.n += n.n; newTotal.correct += n.correct;
  const oAcc = o.n ? (100 * o.correct / o.n) : 0;
  const nAcc = n.n ? (100 * n.correct / n.n) : 0;
  console.log(`${b.padEnd(8)} ${String(o.n).padStart(4)} ${String(o.correct).padStart(10)} ${oAcc.toFixed(1).padStart(7)}  ${String(n.n).padStart(4)} ${String(n.correct).padStart(10)} ${nAcc.toFixed(1).padStart(7)}  ${(nAcc - oAcc).toFixed(1)}`);
}
const oAccT = 100 * oldTotal.correct / oldTotal.n;
const nAccT = 100 * newTotal.correct / newTotal.n;
console.log(`TOTAL    ${oldTotal.n}  ${oldTotal.correct}  ${oAccT.toFixed(1)}%   ${newTotal.n}  ${newTotal.correct}  ${nAccT.toFixed(1)}%   deltaPP=${(nAccT - oAccT).toFixed(2)}`);

// PAP-1673 triple (correct / abstain / conf-wrong) delta — reading-agnostic.
console.log('\n=== TRIPLE DELTA (PAP-1673: report both readings) ===');
console.log('bucket    | old correct/abstain/cw        | new correct/abstain/cw        | d(correct) d(abstain) d(cw)');
const tot = { o: { correct: 0, abstain: 0, cw: 0, n: 0 }, n: { correct: 0, abstain: 0, cw: 0, n: 0 } };
for (const b of buckets) {
  const o = oldStats[b], n = newStats[b];
  tot.o.correct += o.correct; tot.o.abstain += o.abstain; tot.o.cw += o.cw; tot.o.n += o.n;
  tot.n.correct += n.correct; tot.n.abstain += n.abstain; tot.n.cw += n.cw; tot.n.n += n.n;
  console.log(`${b.padEnd(9)} | ${String(o.correct).padStart(3)}/${String(o.abstain).padStart(3)}/${String(o.cw).padStart(3)} (N=${o.n})            | ${String(n.correct).padStart(3)}/${String(n.abstain).padStart(3)}/${String(n.cw).padStart(3)} (N=${n.n})            | ${String(n.correct - o.correct).padStart(6)} ${String(n.abstain - o.abstain).padStart(6)} ${String(n.cw - o.cw).padStart(6)}`);
}
console.log(`TOTAL     | ${tot.o.correct}/${tot.o.abstain}/${tot.o.cw} (N=${tot.o.n})       | ${tot.n.correct}/${tot.n.abstain}/${tot.n.cw} (N=${tot.n.n})       | ${tot.n.correct - tot.o.correct} ${tot.n.abstain - tot.o.abstain} ${tot.n.cw - tot.o.cw}`);
const r1o = 100 * tot.o.correct / tot.o.n, r1n = 100 * tot.n.correct / tot.n.n;
const r2o = 100 * tot.o.correct / (tot.o.n - tot.o.abstain), r2n = 100 * tot.n.correct / (tot.n.n - tot.n.abstain);
console.log(`\nReading 1 (correct/N):            old ${r1o.toFixed(1)}%  new ${r1n.toFixed(1)}%  delta ${(r1n - r1o).toFixed(2)}pp`);
console.log(`Reading 2 (correct/(N-abstain)):  old ${r2o.toFixed(1)}%  new ${r2n.toFixed(1)}%  delta ${(r2n - r2o).toFixed(2)}pp`);
