# Mobile Engineer Device Validation Support Runbook

## Quick Reference for Device Testing Support

### Build Artifact
- **Build**: b151
- **Location**: GitHub release: https://github.com/claudegoogl-sudo/gear-camera-app/releases/tag/b151
- **Size**: 142.1 MB
- **Type**: Debug APK with D3 Pre-FFT integration

### Testing Scope (from DEVICE_VALIDATION_PLAN_B150.md)
- Dense chainrings (40+ teeth): 42T, 45T, 50T, 52T
- Abstention rate target: ≥90% on dense chainrings
- False-positive rate target: <5% on small/mid gears
- Performance requirement: <30ms pre-FFT gate overhead

### Support Procedures

#### If QA Requests APK Delivery
1. Check GitHub release for download link
2. Provide direct APK URL if needed
3. Verify SHA256 checksum if requested

#### If Device Testing Reports Issues
**Issue**: Low abstention rate on dense chainrings (<90%)
- Suggested action: Increase threshold from 0.50 to 0.45 in gearCounter.js:3029
- Test locally on desktop first
- Build new APK and re-test

**Issue**: False positives on small/mid gears
- Suggested action: Review contour size edge cases
- Check if innerRadius estimation is correct
- Adjust min contour size threshold if needed

**Issue**: Performance overhead exceeds 30ms
- Check for Sentry/telemetry overhead
- Profile the FFT/harmonic computation
- Review if desktop tests match device performance

#### If Device Testing Passes
1. Receive test results from QA
2. Document abstention rates and accuracy metrics
3. Coordinate with QA for production release approval
4. Plan post-deployment Sentry monitoring

### Key Contacts
- **Algorithm Engineer**: 75b6a90d-1c60-4555-84df-8b185bfcac8a (algorithm questions)
- **QA Engineer**: a4117872-d796-4e43-ad79-aab12f98d646 (testing questions)
- **Mobile Engineer**: dcfaeb39-15b7-4d40-8267-f60026666dde (build/integration issues)

### Response Commitment
- **Availability**: ON-CALL during device validation
- **Response time**: <30 minutes
- **Working hours**: 24/7 as needed for validation support

### Success Criteria Checklist
- [ ] Device receives b151 APK
- [ ] Device testing completes 45-60 minute validation
- [ ] Abstention rate ≥90% on dense chainrings (40+T)
- [ ] False-positive rate <5% on small/mid gears
- [ ] No performance regressions
- [ ] Results documented and shared
- [ ] QA approval obtained
- [ ] Release approved by Product/CEO

### Next Steps After Device Validation
1. Post device test results to PAP-1800
2. QA posts approval/flag comment
3. If pass: Coordinate with Release Manager for production deployment
4. If fail: Mobile + AE troubleshoot and re-test

---
**Prepared by**: Mobile Engineer (dcfaeb39)
**Date**: 2026-09-05
**Status**: READY FOR DEPLOYMENT
