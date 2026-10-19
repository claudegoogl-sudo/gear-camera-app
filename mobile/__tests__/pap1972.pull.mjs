
import fs from 'node:fs';import https from 'node:https';
const env={};for(const l of fs.readFileSync('.env','utf8').split('\n')){const m=l.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);if(m)env[m[1]]=m[2];}
const tok=env.SENTRY_TRIAGE_TOKEN||env.SENTRY_AUTH_TOKEN,org=env.SENTRY_ORG,proj=env.SENTRY_PROJECT,API='https://sentry.io/api/0';
const g=u=>new Promise((res,rej)=>https.get(API+u,{headers:{Authorization:'Bearer '+tok}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>r.statusCode==200?res(JSON.parse(b)):rej(r.statusCode))}));
const by=new Map();const add=rows=>{let n=0;for(const e of rows||[])if(e.eventID&&!by.has(e.eventID)){by.set(e.eventID,e);n++}return n};
const paths=[];for(const c of ['','&cursor=0:10:0','&cursor=10:10:0','&cursor=20:10:0']){paths.push(`/projects/${org}/${proj}/events/?full=true&per_page=10${c}`);paths.push(`/projects/${org}/${proj}/events/?full=true&per_page=10&sort=-ts_event_timestamp${c}`);}
const iss=await g(`/projects/${org}/${proj}/issues/?per_page=100&statsPeriod=14d`);
for(const i of iss)for(const c of ['','&cursor=0:10:0','&cursor=10:10:0','&cursor=20:10:0','&cursor=30:10:0','&cursor=40:10:0'])paths.push(`/organizations/${org}/issues/${i.id}/events/?per_page=10&sort=-ts_event_timestamp&full=true${c}`);
for(let r=0;r<4;r++){let f=0;for(const p of paths){try{f+=add(await g(p))}catch(e){}}if(!f)break;}
const rows=[];
for(const e of by.values()){const t={};for(const x of e.tags||[])t[x.key]=x.value;const gc=(e.contexts||{}).gear||{};const d=gc.algoDiag||{};
rows.push({id:e.eventID,ts:e.dateCreated,dist:e.dist??t.dist,build:t.buildLabel||t.release,dev:t.device,tc:gc.toothCount,conf:gc.confidence,stage:d.stageMs||null,be:d.budgetExhausted,keys:Object.keys(d).slice(0,40)});}
fs.writeFileSync('/tmp/pap1972_rows.json',JSON.stringify(rows));console.log(rows.length,iss.length);
