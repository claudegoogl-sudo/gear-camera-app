/**
 * PAP-1873 — AVM dense-telemetry analyzer (b158+ Auto-Validation Mode).
 *
 * When AVM auto-shares (Sentry debug_report events tagged validation='avm')
 * carry dense-class (40-60T) labeled shots, run THIS to produce the
 * observational verdict inputs for the PAP-1671 operator card:
 *   1. Census (pre-registered G2 convention, PAP-1865): is the +-1-correct
 *      tooth frequency present anywhere in the production multiRadiusFftScan
 *      candResults (rel>=0.04)? Splits dense failures into the two PAP-1865
 *      subclasses: signal-absent vs present-but-misselected.
 *   2. Committed accuracy: device gear.toothCount vs operator label (exact and
 *      +-1), confidence, abstention. Device rows are the measurement subject;
 *      the host census re-run is auxiliary and never overrides them.
 *   3. Focus/exposure covariates from photo.jpg EXIF (ExposureTime, ISO,
 *      FNumber, SubjectDistance, FocalLength) + descriptive median splits
 *      (n is far too small for inference; descriptive only).
 *
 * Scope guard: this tool changes NO production code and reuses ONLY the
 * QA-endorsed PAP-1865 census conventions and the PAP-1920 AVM payload shape
 * (docs/QA_AUTO_VALIDATION_MODE_SPEC_2026-09-18.md). AC1/AC2/AC4/AC5 scoring
 * stays QA's `pap1800.avm_b158_score.mjs`; the accept/ship decision stays
 * human-gated (PAP-1673/PAP-1671 chain).
 *
 * Class bands (project convention): Small 9-15, Mid 16-21 (PAP-1914),
 * Large 22-39, Dense/XL 40-65 (PAP-1865 dense = 40-60).
 *
 * Plain node (PAP-1672: jest babel inflation ~6.8x; node = honest host number).
 * Usage:
 *   node --import ./mobile/__tests__/lib/node-esm-stubs.mjs \
 *        mobile/__tests__/pap1873.avm_dense_analyze.mjs [nPages] [--event <shortId>]
 *   ... --selftest           hermetic mechanics check (synthetic gear + EXIF)
 *
 * Auth: SENTRY_ORG / SENTRY_PROJECT / SENTRY_TRIAGE_TOKEN from repo .env
 * (same conventions as scripts/sentry-ac3-read.py).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode, encode: jpegEncode } = require('jpeg-js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const API = 'https://sentry.io/api/0';
const TARGET = 900;
const CENSUS_REL = 0.04;          // PAP-1865 census convention
const DENSE_LO = 40, DENSE_HI = 60; // PAP-1865 dense band
const out = (s) => process.stdout.write(s + '\n');

const gc = await import('../src/algorithm/gearCounter.js');
const T = gc.__test; // findGearCenter, multiRadiusFftScan
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;
const pp = await import('../src/algorithm/preprocess.js');

// ---------- env ----------
function parseEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* .env optional in selftest mode */ }
  return env;
}

// ---------- sentry read (conventions: scripts/sentry-ac3-read.py) ----------
async function sentryFetch(url, tok) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r;
}
async function sentryGet(url, tok) { return (await sentryFetch(url, tok)).json(); }

async function listEvents(org, proj, tok, pages) {
  let url = `${API}/projects/${org}/${proj}/events/?full=true&per_page=100`;
  const ids = [];
  for (let p = 0; p < pages; p++) {
    const r = await sentryFetch(url, tok);
    const data = await r.json();
    ids.push(...data.map((e) => e.eventID));
    const link = r.headers.get('link') || '';
    const nextSeg = link.split(',').find((s) => s.includes('rel="next"') && s.includes('results="true"'));
    if (!nextSeg) break;
    const m = nextSeg.match(/<([^>]+)>/);
    if (!m) break;
    url = m[1];
  }
  return ids;
}

function tagsOf(ev) { return Object.fromEntries((ev.tags || []).map((t) => [t.key, t.value])); }
function ctxOf(ev, key) { return (ev.contexts && ev.contexts[key]) || null; }

