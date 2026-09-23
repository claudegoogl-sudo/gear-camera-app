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
 *   RP  dense override — (PAP-1873/PAP-1929; b159 payloads only, check code
 *                        "RP") override commits must carry denseGateOverride
 *                        =true AND the +bc-consensus-override tag AND
 *                        confidence 0.9 AND bcPeaks in [40,60]; wrong
 *                        override-commits <=1 per session (target 0); labels
 *                        < 40 must never carry an override commit.  Pre-b159
 *                        payloads skip this section (fields absent).
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
// PAP-1929 binding conditions (QA verdicts 648c12bd/74abb1a2) — mirror
// mobile/src/algorithm/gearCounter.js BC_OVERRIDE_MIN/MAX/BC_CONSENSUS_OVERRIDE_CONF.
const BC_OVERRIDE_MIN = 40;
const BC_OVERRIDE_MAX = 60;
const BC_OVERRIDE_CONF = 0.9;
const BC_OVERRIDE_TAG = 'bc-consensus-override';
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

// ENUMERATION (fixed 2026-09-22 after a real scoring miss):
// The project latest-events endpoint silently caps responses at 10 rows and
// ADVANCES ITS INTERNAL CURSOR BY per_page (per_page=100 skips ~90 events),
// and per-group event lists are also 10-row-capped.  Single-page enumeration
// therefore missed 6 of 9 shots in the 2026-09-22 b158 session.  Fix: union
// across BOTH endpoints and multiple cursor windows, dedupe by eventID, and
// filter client-side.  per_page=10 walks are the empirically stable shape.
async function fetchEvents({ org, proj, tok }) {
  const paths = [];
  for (const cur of ['', '&cursor=0:10:0', '&cursor=10:10:0', '&cursor=20:10:0']) {
    paths.push(`/projects/${org}/${proj}/events/?full=true&per_page=10${cur}`);
    paths.push(`/projects/${org}/${proj}/events/?full=true&per_page=10&sort=-ts_event_timestamp${cur}`);
  }
  const issues = await getJson(`${API}/projects/${org}/${proj}/issues/?per_page=100`, tok);
  for (const g of issues) {
    if (!g || !g.id) continue;
    for (const cur of ['', '&cursor=0:10:0', '&cursor=10:10:0', '&cursor=20:10:0']) {
      paths.push(`/organizations/${org}/issues/${g.id}/events/?per_page=10&sort=-ts_event_timestamp&full=true${cur}`);
    }
  }
  const byId = new Map();
  let fresh = 0, rounds = 0;
  do {
    fresh = 0; rounds++;
    for (const p of paths) {
      let rows;
      try { rows = await getJson(`${API}${p}`, tok); } catch (e) { continue; }
      if (!Array.isArray(rows)) continue;
      for (const e of rows) {
        if (e && e.eventID && !byId.has(e.eventID)) { byId.set(e.eventID, e); fresh++; }
      }
    }
  } while (fresh > 0 && rounds < 5); // union converges: stop when a full pass adds nothing
  return [...byId.values()];
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
    algoDiag: gear.algoDiag || null,
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

  // -- RP: R' dense-gate override (PAP-1873/PAP-1929; b159+ payloads) ------
  // Scope: rows carrying PAP-1930 telemetry (algoDiag.denseGateOverride /
  // algoDiag.bcTc keys exist only on b159+) or dist >= 159.  Pre-b159
  // payloads skip (fields absent = inScope false).
  const inScope = (r) => r.algoDiag != null &&
    (Number(r.dist) >= 159 || r.algoDiag.denseGateOverride != null || r.algoDiag.bcTc != null);
  const isOverride = (r) => r.algoDiag.denseGateOverride === true ||
    String(r.algoDiag.methodUsed || '').includes(BC_OVERRIDE_TAG);
  const bcPeaksOf = (r) => r.algoDiag.bcPeaks;
  const bcInBand = (r) => Number.isFinite(bcPeaksOf(r)) &&
    bcPeaksOf(r) >= BC_OVERRIDE_MIN && bcPeaksOf(r) <= BC_OVERRIDE_MAX;

  let scoped = 0;
  const wrongBySession = new Map();
  const rescue = { commits: 0, exact: 0, wrong: 0, abstainsInBand: 0 };
  for (const r of rows) {
    if (!inScope(r)) continue;
    scoped++;
    const v = r.vs || {};
    const id = r.eventID.slice(0, 8);
    if (isOverride(r)) {
      const tagged = String(r.algoDiag.methodUsed || '').includes(BC_OVERRIDE_TAG);
      add('RP', `override separability ${id}`, tagged && r.algoDiag.denseGateOverride === true,
        `denseGateOverride=${r.algoDiag.denseGateOverride} tag=${r.algoDiag.methodUsed}`);
      add('RP', `override conf ${id}`, r.confidence === BC_OVERRIDE_CONF,
        `confidence=${r.confidence} (override commits must carry ${BC_OVERRIDE_CONF})`);
      add('RP', `override window ${id}`, bcInBand(r),
        `bcPeaks=${bcPeaksOf(r)} (binding window [${BC_OVERRIDE_MIN},${BC_OVERRIDE_MAX}]; 39/61 out)`);
      if (v.label != null && r.toothCount != null) {
        rescue.commits++;
        if (Math.abs(r.toothCount - v.label) <= 1) rescue.exact++;
        else {
          rescue.wrong++;
          const k = `${v.appVersion}|${v.sessionIndex}`;
          wrongBySession.set(k, (wrongBySession.get(k) || 0) + 1);
        }
      }
    } else if (bcInBand(r) && r.toothCount == null) {
      rescue.abstainsInBand++;
    }
    if (v.label != null && v.label < BC_OVERRIDE_MIN) {
      add('RP', `small-gear untouched ${id}`, !isOverride(r),
        `label=${v.label} denseGateOverride=${r.algoDiag.denseGateOverride} (override must never fire below ${BC_OVERRIDE_MIN}T)`);
    }
  }
  const badSessions = [...wrongBySession.entries()].filter(([, w]) => w > 1);
  const totalWrongs = [...wrongBySession.values()].reduce((a, b) => a + b, 0);
  add('RP', 'wrong override-commits <=1 per session (target 0)', badSessions.length === 0,
    badSessions.length
      ? badSessions.map(([k, w]) => `${k}: ${w} wrong override commits`).join('; ')
      : `${wrongBySession.size} override-commit session(s), ${totalWrongs} wrong total`);
  add('RP', 'rescue yield (informational)', true,
    scoped === 0
      ? 'no b159 payloads yet (expected between releases)'
      : `scope=${scoped} rows; override commits=${rescue.commits} exact+/-1=${rescue.exact} wrong=${rescue.wrong} in-band-still-abstain=${rescue.abstainsInBand} (corpus basis: 17/33 gate-fires +/-1, 0 wrong)`);

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
  // -- b159 RP synthetic rows (PAP-1930 payload shape: gear.algoDiag.*) --
  { eventID: 'eee5', ts: '2026-09-23T09:00:00Z', dist: '159', buildLabel: 'v1.0.0 (159)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 51, confidence: 0.9, actualTeethCount: 51, hasGearContext: true, hasCameraContext: true, cameraEventCount: 4,
    algoDiag: { denseGateOverride: true, methodUsed: 'pap1872-dense-chainring-abstain+bc-consensus-override', bcPeaks: 51, bcTc: 51, bcPurity: 0.2, bcPeakProm: 3.1, abstained: false },
    vs: { appVersion: 'v1.0.0 (159)', sessionIndex: 0, shotIndex: 0, shotsRemaining: 9, label: 51, batteryLevel: 0.9, schemaVersion: 1 } }, // override rescue 51=51: all RP PASS
  { eventID: 'fff6', ts: '2026-09-23T09:05:00Z', dist: '159', buildLabel: 'v1.0.0 (159)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: null, confidence: null, hasGearContext: true, hasCameraContext: true, cameraEventCount: 4,
    algoDiag: { denseGateOverride: false, methodUsed: 'pap1872-dense-chainring-abstain', bcPeaks: 21, bcTc: 18, bcPurity: 0.1, bcPeakProm: 2.0, abstained: true },
    vs: { appVersion: 'v1.0.0 (159)', sessionIndex: 0, shotIndex: 1, shotsRemaining: 8, label: 52, batteryLevel: 0.9, schemaVersion: 1 } }, // collapsed-class abstain intact: no RP fail
  { eventID: 'ggg7', ts: '2026-09-23T09:10:00Z', dist: '159', buildLabel: 'v1.0.0 (159)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 47, confidence: 0.9, hasGearContext: true, hasCameraContext: true, cameraEventCount: 4,
    algoDiag: { denseGateOverride: true, methodUsed: 'x+bc-consensus-override', bcPeaks: 47, bcTc: 47, bcPurity: 0.2, bcPeakProm: 2.5, abstained: false },
    vs: { appVersion: 'v1.0.0 (159)', sessionIndex: 0, shotIndex: 2, shotsRemaining: 7, label: 51, batteryLevel: 0.9, schemaVersion: 1 } }, // override wrong (47 vs 51): 1st wrong in session — allowed (<=1)
  { eventID: 'hhh8', ts: '2026-09-23T09:15:00Z', dist: '159', buildLabel: 'v1.0.0 (159)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 44, confidence: 0.9, hasGearContext: true, hasCameraContext: true, cameraEventCount: 4,
    algoDiag: { denseGateOverride: true, methodUsed: 'x+bc-consensus-override', bcPeaks: 44, bcTc: 44, bcPurity: 0.2, bcPeakProm: 2.5, abstained: false },
    vs: { appVersion: 'v1.0.0 (159)', sessionIndex: 0, shotIndex: 3, shotsRemaining: 6, label: 51, batteryLevel: 0.9, schemaVersion: 1 } }, // 2nd wrong in session 0 -> wrong-commits FAIL expected
  { eventID: 'iii9', ts: '2026-09-23T09:20:00Z', dist: '159', buildLabel: 'v1.0.0 (159)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 39, confidence: 0.9, hasGearContext: true, hasCameraContext: true, cameraEventCount: 4,
    algoDiag: { denseGateOverride: true, methodUsed: 'x+bc-consensus-override', bcPeaks: 39, bcTc: 39, bcPurity: 0.2, bcPeakProm: 2.5, abstained: false },
    vs: { appVersion: 'v1.0.0 (159)', sessionIndex: 1, shotIndex: 0, shotsRemaining: 9, label: 48, batteryLevel: 0.9, schemaVersion: 1 } }, // out-of-band override (39) -> window FAIL expected
  { eventID: 'jjj10', ts: '2026-09-23T09:25:00Z', dist: '159', buildLabel: 'v1.0.0 (159)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 45, confidence: 1.0, hasGearContext: true, hasCameraContext: true, cameraEventCount: 4,
    algoDiag: { denseGateOverride: true, methodUsed: 'x+bc-consensus-override', bcPeaks: 45, bcTc: 45, bcPurity: 0.2, bcPeakProm: 2.5, abstained: false },
    vs: { appVersion: 'v1.0.0 (159)', sessionIndex: 1, shotIndex: 1, shotsRemaining: 8, label: null, batteryLevel: 0.9, schemaVersion: 1 } }, // conf 1.0 -> override conf FAIL expected
  { eventID: 'kkk11', ts: '2026-09-23T09:30:00Z', dist: '159', buildLabel: 'v1.0.0 (159)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 10, confidence: 0.8, hasGearContext: true, hasCameraContext: true, cameraEventCount: 4,
    algoDiag: { denseGateOverride: false, methodUsed: 'fft', bcPeaks: null, bcTc: null, bcPurity: null, bcPeakProm: null, abstained: false },
    vs: { appVersion: 'v1.0.0 (159)', sessionIndex: 1, shotIndex: 2, shotsRemaining: 7, label: 10, batteryLevel: 0.9, schemaVersion: 1 } }, // small gear, no override: small-gear PASS expected
  { eventID: 'lll12', ts: '2026-09-23T09:35:00Z', dist: '159', buildLabel: 'v1.0.0 (159)', distMatchesLabel: true, validationTag: 'avm',
    toothCount: 42, confidence: 0.9, hasGearContext: true, hasCameraContext: true, cameraEventCount: 4,
    algoDiag: { denseGateOverride: true, methodUsed: 'x+bc-consensus-override', bcPeaks: 42, bcTc: 42, bcPurity: 0.2, bcPeakProm: 2.5, abstained: false },
    vs: { appVersion: 'v1.0.0 (159)', sessionIndex: 1, shotIndex: 3, shotsRemaining: 6, label: 10, batteryLevel: 0.9, schemaVersion: 1 } }, // override on 10T label -> small-gear FAIL expected
];
function runSelftest() {
  const checks = score(SELFTEST_ROWS);
  const mustFail = [
    (c) => c.ac === 'AC4' && c.name.includes('bbb2'),
    (c) => c.ac === 'AC2' && c.name.includes('bounds') && c.name.includes('ccc3'),
    (c) => c.ac === 'AC1' && c.name.includes('no duplicate'),
    (c) => c.ac === 'RP' && c.name.includes('wrong override-commits'),
    (c) => c.ac === 'RP' && c.name.includes('override window') && c.name.includes('iii9'),
    (c) => c.ac === 'RP' && c.name.includes('override conf') && c.name.includes('jjj10'),
    (c) => c.ac === 'RP' && c.name.includes('small-gear untouched') && c.name.includes('lll12'),
  ];
  const mustPass = [
    (c) => c.ac === 'AC5' && c.name.includes('aaa1'),
    (c) => c.ac === 'AC1' && c.name.includes('label aaa1'),
    (c) => c.ac === 'RP' && c.name.includes('override separability') && c.name.includes('eee5'),
    (c) => c.ac === 'RP' && c.name.includes('override window') && c.name.includes('eee5'),
    (c) => c.ac === 'RP' && c.name.includes('small-gear untouched') && c.name.includes('kkk11'),
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
  const ov = r.algoDiag ? `ovr=${r.algoDiag.denseGateOverride} bc=${r.algoDiag.bcPeaks}` : 'no-algodiag';
  out(`${r.eventID.slice(0, 8)} ${r.ts} v=${v.appVersion} s=${v.sessionIndex} shot=${v.shotIndex} label=${v.label} tc=${r.toothCount} conf=${r.confidence} batt=${v.batteryLevel} ${acc} ${ov}`);
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
