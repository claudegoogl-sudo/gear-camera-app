/**
 * PAP-1898 option probe — measure two candidate localization fixes on the 5
 * audited b153 crops:
 *   A) prior-weighted re-selection over the EXISTING candidate dump
 *      w = purity * exp(-dC^2/(2*sigma^2)) * priorR(r/aimR)
 *   B) silhouette anchor: mask-boundary inward walk per angle + trimmed
 *      algebraic circle fit (Kasa + 30% trim x3) -> (cx, cy, r)
 * Truth = PAP-1897 audit annotations (crop fractions).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decode: jpegDecode } = require('jpeg-js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EV = path.join(ROOT, 'debug-reports', 'pap1897_fp5_b153_session_2026-09-11');
const OUT = path.join(ROOT, 'debug-reports', 'pap1898_localization_2026-09-12');

globalThis.__PAP1898_DEBUG = 1;
const gc = await import('../src/algorithm/gearCounter.js');
const { bilinearDownsampleRgba, __test } = gc;
const iu = await import('../src/algorithm/imageUtils.js');
const { applyCircularMask } = iu;
const pp = await import('../src/algorithm/preprocess.js');

const TRUTH = {
  f5886a846722: { label: 52, cx: 0.50, cy: 0.50, r: 0.450 },
  af9294fe87f0: { label: 50, cx: 0.50, cy: 0.49, r: 0.435 },
  caa1725c6bae: { label: 42, cx: 0.50, cy: 0.49, r: 0.450 },
  f3a8e88a13d8: { label: 36, cx: 0.50, cy: 0.49, r: 0.400 },
  '92e4b255112c': { label: 24, cx: 0.44, cy: 0.47, r: 0.250 },
};
const out = (s) => process.stdout.write(s + '\n');

// --- Option B: silhouette walk + trimmed circle fit ---
const N_ANG = 720;
function silhouettePoints(edges, cx, cy, maskR, w, h) {
  const pts = [];
  for (let i = 0; i < N_ANG; i++) {
    const a = (2 * Math.PI * i) / N_ANG;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let r = maskR - 6; r >= 12; r--) {
      const px = Math.round(cx + r * ca), py = Math.round(cy + r * sa);
      if (px < 0 || px >= w || py < 0 || py >= h) continue;
      if (edges[py * w + px] > 0) { pts.push({ x: px, y: py, ang: i }); break; }
    }
  }
  return pts;
}
function kasaFit(pts) {
  // algebraic circle fit: minimize sum (x^2+y^2 + D x + E y + F)^2
  let sx=0,sy=0,sxx=0,syy=0,sxy=0,sxz=0,syz=0,sz=0; const n=pts.length;
  for (const p of pts) {
    const z = p.x*p.x + p.y*p.y;
    sx+=p.x; sy+=p.y; sxx+=p.x*p.x; syy+=p.y*p.y; sxy+=p.x*p.y;
    sxz+=p.x*z; syz+=p.y*z; sz+=z;
  }
  // solve [ sxx sxy sx ; sxy syy sy ; sx sy n ] [D E F]^T = [-sxz -syz -sz]
  const m = [[sxx,sxy,sx,-sxz],[sxy,syy,sy,-syz],[sx,sy,n,-sz]];
  for (let i=0;i<3;i++){
    let piv=i;
    for (let j=i+1;j<3;j++) if (Math.abs(m[j][i])>Math.abs(m[piv][i])) piv=j;
    [m[i],m[piv]]=[m[piv],m[i]];
    if (Math.abs(m[i][i])<1e-9) return null;
    for (let j=i+1;j<3;j++){
      const f=m[j][i]/m[i][i];
      for (let k=i;k<4;k++) m[j][k]-=f*m[i][k];
    }
  }
  const x=[0,0,0];
  for (let i=2;i>=0;i--){
    let s=m[i][3];
    for (let k=i+1;k<3;k++) s-=m[i][k]*x[k];
    x[i]=s/m[i][i];
  }
  const [D,E,F]=x;
  const cx=-D/2, cy=-E/2, r=Math.sqrt(Math.max(0,cx*cx+cy*cy-F));
  return { cx, cy, r };
}
function silhouetteCircleFit(edges, w, h) {
  const cx0=(w-1)/2, cy0=(h-1)/2, maskR=0.49*Math.min(w,h);
  const pts = silhouettePoints(edges, cx0, cy0, maskR, w, h);
  const coverage = pts.length / N_ANG;
  let cur = pts.slice();
  let fit = null;
  for (let iter=0; iter<4 && cur.length>30; iter++) {
    fit = kasaFit(cur);
    if (!fit) return { coverage, fit: null };
    const res = cur.map(p => ({ p, d: Math.abs(Math.hypot(p.x-fit.cx, p.y-fit.cy) - fit.r) }));
    res.sort((a,b)=>a.d-b.d);
    cur = res.slice(0, Math.max(30, Math.floor(cur.length*0.7))).map(e=>e.p);
  }
  return { coverage, fit };
}

const rows = [];
for (const [stamp, truth] of Object.entries(TRUTH)) {
  const photo = path.join(EV, `${stamp}_cropped.jpg`);
  const raw = jpegDecode(fs.readFileSync(photo), { useTArray: true });
  const ds = bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
  const { rgba, width: w, height: h } = ds;
  applyCircularMask(rgba, w, h, (w - 1) / 2, (h - 1) / 2, 0.49 * Math.min(w, h));
  const { gray, enhanced, edges } = pp.preprocess(rgba, w, h);
  __test.findGearCenter(gray, enhanced, edges, w, h, Infinity, { hit: false });
  const dbg = globalThis.__PAP1898_LAST;

  const tcx=truth.cx*w, tcy=truth.cy*h, tr=truth.r*w;
  const aimR = 0.5*Math.min(w,h);

  // Option A: prior-weighted re-selection over existing candidates.
  // w = purity * exp(-dC^2/(2*(0.10*aimR)^2)) * priorR, priorR peaked in [0.70,1.00] of aimR
  const sigma = 0.10*aimR;
  let bestA=null, bestW=-1;
  for (const c of dbg.candidates) {
    const dC = Math.hypot(c.cx - aimR, c.cy - aimR);
    const priorC = Math.exp(-(dC*dC)/(2*sigma*sigma));
    const rn = c.r/aimR;
    const priorR = rn<=0 ? 0 : (rn>=0.70 ? 1.0 : Math.max(0.05, rn/0.70));
    const wgt = (c.purity||0) * priorC * priorR;
    if (wgt>bestW){bestW=wgt;bestA={...c,w:+wgt.toFixed(4)};}
  }

  // Option B: silhouette fit
  const t0=Date.now();
  const { coverage, fit } = silhouetteCircleFit(edges, w, h);
  const msB = Date.now()-t0;

  const err=(c)=>c?{dc:+(100*Math.hypot(c.cx-tcx,c.cy-tcy)/w).toFixed(1), dr:+(100*Math.abs(c.r-tr)/tr).toFixed(1)}:null;
  rows.push({stamp,label:truth.label,
    truth:{cx:Math.round(tcx),cy:Math.round(tcy),r:Math.round(tr)},
    A:{picked:bestA, err:err(bestA)},
    B:{fit:fit&&{cx:Math.round(fit.cx),cy:Math.round(fit.cy),r:Math.round(fit.r)}, coverage:+coverage.toFixed(2), ms:msB, err:fit&&err(fit)},
  });
  out(`${stamp} ${truth.label}T truth=(${Math.round(tcx)},${Math.round(tcy)},r${Math.round(tr)})`);
  out(`  A: ${bestA?`(${bestA.cx},${bestA.cy},r${bestA.r}) w=${bestA.w} err=${JSON.stringify(rows[rows.length-1].A.err)}`:'none'}`);
  out(`  B: ${fit?`(${fit.cx.toFixed(0)},${fit.cy.toFixed(0)},r${fit.r.toFixed(0)}) cov=${coverage.toFixed(2)} ms=${msB} err=${JSON.stringify(rows[rows.length-1].B.err)}`:`no fit (cov=${coverage.toFixed(2)})`}`);
}
fs.writeFileSync(path.join(OUT,'options_probe_rows.json'), JSON.stringify(rows,null,2));
out('\nWROTE options_probe_rows.json');
