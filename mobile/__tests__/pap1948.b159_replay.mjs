
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); const { decode } = require('jpeg-js');
const D = process.argv[2];
const gc = await import(path.resolve('mobile/src/algorithm/gearCounter.js'));
const { applyCircularMask } = await import(path.resolve('mobile/src/algorithm/imageUtils.js'));
const V = JSON.parse(fs.readFileSync(path.join(D,'verdicts.json')));
const rows=[];
for (const v of V) {
  const raw = decode(fs.readFileSync(path.join(D, v.id.slice(0,8)+'_cropped.jpg')), {useTArray:true, maxMemoryUsageInMB:2048});
  const ds = gc.bilinearDownsampleRgba(raw.data, raw.width, raw.height, 900);
  const {rgba,width:w,height:h}=ds;
  applyCircularMask(rgba,w,h,(w-1)/2,(h-1)/2,0.49*Math.min(w,h));
  const t=Date.now(); let r; try{ r=gc.countTeethFromRgba(rgba,w,h);}catch(e){r={err:String(e)}}
  const g=r.gearCenter||{}; const n=(x)=>x==null?null:+(x/w).toFixed(3);
  const row={id:v.id.slice(0,8),label:v.actualTeeth,dev:v.toothCount,devR:+v.r.toFixed(3),devCx:+v.cx.toFixed(3),devCy:+v.cy.toFixed(3),tc:r.toothCount,
    cx:n(g.x),cy:n(g.y),r:n(r.gearRadius),contourR:n(r.contourRadius),peakR:n(r.peakR),rOuter:n(r.rOuter),bcPeaks:r.bcPeaks,bcTc:r.bcTc,
    abst:r.abstainReason,method:r.methodUsed,ms:Date.now()-t};
  rows.push(row); console.log(JSON.stringify(row));
}
fs.writeFileSync(path.join(D,'host_rows.json'),JSON.stringify(rows,null,1));
