# PAP-1617 b128 Sentry debug_report batch

Curated 2026-05-21 by QA per PAP-1625. Build a36c316 = v1.0.0 (128), build 128 = `2026-05-20 07:21` (PAP-1601 ship; includes PAP-1596 torch off→on cycle + Sentry normalizeDepth=10).

## Layout

Per-event folder `<eventId>/` with triplet:
- `report.json` — full Sentry event (tags, contexts, breadcrumbs)
- `photo.jpg` — raw camera capture attachment
- `cropped.jpg` — preview/crop attachment
- `_attachments.json` — Sentry attachment metadata

`summary_b128.csv` — one row per report (AC2).

## AC4: torch behavior comparison (b127 vs b128)

| metric | b127 (`pap1596_sentry/`) | b128 (this batch) |
|---|---|---|
| n | 9 | 9 |
| `torchProp` value at `takePhotoCompleted` breadcrumb | 9/9 = **on** | 9/9 = **off** |
| `flash` value at `takePhotoCompleted` | 9/9 = on | 9/9 = on |
| `camera.torch.cycle` breadcrumb present | 0/9 | **9/9** |
| last `torchState` during aim (post-cycle) | n/a — on always | 9/9 = **on** |

**Interpretation:** PAP-1596 wire-up confirmed working. In b128 the cycle effect explicitly drives `torchProp` off→on during the aim phase (LED visible to user). The `torchProp` is then released back to `off` before takePhoto so camera2 `flash=on` mode owns the LED for the photo itself — this is the cleaner Android camera2 pattern and matches the parent's "flash now is on during aiming phase" observation. The 0% torch-at-capture in b128 vs 100% in b127 is the intended fix (b127 was double-engaging torch + flash; b128 hands off cleanly).

## AC3: error patterns

- 0/9 `frameProcessorError`
- 0/9 `processingError`
- 0/9 AbortError
- 1/9 `cameraErrors` non-empty — `5ef19354` has a transient policy-restricted event during a session that successfully captured 4 photos afterward. Benign OS-level event; not actionable. No follow-up issue.

No new error patterns vs b127. The PAP-1618 cancel-flash bug is NOT observable in this batch because debug_report only fires on successful counting (cancel path is by definition absent here).

## AC1 cross-walk to training corpus

Searched `training-data/` for `2026-05-19`, `2026-05-20`, `2026-05-21` timestamps — **0 matches**. None of the 9 b128 photos are in the existing training corpus, so PAP-1611 / PAP-1604 rebaseline rows are unaffected (no overlap). Decision on ingestion into training-data is outside QA curation scope; AE may pull these in for a future re-baseline if desired (suggested filenames: `2026-05-21_<hh-mm-ss-mmm>Z_{photo,meta}.{jpg,json}`).

## Per-report quick table

| event | actual | detected | conf | method | proc ms | torch cycles |
|---|---|---|---|---|---|---|
| 976be235 | 24 | 24 | 1.00 | peak | 64974 | 1 |
| ccc920f9 | 32 | 32 | 1.00 | bc-consensus+peak | 68437 | 1 |
| 46b8a384 | 36 | 36 | 0.79 | peak | 68059 | 2 |
| 9e5d5b76 | 36 | **12** ❌ | 0 | bc-consensus | 66131 | 3 |
| 5ef19354 | 42 | 42 | 1.00 | bc-consensus+peak | 66833 | 5 |
| 4f29756f | 52 | 52 | 0.52 | fft-agreement | 63634 | 2 |
| b3472796 | 52 | 52 | 0.56 | fft90-fallback+xl- | 63712 | 4 |
| 21b610e7 | 52 | **12** ❌ | 0.52 | bc-fft | 62790 | 3 |
| b392dda2 | 52 | **37** ❌ | 0 | retry-bc-peaks+pap | 74449 | 6 |

3/9 confidently-wrong on XL (36T and 52T chainrings) — consistent with the open XL gap under PAP-1611. Not a regression; AE owns under PAP-758/PAP-1611 already.
