import json,sys,collections
# PRE-REGISTERED predicates (PAP-1996). Abstain if predicate TRUE on an answered row.
def agree(f,tc): return sum(1 for k in("bcTc","peakTc","fft90tc","opTc") if f.get(k)==tc)
P={
"P1_bc_peaks_gt2":lambda f,tc: f.get("bcPeaks") is not None and abs(f["bcPeaks"]-tc)>2,
"P2_peakTc_ne":lambda f,tc: f.get("peakTc")!=tc,
"P3_fft90_ne":lambda f,tc: f.get("fft90tc")!=tc,
"P4_opTc_ne":lambda f,tc: f.get("opTc")!=tc,
"P5_agree_lt3":lambda f,tc: agree(f,tc)<3,
"P6_P1_or_P5":lambda f,tc: P["P1_bc_peaks_gt2"](f,tc) or agree(f,tc)<3,
"P7_agree_lt2":lambda f,tc: agree(f,tc)<2,
}
rows=json.load(open("debug-reports/pap1983/rows_head.json"))
ans=[r for r in rows if not r["abstain"]]
def tri(rs):
    ok=sum(r["correct"] for r in rs);return ok,len(rs)-ok
base=tri(ans);print("rows",len(rows),"answers",len(ans),"base ok/wrong",base,"abstain",len(rows)-len(ans))
days=collections.Counter(r["stamp"][:10] for r in rows);print("days",len(days))
for n,p in P.items():
    kept=[r for r in ans if not p(r["feat"],r["tc"])]
    ok,w=tri(kept);F=len(ans)-len(kept)
    lost_ok=sum(r["correct"] for r in ans if p(r["feat"],r["tc"]))
    # LODO: predicate is fixed (no fitted params) so LODO = per-day wrongs-kept
    pd=collections.Counter(r["stamp"][:10] for r in kept if not r["correct"])
    print(n,"ok",ok,"wrong",w,"pct %.1f"%(100*ok/max(1,ok+w)),"newAbstain",F,"(correct lost %d, wrong caught %d)"%(lost_ok,base[1]-w),"daysWithWrong",len(pd))
