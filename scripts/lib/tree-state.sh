#!/usr/bin/env bash
# tree-state.sh — refuse to build an APK from a dirty tracked tree.
#                   Sourced by scripts/build-debug.sh and
#                   scripts/build-release.sh, not executed.
#
# PAP-1714. Every artifact-verification chain on this repo leans on the
# claim "the APK was built from main @ <sha>" — b140's acceptance read
# provenance off main HEAD, and the test-builds/README table pairs a
# commit with every build label. None of that is enforceable if the
# working tree carries uncommitted tracked changes at build time: the
# APK silently contains code that exists nowhere in git, and the
# build-stamp commit made afterwards describes an artifact that was
# never built from it.
#
# This is not hypothetical. On 2026-08-23 23:55 the shared checkout
# carried an uncommitted instrumentation diff in
# mobile/src/algorithm/gearCounter.js (console.log in
# countTeethFromRgba's hot path, another in analyzeImage) from a live
# PAP-1711 debugging session. Any build fired in that window would have
# shipped debug logging into the algorithm's per-photo path with no
# trace in the commit history. The two build scripts had no guard.
#
# Scope of the check:
#   - REFUSES on staged or unstaged changes to tracked files. These are
#     what Metro can bundle — the import graph is reached through
#     tracked sources.
#   - IGNORES untracked files (debug-reports/, debug-*.mjs, scratch
#     probes). An unimported file never enters Metro's graph, and
#     untracked scratch output is the normal exhaust of this repo's
#     workflow.
#
# Run BEFORE the buildInfo.js stamp: that stamp is itself a tracked-file
# write the scripts perform deliberately, so the guard must observe the
# tree as the builder received it. A leftover unstamped buildInfo.js
# from an aborted build is exactly the drift this check should surface.
#
# Set ALLOW_DIRTY_TREE=1 to build anyway (a loud warning is printed);
# use it only when the dirty state is understood and the artifact is
# explicitly local-only (pair it with SKIP_RELEASE_UPLOAD=1).

assert_clean_tree() {
  local dirty
  # Tracked modifications only: drop untracked (??) and ignore-submodule
  # noise; the porcelain codes that matter here are M/A/D/R/C/U on
  # tracked paths.
  dirty=$(git -C "$REPO_ROOT" status --porcelain | grep -v '^??' || true)

  if [[ -z "$dirty" ]]; then
    echo "[build] Tree state: clean (no uncommitted tracked changes)"
    return 0
  fi

  if [[ -n "${ALLOW_DIRTY_TREE:-}" ]]; then
    echo "[build] WARNING: building from a DIRTY tracked tree (ALLOW_DIRTY_TREE is set)." >&2
    echo "[build] The APK will contain code that exists nowhere in git:" >&2
    echo "$dirty" | sed 's/^/[build]   /' >&2
    echo "[build] Pair this with SKIP_RELEASE_UPLOAD=1 unless the diff is understood." >&2
    return 0
  fi

  echo "[build] ERROR: the working tree has uncommitted tracked changes — building now" >&2
  echo "[build] would put unbundled-from-nowhere code into the APK while the build stamp" >&2
  echo "[build] claims a commit that was never built from. Changed files:" >&2
  echo "$dirty" | sed 's/^/[build]   /' >&2
  echo "[build] Commit or stash them, or set ALLOW_DIRTY_TREE=1 to build anyway." >&2
  return 1
}
