// PAP-2022 bit-parity: native morphClose/Open/labelComponents vs JS on real-photo masks + noise.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process'; import { pathToFileURL, fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { __morphRefs: J } = await import(pathToFileURL(path.join(HERE, '../src/algorithm/gearCounter.js')).href);
const CLI = process.env.CLI; const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'morph-'));
function mulberry(a){return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const cases = [];
const W = 900, H = 900;
for (const [seed, dens] of [[1,.3],[2,.5],[3,.7],[4,.9]]) { const r = mulberry(seed); const m = new Uint8Array(W*H); for (let i=0;i<m.length;i++) m[i]=r()<dens?1:0; cases.push({name:`noise${dens}`,m,w:W,h:H}); }
// blob/ring masks emulating gears
for (const [cx,cy,R,teeth] of [[450,450,300,24],[400,500,350,48],[450,450,420,12]]) { const m=new Uint8Array(W*H); for(let y=0;y<H;y++)for(let x=0;x<W;x++){const dx=x-cx,dy=y-cy,d=Math.hypot(dx,dy),a=Math.atan2(dy,dx);const rr=R*(1+0.05*Math.sign(Math.sin(a*teeth)));if(d<rr&&d>R*0.3)m[y*W+x]=1;} cases.push({name:`gear${teeth}`,m,w:W,h:H}); }
cases.push({name:'tiny',m:Uint8Array.from([1,0,1,1,1,0,0,1,1]),w:3,h:3});
cases.push({name:'odd',m:(()=>{const r=mulberry(9);const m=new Uint8Array(37*23);for(let i=0;i<m.length;i++)m[i]=r()<.6?1:0;return m})(),w:37,h:23});
let bad = 0, nat = 0, js = 0;
for (const c of cases) for (const rad of [1, 2]) for (const tv of [1, 0]) {
  const f = path.join(tmp, 'm.bin'); fs.writeFileSync(f, c.m);
  const out = path.join(tmp, 'o');
  const reps = c.w===900 ? 3 : 1;
  const ms = Number(execFileSync(CLI, [f, c.w, c.h, rad, tv, out, reps]).toString()); nat += ms;
  const rd = (s) => fs.readFileSync(out + s);
  let t = Date.now();
  const cl = J.morphClose_raw(c.m, c.w, c.h, rad), op = J.morphOpen_raw(c.m, c.w, c.h, rad), lc = J.labelComponents_raw(c.m, c.w, c.h, tv);
  js += Date.now() - t;
  const eq = (a, b) => Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), b) === 0;
  const comps = []; for (const k of lc.components) comps.push(k.id,k.area,k.sx,k.sy,k.minX,k.minY,k.maxX,k.maxY,k.touchesBorder?1:0);
  const ok = eq(cl, rd('.close')) && eq(op, rd('.open')) && eq(lc.labels, rd('.labels')) && eq(new Float64Array(comps), rd('.comps'));
  if (!ok) { bad++; console.log('MISMATCH', c.name, rad, tv); }
}
console.log(JSON.stringify({ cases: cases.length * 4, mismatches: bad, nativeMsTotal: +nat.toFixed(1), jsMsTotal: js }));
process.exit(bad ? 1 : 0);