function extractRow(ev) {
  const tg = tagsOf(ev);
  const vs = ctxOf(ev, 'validationSession') || {};
  const gear = ctxOf(ev, 'gear') || {};
  const isAvm = tg.validation === 'avm' || !!ctxOf(ev, 'validationSession');
  const label = vs.label ?? null;
  const tc = gear.toothCount ?? null;
  const conf = gear.confidence ?? null;
  return {
    eventID: ev.eventID, ts: ev.dateCreated,
    kind: tg.kind || null, buildLabel: tg.buildLabel || null,
    appVersion: vs.appVersion || null, sessionIndex: vs.sessionIndex ?? null,
    shotIndex: vs.shotIndex ?? null, label, batteryLevel: vs.batteryLevel ?? null,
    schemaVersion: vs.schemaVersion ?? null, isAvm,
    tc, conf,
    committedClass: classOf(tc), labelClass: classOf(label),
    labelMatchesTc: label != null && tc != null ? label === tc : null,
    abstained: tc === 0,
    algorithmRuntimeMs: gear.algorithmRuntimeMs ?? null,
    policyRetryCount: gear.policyRetryCount ?? null,
    innerContourSuspected: gear.innerContourSuspected ?? null,
    nCameraEvents: Array.isArray((ctxOf(ev, 'camera') || {}).cameraEvents)
      ? ctxOf(ev, 'camera').cameraEvents.length : 0,
  };
}

function classOf(n) {
  if (n == null) return null;
  if (n >= DENSE_LO && n <= 65) return 'dense';
  if (n >= 22) return 'large';
  if (n >= 16) return 'mid';
  if (n >= 9) return 'small';
  return 'out-of-range';
}

async function downloadAttachments(ev, org, proj, tok, names, dir, shortId) {
  const got = {};
  try {
    const atts = await sentryGet(`${API}/projects/${org}/${proj}/events/${ev.eventID}/attachments/`, tok);
    for (const name of names) {
      const a = (atts || []).find((x) => x.name === name);
      if (!a) continue;
      const r = await fetch(`${API}/projects/${org}/${proj}/events/${ev.eventID}/attachments/${a.id}/?download=1`,
        { headers: { Authorization: `Bearer ${tok}` } });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1000) continue;
      const p = path.join(dir, `${shortId}_${name}`);
      fs.writeFileSync(p, buf);
      got[name] = p;
    }
  } catch (e) { out(`[warn] attachments ${shortId}: ${e.message}`); }
  return got;
}

// ---------- census (PAP-1865 G2 convention) ----------
function censusOnJpeg(buf, label) {
  const raw = jpegDecode(buf, { useTArray: true });
  const ds = gc.bilinearDownsampleRgba(raw.data, raw.width, raw.height, TARGET);
  const { rgba, width: w, height: h } = ds;
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  const { gray, enhanced, edges } = pp.JS_BACKEND.run(rgba, w, h);
  const deadline = Date.now() + 45000;
  const budgetState = { hit: false };
  const c = T.findGearCenter(gray, enhanced, edges, w, h, deadline, budgetState);
  const cx = c.cx, cy = c.cy, contourRadius = c.radius || 0;
  let scan = null;
  try {
    scan = T.multiRadiusFftScan(enhanced, edges, cx, cy, contourRadius, w, h, 0.5 * Math.min(w, h));
  } catch { /* census unavailable on degenerate center */ }
  const cands = scan ? scan.candResults.map((cr) => ({ r: cr.r, tc: cr.tc, rel: Number(cr.rel.toFixed(4)) })) : [];
  const present = label != null
    ? cands.some((cd) => Math.abs(cd.tc - label) <= 1 && cd.rel >= CENSUS_REL)
    : null;
  const near = label != null
    ? cands.filter((cd) => Math.abs(cd.tc - label) <= 1).sort((a, b) => b.rel - a.rel)[0] || null
    : null;
  const best = cands.slice().sort((a, b) => b.rel - a.rel)[0] || null;
  return {
    cx: Math.round(cx), cy: Math.round(cy), contourRadius: Math.round(contourRadius),
    nCands: cands.length, signalPresent: present,
    nearCand: near ? { tc: near.tc, rel: near.rel } : null,
    bestCand: best ? { tc: best.tc, rel: best.rel } : null,
  };
}

