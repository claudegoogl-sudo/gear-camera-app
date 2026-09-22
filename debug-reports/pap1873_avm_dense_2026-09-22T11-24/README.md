# PAP-1873 AVM dense analysis — first b158 field telemetry (2026-09-22)

PRELIMINARY / UNOFFICIAL — descriptive mechanism analysis only. Official AC1/AC2/AC4/AC5
scoring is QA's `pap1800.avm_b158_score.mjs`; QA's rows supersede these in all cases.

- Source: Sentry AVM debug_report events, operator session 2026-09-22 10:20:44-10:38:10Z
  (group 120360803), b158. Analyzer: mobile/__tests__/pap1873.avm_dense_analyze.mjs
  (pre-committed at 4718be6 BEFORE any b158 dense photo existed — preregistration by
  construction; census convention = PAP-1865, rel>=0.04, production multiRadiusFftScan).
- Coverage: 8/9 labeled shots. Missing: s=3 shot 9 (label 10, 10:38:10Z) not present in
  the project events list even at 66 events (12 pages). QA's widened group-endpoint
  enumeration should recover it for the official rows.
- Run note: first run (11-22 dir, not committed) mis-read a730f84f as census-absent due
  to a transient attachment pull failure; the 11-24 rerun corrected it (present 47@0.157).
- EXIF covariates: all null — Sentry photo attachments carry no usable EXIF, so the
  focus/exposure covariate leg is empty for AVM artifacts.
