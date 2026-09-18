# Auto-Validation Mode (AVM) — integrated first-N-sessions validation

**From:** QA (PAP-1800 HB49, 2026-09-18) — drafted on operator request ("new release does the tests
the first few times it gets used"). **Implementation:** Mobile Engineer. **Gate:** QA cross-check
before build (standing policy). **Target:** next debug build after b157 (b158+).

## Principle

The operator's NORMAL use of a freshly-installed release IS the validation session. No scripts,
no shot list to follow manually, no manual sharing. The app arms itself for the first N sessions
after each version change and collects everything the scripted protocol was collecting — plus the
labels telemetry can never self-supply.

## Design

1. **Arming:** persisted per-app-version counter. Armed on version change (install or update),
   disarms after N=3 detection sessions or 10 completed captures, whichever first. Re-arms on
   every new version — so RELEASE builds self-validate too (covers the Step A arm with no extra
   operator work) and PAP-1688's stageMs n>=10 re-derivation trigger accumulates naturally.
2. **Capture flow unchanged** (~29s pipeline untouched, zero detection-path diff — algoSha must
   equal the release build's; this is instrumentation only).
3. **Label prompt:** once per completed capture (or batched at session end), numeric teeth-count
   input. Labels are the one thing telemetry cannot self-supply; without them samples are
   unscoreable. Skippable per shot (sample stored unlabeled).
4. **Auto-share:** debug_report (photo + crop + algoDiag + cameraEvents) posts automatically per
   capture while armed — same payload the operator shares manually today. Tagged context:
   `validationSession: {appVersion, sessionIndex, shotIndex, label}`.
5. **Guidance banner (soft):** while armed, a one-line hint cycles through class targets
   ("next: a mid-size cog in good light"). ANY capture still counts — partial coverage beats
   no session (b157 lesson: 3 captures, 1 completed, 2 cancelled).
6. **Battery guard:** skip auto-share and label prompt below 25% battery (b157 session died at
   16%); captures still work normally.

## What does NOT automate: the algorithm switch

The app does not self-modify its algorithm on-device. Per-capture dual-run would double the
~29s pipeline and battery for n too small to decide anything (PAP-1673 accounting law: selection
needs corpus-level answers-given accounting). The switch = data lands on the board -> QA/AE
analyze -> winning configuration ships as the DEFAULT of the next release. That release then
self-validates again via AVM — a closed loop with a human gate exactly where the authority is.

## Acceptance criteria (QA-verifiable)

- AC1: while armed, every completed capture produces >=1 tagged telemetry event + auto-shared
  debug_report with label attached, with no operator action beyond shooting (and one label tap).
- AC2: version-keyed counter — app update re-arms; after N sessions mode is fully dormant
  (zero extra events, zero prompts).
- AC3: algoSha / detection-path byte-identical to the release build while armed (diff proves
  instrumentation-only).
- AC4: low-battery guard verified (airplane-mode-style test or forced battery intent).
- AC5: auto-shares parse with the existing QA host harnesses unchanged (pap1800 session_confirm
  family) — payload shape backward-compatible.

## Operators items this replaces

Scripted P1-P7 continuation, Step A manual leg, manual debug_report taps. It does NOT replace
label confirmation for already-landed sessions (ace8f58c 36T still owed) nor the human decision
chain (PAP-1673/PAP-1671/PAP-1782) for algorithm selection.
