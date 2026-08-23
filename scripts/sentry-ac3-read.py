#!/usr/bin/env python3
"""PAP-1703 AC3 verdict reader.

Pulls recent gear-camera-app events from Sentry, extracts algoDiag stageMs +
the PAP-1700 `preprocess_backend` tag, and prints the AC3 pass/fail verdict for
a given build against the device-measured JS baseline.

Usage:
  scripts/sentry-ac3-read.py --build 140
  scripts/sentry-ac3-read.py --build 140 --out debug-reports/pap1703_sentry

Auth: reads SENTRY_TRIAGE_TOKEN / SENTRY_ORG / SENTRY_PROJECT from repo .env.
"""
import argparse, json, os, re, statistics as st, sys, urllib.request

API = "https://sentry.io/api/0"
# Device-measured FP5 JS baseline, b132, px=810000 (PAP-1703, 2026-08-23).
# n=9 distinct photos: p50 2934ms, mean 2946ms, range 2803-3254ms.
JS_BASELINE_P50_MS = 2934


def load_env():
    env = {}
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(here, ".env")) as f:
        for line in f:
            m = re.match(r'\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?', line)
            if m:
                env[m.group(1)] = m.group(2)
    return env


def get(url, token):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req) as r:
        return json.load(r), r.headers.get("Link", "")


def find_key(obj, key):
    """stageMs is nested under detection.channels — locate it wherever it sits."""
    if isinstance(obj, dict):
        if isinstance(obj.get(key), dict):
            return obj[key]
        for v in obj.values():
            r = find_key(v, key)
            if r:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_key(v, key)
            if r:
                return r
    return None


def fetch_rows(env, pages):
    org, proj, tok = env["SENTRY_ORG"], env["SENTRY_PROJECT"], env["SENTRY_TRIAGE_TOKEN"]
    url = f"{API}/projects/{org}/{proj}/events/?full=true&per_page=100"
    ids = []
    for _ in range(pages):
        data, link = get(url, tok)
        ids += [e["eventID"] for e in data]
        nxt = [p for p in link.split(",") if 'rel="next"' in p and 'results="true"' in p]
        if not nxt:
            break
        url = re.search(r"<([^>]+)>", nxt[0]).group(1)

    rows = []
    for eid in ids:
        # The list endpoint strips custom contexts; only the detail endpoint has stageMs.
        ev, _ = get(f"{API}/projects/{org}/{proj}/events/{eid}/", tok)
        tags = {t["key"]: t["value"] for t in ev.get("tags", [])}
        stage = find_key(ev.get("contexts") or {}, "stageMs")
        if not stage:
            continue
        label = tags.get("buildLabel", "")
        crumbs = find_key(ev, "breadcrumbs") or {}
        native = [c for c in (crumbs.get("values") or [])
                  if "nativeKernels" in json.dumps(c)]
        rows.append({
            "id": eid,
            "ts": ev.get("dateCreated"),
            "build": label.split("(")[1].split(")")[0] if "(" in label else "?",
            "device": tags.get("device"),
            "kind": tags.get("kind"),
            "backend": tags.get("preprocess_backend", ""),
            "nativeKernelsCrumb": native[0].get("data") if native else None,
            **{k: stage.get(k) for k in ("preprocess", "detect", "methods", "total", "px")},
        })
    rows.sort(key=lambda r: r["ts"] or "")
    return rows


def summarize(vals):
    vals = [v for v in vals if v is not None]
    if not vals:
        return None
    return {"n": len(vals), "min": min(vals), "p50": st.median(vals),
            "mean": round(st.mean(vals), 1), "max": max(vals)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", required=True, help="build number, e.g. 140")
    ap.add_argument("--pages", type=int, default=4)
    ap.add_argument("--out", help="directory to write rows JSON into")
    a = ap.parse_args()

    rows = fetch_rows(load_env(), a.pages)
    target = [r for r in rows if r["build"] == a.build]
    print(f"total events with stageMs: {len(rows)}   builds seen: "
          f"{sorted({r['build'] for r in rows})}")

    if not target:
        print(f"\nNO EVENTS for build {a.build} — device session has not happened yet, "
              f"or the build is not reporting telemetry.")
        return 2

    print(f"\n=== build {a.build}: n={len(target)} events ===")
    for r in target:
        print(f"{r['ts'][:19]} {r['device']:>5} {(r['kind'] or '-')[:17]:<17} "
              f"pre={r['preprocess']:>6} det={r['detect']:>6} tot={r['total']:>6} "
              f"backend={r['backend'] or '(absent)'}")

    backends = {r["backend"] or "(absent)" for r in target}
    pre = summarize([r["preprocess"] for r in target])
    print(f"\npreprocess: {pre}")
    print(f"preprocess_backend tag: {sorted(backends)}")

    ok_tag = backends == {"native-cpp"}
    if not ok_tag:
        print("\nAC3 TAG CHECK: FAIL — expected every event to read 'native-cpp'.")
        for r in target:
            if r["backend"] != "native-cpp" and r["nativeKernelsCrumb"]:
                print(f"  {r['id'][:8]} algo.nativeKernels reason: "
                      f"{r['nativeKernelsCrumb'].get('reason')}")
        print("  -> per CEO ruling on PAP-1703: file a follow-up, do NOT re-shoot.")
    else:
        print("\nAC3 TAG CHECK: PASS — preprocess_backend == native-cpp")

    mult = JS_BASELINE_P50_MS / pre["p50"] if pre["p50"] else 0
    print(f"\nspeedup vs device JS baseline (p50 {JS_BASELINE_P50_MS}ms, FP5 b132 "
          f"px=810000): {mult:.2f}x")
    print("CEO ruling: 7-8x closes AC3 as a PASS; record the multiple as measured, "
          "do not round toward the 10x estimate.")

    if a.out:
        os.makedirs(a.out, exist_ok=True)
        p = os.path.join(a.out, f"b{a.build}_ac3_rows.json")
        json.dump(target, open(p, "w"), indent=1)
        print(f"\nwrote {p}")
    return 0 if ok_tag else 1


if __name__ == "__main__":
    sys.exit(main())
