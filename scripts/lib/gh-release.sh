#!/usr/bin/env bash
# gh-release.sh — shared GitHub Release publishing for scripts/build-debug.sh
#                 and scripts/build-release.sh. Sourced, not executed.
#
# PAP-1655: publishing used to be best-effort. A failed upload printed a warning
# into ~2000 lines of Gradle output, exited 0, and wrote "local" into the
# test-builds README — so a build that delivered nothing to the operator was
# indistinguishable from one that worked. Delivery is the point of the step, so
# a build that cannot deliver now fails.

GH_REPO="claudegoogl-sudo/gear-camera-app"

# Does this specific token authenticate? Pinning both env names stops `gh` from
# silently falling back to the keyring and reporting a dead token as healthy.
gh_token_works() {
  GH_TOKEN="$1" GITHUB_TOKEN="$1" gh api user >/dev/null 2>&1
}

# Echo the first token that actually authenticates, else return 1.
#
# The old resolution took the first token that was merely *set*. On this host
# GITHUB_TOKEN is exported and revoked, so it always won and shadowed a working
# `gh` keyring login — the whole reason uploads had been failing since ~b127.
gh_resolve_token() {
  local name value
  for name in GITHUB_PAT GITHUB_TOKEN EXPO_PUBLIC_GITHUB_TOKEN; do
    value="${!name:-}"
    [[ -n "$value" ]] || continue
    if gh_token_works "$value"; then
      echo "[build] GitHub auth: using \$$name." >&2
      printf '%s' "$value"
      return 0
    fi
    echo "[build] GitHub auth: \$$name is set but does not authenticate — ignoring it." >&2
  done

  value=$(env -u GITHUB_TOKEN -u GH_TOKEN gh auth token 2>/dev/null || true)
  if [[ -n "$value" ]] && gh_token_works "$value"; then
    echo "[build] GitHub auth: using the gh keyring login." >&2
    printf '%s' "$value"
    return 0
  fi

  return 1
}

# Resolve publishing credentials before Gradle runs, so an undeliverable build
# costs seconds instead of a full compile. Sets GH_PUBLISH_TOKEN on success.
gh_preflight_auth() {
  if [[ -n "${SKIP_RELEASE_UPLOAD:-}" ]]; then
    echo "[build] SKIP_RELEASE_UPLOAD is set — this build will be local-only and will not be published."
    return 0
  fi

  if GH_PUBLISH_TOKEN=$(gh_resolve_token); then
    export GH_PUBLISH_TOKEN
    return 0
  fi

  cat >&2 <<EOF
[build] ERROR: no GitHub credentials authenticate, so this build could not be
[build] published to $GH_REPO. Refusing to spend a full build on an artifact
[build] that cannot be delivered.
[build]
[build]   - Run 'gh auth login' (or 'gh auth status' to inspect the current login).
[build]   - If GITHUB_TOKEN is exported in your shell and stale, unset it.
[build]   - To build a deliberately local-only artifact: SKIP_RELEASE_UPLOAD=1 $0
EOF
  exit 1
}

# Upload the archived APK. Sets GH_DOWNLOAD_LINK on success; returns 1 on failure.
gh_publish_release() {
  local tag="$1" title="$2" notes="$3" apk="$4" asset_name="$5"

  echo "[build] Uploading to GitHub Releases as tag $tag…"
  if GITHUB_TOKEN="$GH_PUBLISH_TOKEN" GH_TOKEN="$GH_PUBLISH_TOKEN" \
     gh release create "$tag" \
       --repo "$GH_REPO" \
       --title "$title" \
       --notes "$notes" \
       "$apk#$asset_name" 2>&1; then
    GH_DOWNLOAD_LINK="[Download](https://github.com/$GH_REPO/releases/download/$tag/$asset_name)"
    echo "[build] Release $tag uploaded successfully."
    return 0
  fi
  return 1
}

# Terminal-state message for a build whose artifact never reached the operator.
gh_upload_failed_banner() {
  local tag="$1" apk="$2"
  cat >&2 <<EOF

[build] ========================================================================
[build] BUILD FAILED: the APK was never published.
[build]
[build] The artifact compiled and passed every verification, but the upload to
[build] $GH_REPO (tag $tag) failed, so nobody can install it.
[build] The README row for this build is marked UPLOAD FAILED, not linked.
[build]
[build] The local artifact is at:
[build]   $apk
[build] Recover it by hand with:
[build]   gh release create $tag --repo $GH_REPO "$apk"
[build] ========================================================================
EOF
}
