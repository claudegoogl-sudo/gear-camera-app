/**
 * PAP-1800 / PAP-1920 — AVM on-device scoring harness (b158+).
 *
 * Scores AVM auto-shared debug reports straight from Sentry against the
 * PAP-1920 acceptance criteria that need device telemetry:
 *   AC1  coverage      — every AVM payload is a completed capture's auto-share,
 *                        label attached or explicitly skipped (label: null),
 *                        no duplicate (appVersion, sessionIndex, shotIndex).
 *   AC2  arming limits — sessionIndex within 0..AVM_SESSION_LIMIT-1 and
 *                        shotIndex within 0..AVM_CAPTURE_LIMIT-1 per version;
 *                        monotonic shot order per session; advisory dormancy
 *                        note once a version reaches its limits.
 *   AC4  battery guard — NO payload with batteryLevel != null below the
 *                        AVM_BATTERY_FLOOR (0.25). null = unreadable/fail-open,
 *                        recorded but not a failure.
 *   AC5  shape         — validationSession.schemaVersion === 1, all spec keys
 *                        present, gear context present, dist tag == buildLabel
 *                        digits (legacy debug-report readers keep working).
 *
 * Plain node (PAP-1672 host rule), zero repo imports, runs from repo root:
 *   node mobile/__tests__/pap1800.avm_b158_score.mjs
 * Optional: --out debug-reports/pap1800_avm_b158_rows_<ts>.json (default when
 * AVM payloads exist).
 *
 * Exits 0 with "0 AVM payloads" when the operator has not yet used an
 * AVM-bearing build — that is the expected quiet state between releases.
 *
 * Constants mirror mobile/src/utils/avm.js (AVM_SESSION_LIMIT=3,
 * AVM_CAPTURE_LIMIT=10, AVM_BATTERY_FLOOR=0.25) — update both if avm.js moves.
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const API = 'https://sentry.io/api/0';
const AVM_SESSION_LIMIT = 3;
const AVM_CAPTURE_LIMIT = 10;
const AVM_BATTERY_FLOOR = 0.25;
const VS_KEYS = ['appVersion', 'sessionIndex', 'shotIndex', 'shotsRemaining', 'label', 'batteryLevel', 'schemaVersion'];

const out = (s) => process.stdout.write(s + '\n');

function loadEnv() {
  const env = {};
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) throw new Error('repo .env not found');
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  const tok = env.SENTRY_TRIAGE_TOKEN || env.SENTRY_AUTH_TOKEN;
  if (!env.SENTRY_ORG || !env.SENTRY_PROJECT || !tok) throw new Error('SENTRY_* missing from .env');
  return { org: env.SENTRY_ORG, proj: env.SENTRY_PROJECT, tok };
}

function getJson(url, tok) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { Authorization: `Bearer ${tok}` } }, (res) => {
      if (res.statusCode !== 200) {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 200)}`)));
        return;
      }
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Single page: the 14-day project window currently holds tens of events
// (10 at b158 publish time).  Revisit pagination only if volume explodes.
async function fetchEvents({ org, proj, tok }) {
  return getJson(`${API}/projects/${org}/${proj}/events/?full=true&per_page=100`, tok);
}

function tagMap(ev) {
  const m = {};
  for (const t of ev.tags || []) m[t.key] = t.value;
  return m;
}

function extractRow(ev) {
  const tags = tagMap(ev);
  const ctx = ev.contexts || {};
  const vs = ctx.validationSession || null;
  const gear = ctx.gear || {};
  const cam = ctx.camera || {};
  const buildDigits = (tags.buildLabel || tags.release || '').match(/\((\d+)\)/);
  return {
    eventID: ev.eventID,
    ts: ev.dateCreated,
    dist: ev.dist ?? tags.dist ?? null,
    buildLabel: tags.buildLabel || tags.release || null,
    distMatchesLabel: ev.dist != null && buildDigits ? String(ev.dist) === buildDigits[1] : null,
    device: tags.device || (ctx.device && ctx.device.name) || null,
    deviceClass: tags['device.class'] || null,
    validationTag: tags.validation ?? null,
    kind: tags.kind ?? null,
    toothCount: gear.toothCount ?? null,
    confidence: gear.confidence ?? null,
    actualTeethCount: gear.actualTeethCount ?? null,
    hasGearContext: 'toothCount' in gear,
    hasCameraContext: 'type' in cam,
    cameraEventCount: Array.isArray(cam.cameraEvents) ? cam.cameraEvents.length : 0,
    stageMs: (gear.algoDiag && gear.algoDiag.stageMs) || null,
    vs,
  };
}

function score(rows) {
  const checks = [];
  const add = (ac, name, pass, detail) => checks.push({ ac, name, pass, detail });

  for (const r of rows) {
    const vs = r.vs || {};
    // AC5 shape
    const missing = VS_KEYS.filter((k) => !(k in vs));
    add('AC5', `shape ${r.eventID.slice(0, 8)}`, missing.length === 0 && vs.schemaVersion === 1,
      missing.length ? `missing keys: ${missing.join(',')}` : `schemaVersion=${vs.schemaVersion}`);
    add('AC5', `legacy-parse ${r.eventID.slice(0, 8)}`, r.hasGearContext && r.hasCameraContext,
      `gear=${r.hasGearContext} camera=${r.hasCameraContext} (cameraEvents=${r.cameraEventCount})`);
    if (r.distMatchesLabel === false) add('AC5', `dist-vs-label ${r.eventID.slice(0, 8)}`, false,
      `dist=${r.dist} buildLabel=${r.buildLabel}`);

    // AC1
    const labeled = vs.label != null;
    add('AC1', `label ${r.eventID.slice(0, 8)}`, labeled || vs.label === null,
      labeled ? `label=${vs.label} vs tc=${r.toothCount}` : 'label skipped (allowed, sample unscoreable)');

    // AC2 arming bounds
    const sIdx = vs.sessionIndex, shotIdx = vs.shotIndex;
    add('AC2', `bounds ${r.eventID.slice(0, 8)}`,
      Number.isInteger(sIdx) && sIdx >= 0 && sIdx < AVM_SESSION_LIMIT &&
      Number.isInteger(shotIdx) && shotIdx >= 0 && shotIdx < AVM_CAPTURE_LIMIT,
      `sessionIndex=${sIdx} shotIndex=${shotIdx} (limits ${AVM_SESSION_LIMIT}/${AVM_CAPTURE_LIMIT})`);

    // AC4 battery guard
    const b = vs.batteryLevel;
    add('AC4', `battery ${r.eventID.slice(0, 8)}`, !(typeof b === 'number' && b < AVM_BATTERY_FLOOR),
      typeof b === 'number' ? `batteryLevel=${b} (floor ${AVM_BATTERY_FLOOR})` : 'batteryLevel unreadable (fail-open)');
  }

  // AC1 duplicate detection across payloads
  const seen = new Map();
  const dups = [];
  for (const r of rows) {
    const k = `${r.vs.appVersion}|${r.vs.sessionIndex}|${r.vs.shotIndex}`;
    if (seen.has(k)) dups.push(`${k} (${seen.get(k)} vs ${r.eventID.slice(0, 8)})`);
    seen.set(k, r.eventID.slice(0, 8));
  }
  add('AC1', 'no duplicate (version,session,shot)', dups.length === 0, dups.length ? dups.join('; ') : `${seen.size} unique shots`);

  // AC2 monotonic shot order per (version, session) + dormancy advisory
  const perSession = new Map();
  for (const r of rows) {
    const k = `${r.vs.appVersion}|${r.vs.sessionIndex}`;
    if (!perSession.has(k)) perSession.set(k, []);
    perSession.get(k).push({ shot: r.vs.shotIndex, ts: r.ts, id: r.eventID.slice(0, 8) });
  }
  const nonMono = [];
  for (const [k, shots] of perSession) {
    const tsSorted = [...shots].sort((a, b) => a.ts.localeCompare(b.ts));
    for (let i = 1; i < tsSorted.length; i++) {
      if (tsSorted[i].shot <= tsSorted[i - 1].shot) nonMono.push(`${k}: ${tsSorted[i - 1].shot}@${tsSorted[i - 1].ts} -> ${tsSorted[i].shot}@${tsSorted[i].ts}`);
    }
  }
  add('AC2', 'shot order monotonic per session', nonMono.length === 0, nonMono.length ? nonMono.join('; ') : `${perSession.size} sessions`);
  const versions = [...new Set(rows.map((r) => r.vs.appVersion))];
  const dormant = versions.filter((v) => {
    const rs = rows.filter((r) => r.vs.appVersion === v);
    const maxS = Math.max(...rs.map((r) => r.vs.sessionIndex));
    const maxShot = Math.max(...rs.map((r) => r.vs.shotIndex));
    return maxS >= AVM_SESSION_LIMIT - 1 && maxShot >= AVM_CAPTURE_LIMIT - 1;
  });
  // advisory only: reaching limits in telemetry predicts dormancy on device
  checks.push({ ac: 'AC2', name: 'dormancy advisory', pass: true,
    detail: dormant.length ? `version(s) reached limits in telemetry: ${dormant.join(',')} — any LATER avm-tagged payload for them would be a dormancy FAIL` : 'no version at limits yet' });

  return checks;
}

// --selftest: exercise score() over synthetic payloads (no network) and
// assert the expected verdict pattern.  Guards the checker itself against
// silent drift — run after any edit to score()/extractRow().
const SELFTEST_ROWS = [
  { eventID: 'aaa1', ts: '2026-09-19T08:00:00Z', dist: '158', buildLabel: 'v1.0.0 (158)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 36, confidence: 0.75, hasGearContext: true, hasCameraContext: true, cameraEventCount: 7,
    vs: { appVersion: 'v1.0.0 (158)', sessionIndex: 0, shotIndex: 0, shotsRemaining: 9, label: 36, batteryLevel: 0.8, schemaVersion: 1 } },
  { eventID: 'bbb2', ts: '2026-09-19T08:05:00Z', dist: '158', buildLabel: 'v1.0.0 (158)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 36, confidence: 0.6, hasGearContext: true, hasCameraContext: true, cameraEventCount: 6,
    vs: { appVersion: 'v1.0.0 (158)', sessionIndex: 0, shotIndex: 1, shotsRemaining: 8, label: null, batteryLevel: 0.12, schemaVersion: 1 } }, // AC4 FAIL expected, label skip OK
  { eventID: 'ccc3', ts: '2026-09-19T08:10:00Z', dist: '158', buildLabel: 'v1.0.0 (158)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 20, confidence: 0.9, hasGearContext: true, hasCameraContext: true, cameraEventCount: 5,
    vs: { appVersion: 'v1.0.0 (158)', sessionIndex: 2, shotIndex: 11, shotsRemaining: 0, label: 20, batteryLevel: null, schemaVersion: 1 } }, // AC2 bounds FAIL expected (shotIndex 11)
  { eventID: 'ddd4', ts: '2026-09-19T08:20:00Z', dist: '158', buildLabel: 'v1.0.0 (158)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 20, confidence: 0.9, hasGearContext: true, hasCameraContext: true, cameraEventCount: 5,
    vs: { appVersion: 'v1.0.0 (158)', sessionIndex: 2, shotIndex: 11, shotsRemaining: 0, label: 20, batteryLevel: null, schemaVersion: 1 } }, // duplicate (session,shot) FAIL expected
];
function runSelftest() {
  const checks = score(SELFTEST_ROWS);
  const mustFail = [
    (c) => c.ac === 'AC4' && c.name.includes('bbb2'),
    (c) => c.ac === 'AC2' && c.name.includes('bounds') && c.name.includes('ccc3'),
    (c) => c.ac === 'AC1' && c.name.includes('no duplicate'),
  ];
  const mustPass = [
    (c) => c.ac === 'AC5' && c.name.includes('aaa1'),
    (c) => c.ac === 'AC1' && c.name.includes('label aaa1'),
    // shot-order monotonicity is asserted via the clean-rows case below:
    // the duplicate row here intentionally ALSO breaks monotonicity, so it
    // cannot carry a mustPass expectation of its own.
  ];
  let ok = true;
  for (const pred of mustFail) if (!checks.some((c) => pred(c) && !c.pass)) { out('SELFTEST FAIL: expected failing check missing'); ok = false; }
  for (const pred of mustPass) if (!checks.some((c) => pred(c) && c.pass)) { out('SELFTEST FAIL: expected passing check missing'); ok = false; }
  const acc = score([SELFTEST_ROWS[0], { ...SELFTEST_ROWS[1], vs: { ...SELFTEST_ROWS[1].vs, batteryLevel: 0.5 } }]);
  if (!acc.every((c) => c.pass)) { out('SELFTEST FAIL: clean rows must all pass'); ok = false; }
  out(ok ? 'SELFTEST PASS (score() verdict pattern as expected)' : 'SELFTEST FAILED');
  process.exit(ok ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) runSelftest();
const outIdx = argv.indexOf('--out');
const outPath = outIdx >= 0 ? argv[outIdx + 1] : null;

const env = loadEnv();
const events = await fetchEvents(env);
const all = events.map(extractRow);
const avmRows = all.filter((r) => r.validationTag === 'avm' || (r.vs && typeof r.vs === 'object'));

out(`Sentry events enumerated: ${all.length} (window: ${all.length ? all.map((r) => r.ts).sort()[0].slice(0, 16) : '-'} .. ${all.length ? all.map((r) => r.ts).sort().slice(-1)[0].slice(0, 16) : '-'} UTC)`);
out(`AVM-tagged payloads: ${avmRows.length}`);

if (avmRows.length === 0) {
  out('VERDICT: 0 AVM payloads — nothing to score yet (expected between releases).');
  const newest = all.length ? [...all].sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))[0] : null;
  out('Newest event overall: ' + (newest ? `${newest.eventID.slice(0, 8)} ${newest.ts} dist=${newest.dist}` : 'none'));
  process.exit(0);
}

avmRows.sort((a, b) => (a.vs.appVersion + a.ts).localeCompare(b.vs.appVersion + b.ts));
const checks = score(avmRows);
const failed = checks.filter((c) => !c.pass);

out('\n=== per-shot rows ===');
for (const r of avmRows) {
  const v = r.vs;
  const acc = v.label != null ? (v.label === r.toothCount ? 'CORRECT' : 'WRONG') : 'UNLABELED';
  out(`${r.eventID.slice(0, 8)} ${r.ts} v=${v.appVersion} s=${v.sessionIndex} shot=${v.shotIndex} label=${v.label} tc=${r.toothCount} conf=${r.confidence} batt=${v.batteryLevel} ${acc}`);
}

out('\n=== checks ===');
for (const c of checks) out(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.ac} ${c.name} — ${c.detail}`);

const rowDoc = {
  generatedAt: new Date().toISOString(),
  source: 'sentry project events (full=true)',
  avmPayloads: avmRows,
  checks,
  verdict: failed.length === 0 ? 'PASS' : `FAIL (${failed.length} checks)`,
};
const defaultOut = path.join(ROOT, 'debug-reports', `pap1800_avm_b158_rows_${new Date().toISOString().slice(0, 10)}.json`);
const target = outPath || defaultOut;
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(rowDoc, null, 2) + '\n');
out(`\nrows -> ${path.relative(ROOT, target)}`);
out(`VERDICT: ${rowDoc.verdict} (${avmRows.length} AVM payloads scored)`);
process.exit(failed.length === 0 ? 0 : 1);
