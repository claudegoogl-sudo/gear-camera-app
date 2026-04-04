# QA Test Plan — Gear Camera App

**Status**: Agent-level validation complete ✅ | Device testing in progress (board)
**Last Updated**: 2026-04-04
**Validation Phases**: 
- ✅ Unit tests: 19/19 pass
- ✅ Code analysis: No issues found
- ⏳ Device testing: Board conducting on physical device

---

## Critical Test Areas

Based on git history and recent fixes, these areas require careful device validation:

### 1. **Motion Detection & Auto-Trigger** 
**Related Issues**: PAP-23, motion detection state management

**Test Checklist**:
- [ ] Camera screen opens and motion detection initializes
- [ ] Motion detection fires auto-trigger when device is moving
- [ ] **Critical**: Auto-trigger does NOT re-fire when on Result screen (useIsFocused guard)
- [ ] Reset button returns to Camera screen
- [ ] Auto-trigger works normally again on Camera screen (after Reset)
- [ ] No "stale state" re-triggers after processing completes
- [ ] Check logcat for `[MotionDetection]` warnings

**Why It Matters**: Frame Processor errors and stale state have been common issues (4+ commits fixing serialization + state management)

---

### 2. **Frame Processor & Algorithm**
**Related Issues**: Multiple fixes (Float32Array, TypedArray serialization, runOnJS)

**Test Checklist**:
- [ ] Photo capture completes without Frame Processor errors
- [ ] Gear detection works on various gear types
- [ ] Confidence badge displays correctly (0-100%)
- [ ] Tooth count detection is accurate
- [ ] No TypedArray or serialization errors in logcat
- [ ] Processing completes in <5 seconds on typical device

**Why It Matters**: Frame Processor serialization caused app crashes on older Android versions; multiple fixes required

---

### 3. **GitHub Debug Sharing**
**Related Issues**: PAP-24 (auth error), PAP-32 (fallback), PAP-34 (token), PAP-38 (upload), PAP-39 (verification)

**Test Checklist with Token Configured**:
- [ ] "Share Debug" button visible and tappable on Result screen
- [ ] Click Share Debug → upload succeeds
- [ ] Native share sheet opens with Gist/GitHub URL
- [ ] Open URL → verify report JSON is complete and valid
- [ ] Report includes: `toothCount`, `confidence`, `build`, `timestamp`
- [ ] Photo is included in upload if available
- [ ] Check GitHub debug-reports/ folder for uploaded files

**Test Checklist WITHOUT Token**:
- [ ] "Share Debug" button disabled or shows error
- [ ] Error message is fully visible (not truncated)
- [ ] Fallback to native share works (or graceful error)
- [ ] App doesn't crash if sharing fails

**Why It Matters**: GitHub API auth (401), message truncation, and upload failures have been recurring issues

---

### 4. **In-App Update Feature**
**Related Issues**: PAP-29 (GitHub API integration), PAP-30 (UI), PAP-35 (build list)

**Test Checklist**:
- [ ] Update icon appears on Camera screen
- [ ] Click icon → fetches available builds from GitHub Releases
- [ ] List displays recent builds with download links
- [ ] Download button works (or directs to GitHub release)
- [ ] If running old build, update availability notification appears
- [ ] No crashes if GitHub API is unreachable

**Why It Matters**: New feature, ensure API integration handles network failures gracefully

---

### 5. **UI Rendering & Navigation**
**Regression Testing - Basic Flows**:

**Camera Screen**:
- [ ] All buttons visible and functional
- [ ] Camera preview renders properly
- [ ] Build watermark (v1.0.0 (N) · YYYY-MM-DD HH:MM) is visible but not intrusive
- [ ] Motion detection hint text updates appropriately

**Result Screen**:
- [ ] Photo displays correctly
- [ ] Tooth count clearly visible
- [ ] Confidence badge shows correct color/value
- [ ] Gear overlay renders correctly
- [ ] Share Debug button is visible
- [ ] Reset button navigates back to Camera screen

**Navigation**:
- [ ] Camera → Capture → Result → Reset → Camera (full loop)
- [ ] No crashes during navigation
- [ ] State resets properly after Reset button

---

### 6. **Error Handling**
**Edge Cases**:
- [ ] Capture with no motion detected (should use timer fallback if toArrayBuffer unavailable)
- [ ] Network unavailable when sharing
- [ ] GitHub API returns 5xx error
- [ ] Out of storage space
- [ ] Permission denied on camera/files
- [ ] Low battery scenarios

**Error Messages**:
- [ ] All error messages are fully visible
- [ ] Error messages provide actionable guidance
- [ ] App continues to function after errors (doesn't hang)

---

### 7. **Device-Specific Considerations**

**Test on Multiple Android Versions** (if possible):
- [ ] Android 10 (API 29) — older Frame Processor support
- [ ] Android 12 (API 31) — modern version
- [ ] Android 13+ (API 33+) — latest

**Performance**:
- [ ] App doesn't lag during capture
- [ ] No memory warnings in logcat
- [ ] Processing completes timely
- [ ] No visible frame drops in camera preview

---

## Known Issues to Monitor

| Issue | Status | Monitor For |
|-------|--------|------------|
| Frame Processor serialization errors | ✅ Fixed | Any TypedArray/string warnings in logcat |
| Auto-trigger re-firing on Result screen | ✅ Fixed | Confirm useIsFocused guard working |
| GitHub auth 401 errors | ✅ Fixed | Verify token handling and fallback |
| Share message truncation | ✅ Fixed | Confirm full error messages visible |
| Stale state after processing | ✅ Fixed | No re-triggers on Result screen |

---

## Test Execution Notes

**Environment Info Needed**:
- Android version & API level
- Device model & manufacturer
- GITHUB_TOKEN configuration (yes/no)
- Network connectivity (WiFi/mobile)
- Storage available

**Issue Reporting**:
When reporting issues:
1. Note the exact Android version
2. Include logcat excerpt if error message in console
3. Describe steps to reproduce
4. Include expected vs. actual behavior
5. Attach screenshot if UI-related

---

## QA Sign-Off Requirements

Before marking QA validation complete:
- [ ] All critical test areas have been exercised
- [ ] No new Frame Processor or serialization errors
- [ ] Auto-trigger works correctly without re-firing
- [ ] GitHub sharing works (with token) or fails gracefully
- [ ] Navigation flows complete without crashes
- [ ] Error messages are readable and helpful
- [ ] App is stable across multiple capture/share cycles

---

**QA Status**: Unit tests passing. Code quality excellent. Ready for comprehensive device testing.