// ---------- minimal EXIF reader (photo.jpg covariates) ----------
const EXIF_TAGS = {
  0x829a: ['exposureTime', 'rational'], 0x829d: ['fNumber', 'rational'],
  0x8827: ['iso', 'short'], 0x9206: ['subjectDistance', 'rational'],
  0x920a: ['focalLength', 'rational'], 0x9204: ['exposureBias', 'srational'],
};
function parseExif(buf) {
  const res = { exposureTime: null, iso: null, fNumber: null, subjectDistance: null, focalLength: null, exposureBias: null };
  try {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) return res;
    let o = 2;
    while (o + 4 < buf.length) {
      if (buf[o] !== 0xff) break;
      const marker = buf[o + 1], len = (buf[o + 2] << 8) | buf[o + 3];
      if (marker === 0xe1 && buf.toString('ascii', o + 4, o + 10) === 'Exif\0\0') {
        const tiff = o + 10;
        const le = buf.toString('ascii', tiff, tiff + 2) === 'II';
        const u16 = (p) => le ? buf[p] | (buf[p + 1] << 8) : (buf[p] << 8) | buf[p + 1];
        const u32 = (p) => le
          ? (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0
          : ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]) >>> 0;
        const readIfd = (ifdOff) => {
          const n = u16(tiff + ifdOff);
          for (let i = 0; i < n; i++) {
            const e = tiff + ifdOff + 2 + i * 12;
            const tag = u16(e), typ = u16(e + 2), cnt = u32(e + 4);
            const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
            const sz = (sizes[typ] || 1) * cnt;
            const voff = sz <= 4 ? e + 8 : tiff + u32(e + 8);
            const hit = EXIF_TAGS[tag];
            if (!hit) continue;
            const [name, kind] = hit;
            const num = (p) => u32(p);
            const den = (p) => u32(p + 4);
            if (kind === 'short') res[name] = u16(voff);
            else {
              const p = num(voff), q = den(voff);
              res[name] = q !== 0 ? p / q : null;
            }
          }
          return u32(tiff + ifdOff + 2 + n * 12);
        };
        let next = readIfd(u32(tiff + 4));
        while (next) next = readIfd(next);
        return res;
      }
      o += 2 + len;
    }
  } catch { /* best-effort covariates only */ }
  return res;
}

// ---------- main ----------
function denseVerdict(rows) {
  const denseLabeled = rows.filter((r) => r.label != null && r.labelClass === 'dense');
  if (!denseLabeled.length) return 'no dense labeled AVM shots yet';
  const present = denseLabeled.filter((r) => r.census && r.census.signalPresent).length;
  const exact = denseLabeled.filter((r) => r.labelMatchesTc === true).length;
  const near1 = denseLabeled.filter((r) => r.label != null && r.tc != null && Math.abs(r.tc - r.label) <= 1).length;
  const wrongConfident = denseLabeled.filter((r) => r.tc != null && r.tc !== 0 && r.label != null && Math.abs(r.tc - r.label) > 1).length;
  let subclass;
  if (present === 0) subclass = 'signal-absent dominated (capture-side levers only, PAP-1671 card)';
  else if (present / denseLabeled.length >= 0.3) subclass = 'present-but-misselected share material (selection-side candidate admissible; needs QA cross-check)';
  else subclass = 'mixed/weak signal — no subclass call at this n';
  return `dense labeled n=${denseLabeled.length}: census-present ${present}/${denseLabeled.length}, committed exact ${exact}, +-1 ${near1}, confident-wrong ${wrongConfident} -> ${subclass}`;
}

