import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decode } = require('jpeg-js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const gc = await import('../src/algorithm/gearCounter.js');
console.log = () => {};
const TD = path.join(ROOT,'training-data');
const CACHE = path.join(ROOT,'.cache','training-rgba');
const stamps = fs.readdirSync(TD).filter(f=>f.endsWith('_meta.json')).sort().filter((_,i)=>i%60===0).slice(0,6);
for (const f of stamps) {
  const stamp = f.replace('_meta.json','');
  const bin = path.join(CACHE, `${stamp}_900.bin`), mp = path.join(CACHE, `${stamp}_900.meta.json`);
  if (!fs.existsSync(bin)) continue;
  const m = JSON.parse(fs.readFileSync(mp,'utf8'));
  const buf = fs.readFileSync(bin); const rgba = new Uint8Array(buf.byteLength); rgba.set(buf);
  gc.countTeethFromRgba(rgba, m.width, m.height);
}
