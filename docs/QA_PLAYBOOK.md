# Gear Camera App - QA Playbook

**Purpose:** Reference guide for QA processes, validation frameworks, and testing procedures  
**Status:** Active  
**Last Updated:** 2026-04-04

---

## Table of Contents

1. [QA Overview](#qa-overview)
2. [Agent-Level QA Process](#agent-level-qa-process)
3. [Device Testing Process](#device-testing-process)
4. [Test Artifacts](#test-artifacts)
5. [Quality Gates](#quality-gates)
6. [Issue Tracking](#issue-tracking)
7. [Future Cycles](#future-cycles)

---

## QA Overview

### Two-Tier QA Model

**Tier 1: Agent-Level QA** (Automated/Static Analysis)
- Unit tests (JavaScript + Python)
- Code quality review
- Security analysis
- Documentation validation
- Build process validation
- **Responsible:** QA Agent
- **Tools:** Jest, Python unittest, manual code review

**Tier 2: Device Testing** (Manual/Runtime)
- Physical device validation
- UI/UX testing
- Motion detection behavior
- GitHub API integration
- Error handling on device
- Performance validation
- **Responsible:** Board/QA team
- **Tools:** Android device, logcat, GitHub API testing

### QA Workflow

```
New Build Created
       ↓
Agent-Level QA (automated)
  - Unit tests run
  - Code reviewed
  - Security checked
  - Quality gates pass/fail
       ↓
   PASS: Send to Device Testing
   FAIL: Return to developer
       ↓
Device Testing (manual)
  - Test plan executed
  - Issues documented
  - Regression checked
       ↓
   PASS: Release ready
   FAIL: Create issues, iterate
```

---

## Agent-Level QA Process

### Step 1: Unit Test Validation

**Location:** `mobile/__tests__/gearCounter.test.js` (JavaScript)  
**Location:** `algorithm/phase1_test_suite.py` (Python)

**Command:**
```bash
# JavaScript tests
cd mobile && npm test

# Python tests
cd algorithm && python3 phase1_test_suite.py
```

**Pass Criteria:**
- JavaScript: All tests pass with no errors
- Python: 100% accuracy on reference implementations
- No test timeouts or memory issues

**Output to Check:**
- Jest summary line shows all tests passing
- Python test summary shows "Overall Accuracy: 7/7 (100%)"

**Typical Results:**
- JavaScript: 19/19 pass in ~0.384 seconds
- Python: 7/7 pass with 100% accuracy across gear sizes (17T-52T)

---

### Step 2: Code Quality Review

**Areas to Review:**

**New Features:**
- JavaScript modules in `mobile/src/`
- Integration points in UI screens
- API integrations with error handling

**Code Checklist:**
- [ ] Functions have clear purpose
- [ ] Error handling is comprehensive
- [ ] No console.log() left in production code
- [ ] No TODO/FIXME comments
- [ ] Proper null checks and edge case handling
- [ ] API calls include proper headers and error boundaries

**Security Checklist:**
- [ ] API tokens not exposed in logs
- [ ] Error messages don't leak sensitive data
- [ ] File operations use safe paths
- [ ] Network requests have timeouts
- [ ] Input validation on data from external sources

**Common Issues to Watch For:**
- Frame Processor serialization errors (Fixed in b3+)
- Stale state after async operations (Fixed in b6+)
- Token handling in API calls (Fixed in b6+)
- Error message truncation (Fixed in b6+)

---

### Step 3: Security Analysis

**API Authentication:**
- Bearer token usage proper
- Token scope limited to necessary operations
- Fallback behavior when token missing

**Data Handling:**
- Base64 encoding for binary data
- Proper JSON serialization
- No TypedArray/string mixing

**Error Messages:**
- Full error details without truncation
- No API keys or tokens in error text
- User-friendly messages without technical leak

---

### Step 4: Documentation Validation

**Requirements:**
- [ ] Test plan updated for new features
- [ ] Known issues documented
- [ ] API changes documented
- [ ] Build process validated
- [ ] README up to date

---

## Device Testing Process

### Pre-Testing Setup

**Required:**
- Android device or emulator (API 29+)
- APK from test-builds/ folder
- QA_TEST_PLAN.md (this project)
- Network connectivity
- GitHub token (optional, but test with AND without)

**Installation:**
```bash
adb install test-builds/gear-camera-debug-*.apk
```

---

### Testing Phases

### Phase 1: Smoke Test (5 minutes)

**Goal:** Confirm app launches and basic functionality works

**Steps:**
1. [ ] App launches without crashes
2. [ ] Camera preview displays
3. [ ] Can take a photo (manual tap)
4. [ ] Processing completes
5. [ ] Result screen shows tooth count
6. [ ] Reset button returns to camera

**Pass Criteria:** All steps complete without crashes

---

### Phase 2: Critical Features (15 minutes)

**Goal:** Validate major fixes and features

**Motion Detection:**
1. [ ] Auto-trigger fires when device moves
2. [ ] Result screen appears after auto-capture
3. **CRITICAL:** Auto-trigger does NOT re-fire on Result screen
4. [ ] Reset button returns to Camera
5. [ ] Auto-trigger works again on Camera screen
6. [ ] Check logcat: `grep -i "MotionDetection" logcat.txt`

**GitHub Sharing:**
1. [ ] "Share Debug" button visible on Result
2. [ ] With token: Upload succeeds
3. [ ] Check GitHub: Report folder appears in debug-reports/report_<timestamp>/
4. [ ] Without token: Error message visible (not truncated)

---

### Phase 3: Full Regression (30+ minutes)

**Use:** QA_TEST_PLAN.md for complete checklist

**Coverage:**
- Motion detection accuracy
- Frame Processor stability (no crashes)
- GitHub API authentication
- In-app update feature
- UI rendering on device
- Navigation flows
- Error handling

---

### Logcat Monitoring

**Commands:**
```bash
# Clear logcat
adb logcat -c

# Capture to file
adb logcat > logcat.txt &

# Monitor specific tags
adb logcat | grep -E "MotionDetection|FrameProcessor|GitHub|Error"
```

**Look For:**
- ❌ `MotionDetection.*error`
- ❌ `FrameProcessor.*error`
- ❌ `TypeError.*undefined`
- ❌ `java.lang.NullPointerException`
- ✅ Normal operation (no errors)

---

## Test Artifacts

### QA_TEST_PLAN.md
- **Purpose:** Detailed testing checklist
- **Use:** Guide device testing execution
- **Covers:** 7 critical test areas with checklists

### QA_REPORT_B6-B9.md
- **Purpose:** Comprehensive analysis of builds
- **Contains:** Test results, code review, security analysis
- **Use:** Reference for understanding builds

### regression_test_matrix.md
- **Purpose:** Track fixed issues to prevent regressions
- **Use:** Ensure past fixes remain stable in new builds
- **Covers:** 20+ historical fixes across 5 categories

---

## Quality Gates

### Must Pass Before Release

| Gate | Owner | Criteria |
|------|-------|----------|
| Unit tests | Agent QA | 100% pass (26/26) |
| Code review | Agent QA | 0 issues found |
| Security | Agent QA | 0 vulnerabilities |
| Device testing | Board | All critical areas pass |
| Regression check | Board | No new issues |

### Build Sign-Off

```
✅ Agent QA: Code validated
✅ Board QA: Device tested
✅ Mobile Engineer: Approved
→ READY FOR RELEASE
```

---

## Issue Tracking

### When Issues Found During Testing

**During Agent QA:**
1. Create task in Paperclip
2. Assign to Mobile Engineer
3. Link to build task (parent)
4. Set priority (critical/high/medium)
5. Include reproduction steps

**During Device Testing:**
1. Capture screenshot/video
2. Note exact Android version
3. Check logcat for errors
4. Include environment details
5. Create Paperclip task with full context

### Known Issues

See `regression_test_matrix.md` for list of historical fixes to monitor.

---

## Future Cycles

### Next Build: b10+

**Process:**
1. Mobile Engineer creates build
2. QA Agent runs unit tests (5 min)
3. QA Agent reviews code (15 min)
4. QA Agent validates build process (5 min)
5. Pass → Send to Board for device testing
6. Fail → Return to developer

**Timeline:** ~25 minutes agent QA + device testing duration

### Regression Testing

**Before Device Testing:**
- Check regression_test_matrix.md
- Identify previous fixes relevant to new changes
- Test those areas with special attention

**After Device Testing:**
- Update regression_test_matrix.md with findings
- Note new issues for future cycles
- Track patterns in failure types

---

## Tools & Resources

### Available Tools

**Testing:**
- Jest (JavaScript unit tests)
- Python unittest (algorithm reference)
- Android logcat (device debugging)
- adb (device communication)

**CI/Build:**
- Gradle (Android build)
- build-debug.sh script (automated stamping)

**Documentation:**
- QA_TEST_PLAN.md (detailed checklist)
- QA_REPORT_B6-B9.md (analysis)
- regression_test_matrix.md (issue tracking)

### Commands Reference

```bash
# Run JavaScript tests
cd mobile && npm test

# Run Python tests
cd algorithm && python3 phase1_test_suite.py

# Build APK
cd mobile/android && ./gradlew assembleDebug

# Generate automated build
./scripts/build-debug.sh

# Monitor device
adb logcat
adb install <apk>
adb uninstall com.gearcounter.app
```

---

## QA Metrics

### Unit Tests
- **Target:** 100% pass rate
- **Current:** 26/26 pass (JavaScript 19 + Python 7)
- **Frequency:** Every build

### Code Review
- **Target:** 0 issues found
- **Current:** 0 issues (b6-b9)
- **Areas:** Security, error handling, API usage

### Device Testing
- **Target:** 0 crashes, all features functional
- **Frequency:** Before release
- **Coverage:** Regression + new features

---

## Lessons Learned

### Common Issues by Category

**Frame Processor** (b0-b4)
- Issue: TypedArray serialization errors
- Root cause: Legacy API incompatibilities
- Fix: Float32Array + useRunOnJS
- Lesson: Test encoding early

**Motion Detection** (b0-b6)
- Issue: Auto-trigger re-fires on Result screen
- Root cause: Stale state after navigation
- Fix: useIsFocused guard
- Lesson: State management critical for navigation

**GitHub API** (b6+)
- Issue: Auth 401, truncated errors, missing uploads
- Root cause: Token handling, API requirements, verification
- Fix: Conditional isPublic, full error messages, post-upload verification
- Lesson: Test without token, test error paths

---

## Quick Reference

### For QA Agent
1. Run `npm test` and `python3 phase1_test_suite.py`
2. Review code for issues
3. Check security
4. Create test plan if new features
5. Document findings

### For Board Testing
1. Use QA_TEST_PLAN.md
2. Monitor logcat for errors
3. Test with AND without GitHub token
4. Check regression matrix
5. Report issues with full context

### For Developer
1. Follow QA_TEST_PLAN.md during feature dev
2. Ensure unit tests pass
3. Handle errors gracefully
4. Test API with token + without
5. Monitor logcat during development

---

## Contact & Support

**QA Agent:** QA Engineer (a4117872-d796-4e43-ad79-aab12f98d646)  
**Mobile Engineer:** dcfaeb39-15b7-4d40-8267-f60026666dde  
**Manager:** CEO

For questions about QA process, refer to this playbook or contact QA Agent in Paperclip.

---

**Document Status:** Active  
**Last Updated:** 2026-04-04  
**Version:** 1.0