function covariateSplits(rows) {
  const denseLabeled = rows.filter((r) => r.label != null && r.labelClass === 'dense' && r.census);
  const lines = [];
  for (const key of ['exposureTime', 'iso', 'fNumber', 'subjectDistance', 'focalLength']) {
    const vals = denseLabeled.map((r) => r.exif[key]).filter((v) => v != null && v > 0);
    if (vals.length < 4) continue;
    const sorted = vals.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const hi = denseLabeled.filter((r) => r.exif[key] != null && r.exif[key] >= med);
    const lo = denseLabeled.filter((r) => r.exif[key] != null && r.exif[key] < med);
    const rate = (g) => {
      const withC = g.filter((r) => r.census.signalPresent != null);
      const p = withC.filter((r) => r.census.signalPresent).length;
      return `${p}/${withC.length}`;
    };
    lines.push(`  ${key} median=${Number(med.toPrecision(4))}: census-present low=${rate(lo)} high=${rate(hi)}`);
  }
  return lines.length ? lines.join('\n') : '  (covariates absent/insufficient)';
}

function emitOutputs(rows, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rows.json'), JSON.stringify(rows, null, 1));
  const hdr = 'eventID,ts,appVersion,sess,shot,label,labelClass,tc,conf,abstained,exact,signalPresent,nearCand,bestCand,nCands,exposureTime,iso,fNumber,subjectDistance,focalLength,photo';
  const lines = rows.map((r) => [
    r.eventID.slice(0, 8), r.ts, r.appVersion, r.sessionIndex, r.shotIndex,
    r.label, r.labelClass, r.tc, r.conf, r.abstained, r.labelMatchesTc,
    r.census ? r.census.signalPresent : null,
    r.census && r.census.nearCand ? `${r.census.nearCand.tc}@${r.census.nearCand.rel}` : null,
    r.census && r.census.bestCand ? `${r.census.bestCand.tc}@${r.census.bestCand.rel}` : null,
    r.census ? r.census.nCands : null,
    r.exif.exposureTime, r.exif.iso, r.exif.fNumber, r.exif.subjectDistance, r.exif.focalLength,
    r.photoFile ? path.basename(r.photoFile) : '',
  ].map((v) => v == null ? '' : String(v)).join(','));
  fs.writeFileSync(path.join(dir, 'rows.csv'), hdr + '\n' + lines.join('\n') + '\n');
}

async function main() {
  const env = parseEnv();
  const org = env.SENTRY_ORG, proj = env.SENTRY_PROJECT, tok = env.SENTRY_TRIAGE_TOKEN;
  if (!org || !proj || !tok) { out('missing SENTRY_ORG/SENTRY_PROJECT/SENTRY_TRIAGE_TOKEN in repo .env'); process.exit(1); }
  const args = process.argv.slice(2);
  const eventIdx = args.indexOf('--event');
  const pages = Math.max(1, parseInt(args.find((a) => /^\d+$/.test(a)) || '1', 10));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const dir = path.join(ROOT, 'debug-reports', `pap1873_avm_dense_${stamp}`);

  let ids;
  if (eventIdx >= 0) ids = [args[eventIdx + 1]];
  else ids = await listEvents(org, proj, tok, pages);
  fs.mkdirSync(dir, { recursive: true });
  out(`[avm-dense] scanning ${ids.length} events (pages=${pages})`);

  const rows = [];
  for (const eid of ids) {
    const ev = await sentryGet(`${API}/projects/${org}/${proj}/events/${eid}/`, tok);
    const row = extractRow(ev);
    // --event mode also accepts manual debug_report shares (read-path validation
    // on already-landed events, e.g. b157 ace8f58c); live sweeps require AVM tags.
    if (!row.isAvm && eventIdx < 0) continue;
    const shortId = eid.slice(0, 8);
    // Corpus convention (PAP-1609/1865): census input = device cropped.jpg
    // (the aim crop the device pipeline itself sees); EXIF covariates = full photo.jpg.
    const files = await downloadAttachments(ev, org, proj, tok, ['photo.jpg', 'cropped.jpg'], dir, shortId);
    const photoPath = files['photo.jpg'] || files['cropped.jpg'] || null;
    row.exif = photoPath ? parseExif(fs.readFileSync(photoPath)) : { exposureTime: null, iso: null, fNumber: null, subjectDistance: null, focalLength: null, exposureBias: null };
    row.photoFile = photoPath;
    row.census = null;
    const cropPath = files['cropped.jpg'] || files['photo.jpg'] || null;
    if (cropPath) {
      const t0 = Date.now();
      try { row.census = censusOnJpeg(fs.readFileSync(cropPath), row.label); row.censusMs = Date.now() - t0; }
      catch (e) { row.censusError = String(e.message || e).slice(0, 200); }
    }
    rows.push(row);
    const s = row.census;
    out(`${shortId} ${row.ts} sess=${row.sessionIndex} shot=${row.shotIndex} label=${row.label}(${row.labelClass}) tc=${row.tc} conf=${row.conf} census=${s ? (s.signalPresent === null ? 'n/a' : s.signalPresent ? 'PRESENT' : 'absent') : (row.censusError || 'no-photo')} near=${s && s.nearCand ? `${s.nearCand.tc}@${s.nearCand.rel}` : '-'}`);
  }

  emitOutputs(rows, dir);
  out(`\n[avm-dense] rows=${rows.length} -> ${dir}{/rows.json,/rows.csv}`);
  out(`[avm-dense] VERDICT INPUTS: ${denseVerdict(rows)}`);
  out('[avm-dense] covariate splits (descriptive):');
  out(covariateSplits(rows));
  out('[avm-dense] NOTE: accept/ship decision stays human-gated (PAP-1671/PAP-1673 chain); AC scoring = pap1800.avm_b158_score.mjs');
}

// ---------- selftest: hermetic mechanics (synthetic gear + EXIF) ----------
function synthGearJpeg(nTeeth, size = 1400) {
  const w = size, h = size, data = new Uint8Array(w * h * 4).fill(255);
  const cx = w / 2, cy = h / 2, rIn = 380, rOut = 500;
  const set = (x, y, v) => { const i = (y * w + x) * 4; data[i] = data[i + 1] = data[i + 2] = v; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy);
    if (r < 60) { set(x, y, 30); continue; }               // bore
    if (r < rIn) { set(x, y, 40); continue; }              // dark web
    if (r <= rOut) {
      // An N-tooth gear = N dark teeth + N gaps = 2N sectors.
      const ang = Math.atan2(dy, dx) + Math.PI;            // [0,2pi)
      const tooth = Math.floor((ang / (2 * Math.PI)) * 2 * nTeeth) % 2;
      set(x, y, tooth ? 20 : 235);
    }
  }
  return Buffer.from(jpegEncode({ data, width: w, height: h }, 85).data);
}

function synthExifJpeg(baseJpeg, exposureDen, iso, fNumber) {
  // Minimal little-endian EXIF APP1: ExposureTime=1/exposureDen, ISO, FNumber.
  const mk = () => { const b = []; return {
    u8: (v) => b.push(v & 255),
    u16: (v) => b.push(v & 255, (v >> 8) & 255),
    u32: (v) => b.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255),
    buf: () => Uint8Array.from(b),
  }; };
  const IFD0 = 8, N = 3, ifdSize = 2 + N * 12 + 4, dataStart = IFD0 + ifdSize;
  const rational = (p, q) => { const m = mk(); m.u32(p); m.u32(q); return m.buf(); };

  const exposure = rational(1, exposureDen);       // 8B
  const fnum = rational(Math.round(fNumber * 10), 10); // 8B
  // entry order must match offset layout: two offset-valued entries first
  const e1off = dataStart, e2off = dataStart + 8;  // data area holds both rationals
  const entry = (tag, typ, cnt, val) => { const m = mk(); m.u16(tag); m.u16(typ); m.u32(cnt); for (const x of val) m.u8(x); return m.buf(); };
  const inline4 = (v) => Uint8Array.from([v & 255, (v >> 8) & 255, 0, 0]);
  const entries = [
    entry(0x829a, 5, 1, (() => { const m = mk(); m.u32(e1off); return m.buf(); })()),
    entry(0x8827, 3, 1, inline4(iso)),
    entry(0x829d, 5, 1, (() => { const m = mk(); m.u32(e2off); return m.buf(); })()),
  ];
  const head = mk();
  for (const ch of 'II') head.u8(ch.charCodeAt(0));
  head.u16(0x2a); head.u32(IFD0); head.u16(N);
  for (const e of entries) for (const x of e) head.u8(x);
  head.u32(0); // next IFD
  const tiff = Uint8Array.from([...head.buf(), ...exposure, ...fnum]);
  const app1Body = Uint8Array.from([...Buffer.from('Exif\x00\x00', 'ascii'), ...tiff]);
  const app1 = Uint8Array.from([0xff, 0xe1, (app1Body.length + 2 >> 8) & 255, (app1Body.length + 2) & 255, ...app1Body]);
  return Buffer.concat([baseJpeg.subarray(0, 2), app1, baseJpeg.subarray(2)]);
}

async function selftest() {
  let fail = 0;
  const check = (name, cond, detail) => { out(`  ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); if (!cond) fail++; };

  // 1. census mechanics on a drawn 44T ring
  const N = 44;
  const buf = synthGearJpeg(N);
  const c = censusOnJpeg(buf, N);
  check('synth44 census ran', !!c && c.nCands > 0, `nCands=${c && c.nCands}`);
  check('synth44 signal present (±1, rel>=0.04)', c.signalPresent === true,
    c.nearCand ? `near=${c.nearCand.tc}@${c.nearCand.rel}` : 'no near cand');
  check('synth44 signal NOT claimed for wrong label', censusOnJpeg(buf, 55).signalPresent === false,
    '55T probe on a 44T ring');

  // 2. EXIF parser mechanics
  const base = synthGearJpeg(12, 400);
  const withExif = synthExifJpeg(base, 120, 200, 1.8);
  const ex = parseExif(withExif);
  check('exif exposureTime 1/120', Math.abs((ex.exposureTime || 0) - 1 / 120) < 1e-6, `${ex.exposureTime}`);
  check('exif iso 200', ex.iso === 200, `${ex.iso}`);
  check('exif fNumber 1.8', Math.abs((ex.fNumber || 0) - 1.8) < 1e-6, `${ex.fNumber}`);
  const exNone = parseExif(base);
  check('exif absent -> nulls', exNone.iso == null && exNone.exposureTime == null);

  // 3. extractRow mapping on a synthetic payload
  const fake = {
    eventID: 'deadbeef1234', dateCreated: '2026-09-19T00:00:00.000Z',
    tags: [{ key: 'kind', value: 'debug_report' }, { key: 'buildLabel', value: 'v1.0.0 (158)' }, { key: 'validation', value: 'avm' }],
    contexts: {
      validationSession: { appVersion: 'v1.0.0 (158)', sessionIndex: 0, shotIndex: 3, shotsRemaining: 6, label: 52, batteryLevel: 0.7, schemaVersion: 1 },
      gear: { toothCount: 36, confidence: 0.81, algorithmRuntimeMs: 29100 },
      camera: { cameraEvents: [1, 2, 3] },
    },
  };
  const r = extractRow(fake);
  check('row: avm detected', r.isAvm === true);
  check('row: label class dense', r.labelClass === 'dense', `${r.labelClass}`);
  check('row: committed class large + mismatch flagged', r.committedClass === 'large' && r.labelMatchesTc === false);
  check('row: abstained false', r.abstained === false);

  out(fail ? `\nSELFTEST FAILED (${fail})` : '\nSELFTEST PASS (mechanics only — never a measurement)');
  process.exit(fail ? 1 : 0);
}

const arg = process.argv[2];
if (arg === '--selftest') await selftest();
else await main();
