# Bicycle Gear Tooth Counter App - Development Plan

## Project Overview
A native mobile application that uses live camera feed to detect stationary bicycle gears, automatically captures photos with flash, and counts teeth using procedural image processing (no ML/LLM). Displays results with visual overlay and reset functionality. Single-gear systems only (chainrings or rear sprockets, not cassettes).

---

## Target Specifications

### Hardware & User Input
- **Gear range**: 15-60 teeth (chainrings, rear sprockets, belt drive sprockets)
- **Use case**: Road bikes, mountain bikes, gravel bikes, belt-drive systems
- **Workflow**: 
  1. Live video feed displayed
  2. Motion detection for stationary gears
  3. Auto-capture with flash when gear stops moving
  4. Tooth count processing with visual overlay
  5. Results display + reset button
  6. No persistent data storage

### Accuracy Requirements
- **Critical**: ±0 tolerance (off-by-one is unacceptable)
- **Implication**: Algorithm must be robust; edge cases matter more than speed

### Platform Choice: **React Native** (Mobile)

**Why React Native over web app:**
- Native camera access (flash control, better low-light performance)
- Motion detection via frame-by-frame analysis
- Hardware acceleration for image processing
- Works offline
- Single codebase for iOS + Android
- Faster iteration than pure Swift/Kotlin

---

## Project Phases

### Phase 1: Foundation & Algorithm Development (2-3 weeks)

#### 1a. Tooth Detection Algorithm Research
**Deliverable**: Working algorithm prototype (desktop Python, not mobile yet)

- **Input**: Single gear photo, well-lit
- **Process**:
  1. Convert to grayscale
  2. Apply edge detection (Canny edge detector)
  3. Find gear contours (circular Hough transform or contour tracing)
  4. Isolate gear region
  5. Detect tooth peaks using polar coordinate transform
  6. Count peaks (tooth count)
  7. Return confidence score

**Tools**: OpenCV (Python), test on 20-30 gear photos from community/stock images

**Output**: 
- Algorithm spec document
- Test results on various lighting/angles
- Known limitations documented

**Why this phase first**: Teeth counting is the hard part. Must validate it works before building the app around it.

---

### Phase 2: Mobile App Scaffold (1-2 weeks)

#### 2a. React Native Project Setup
- Initialize React Native project (Expo or bare CLI)
- Install dependencies:
  - `react-native-camera` (live feed + flash)
  - `react-native-vision-camera` (alternative, better motion detection)
  - `react-native-opencv` or `react-native-image-processing` (C++ bindings for algorithm)
  - `react-native-reanimated` (smooth animations)
  - State management: Redux or Zustand (simple for this scope)

#### 2b. Basic UI Layout
- Top: Live camera feed (full screen)
- Middle: Motion detection indicator (visual feedback)
- Bottom: Reset button + tooth count (hidden until processing done)
- Overlay: Detected tooth circles once processing completes

**Decision**: Use native camera APIs or Expo Camera?
- **Expo Camera**: Simpler, less control over flash
- **React Native Camera**: More control, requires native modules
- **Recommendation**: Start with `react-native-vision-camera` (modern, good flash API)

---

### Phase 3: Motion Detection (1 week)

#### 3a. Frame Capture & Motion Analysis
- Capture frames from camera feed (~10 fps to keep lightweight)
- Compare consecutive frames (pixel difference, optical flow, or template matching)
- Detect when motion drops below threshold (gear stopped)
- Trigger photo capture with flash when stable

**Implementation**:
- Use frame differencing (fast, sufficient for gear detection)
- Threshold tuning needed (environment-dependent)
- Add 1-2 second stability window (avoid flicker)

**Challenges**:
- Lighting changes vs. actual motion
- User hand/shadow in frame
- Solution: Require motion to return to baseline, not just stop

---

### Phase 4: Image Capture & Processing Integration (1-2 weeks)

#### 4a. Auto-Capture with Flash
- When motion detected as "stable", trigger camera capture
- Flash: Activate native flash (required for low-light gears)
- Save image to app memory (not persistent)
- Pass to tooth detection algorithm

#### 4b. Algorithm Integration
- Port Python algorithm to JavaScript or Rust (via React Native bridge)
- **Two approaches**:
  1. **WebAssembly (WASM) + JavaScript**: Slower, but cross-platform (~ 500-1000ms per image)
  2. **Native Module (C++ via React Native)**: Faster, requires platform-specific code (~ 100-200ms per image)

**Recommendation for MVP**: WASM first (easier), optimize to native later if needed

**Processing pipeline**:
```
Raw JPEG → Decompress → Grayscale → Edge Detection → 
Contour Find → Gear Isolation → Polar Transform → 
Peak Detection → Count → Confidence Score
```

---

### Phase 5: Results Display & Visual Overlay (1 week)

#### 5a. Tooth Overlay
- Draw detected gear contour as a single colored line (highlights the gear outline)
- This allows users to visually confirm if the detection is analyzing the correct object
- Show tooth count prominently
- Display confidence score (if <90%, warn user via toast notification)

#### 5b. UI Layout
- Lower third of screen: Tooth count + reset button
- Overlay: Single colored line tracing the gear's outer contour
- Reset button: Clears result, returns to live feed

#### 5c. Edge Cases & User Feedback
- If no gear detected: Toast notification "Position gear in center, improve lighting"
- If low confidence: Toast notification "Low confidence detected, try better lighting or angle"
- If count outside expected range: Toast notification only, still display count (accommodates unknown future gear sizes)

---

### Phase 6: Testing & Optimization (2-3 weeks)

#### 6a. Algorithm Testing
- **Test dataset**: 30+ gear photos (mix of chainrings, sprockets, belt drive) covering 15-60T range
- **Metrics**:
  - Accuracy: Count matches manual verification
  - Precision: Consistent results on same gear
  - False positives: Detection on non-gears
- **Pass/fail**: 100% accuracy on test set (non-negotiable)

#### 6b. Real-World Testing
- Test with actual gears in various lighting (indoor, outdoor, dim)
- Test with different camera angles (0°, 30°, 45°)
- Test with different gears (aluminum, steel, wear patterns)
- Document any cases where algorithm fails

#### 6c. Performance Optimization
- Frame capture rate: Optimize motion detection (may reduce from 10fps to 5fps)
- Processing time: Target < 2 seconds total (capture to result)
- Memory: Ensure no leaks during repeated captures

#### 6d. Mobile-Specific QA
- **iOS**: Test on iPhone 12+ (camera quality)
- **Android**: Test on flagship + mid-range devices
- **Edge cases**: 
  - Auto-brightness changes during capture
  - Rapid re-captures (stress test)
  - Low battery mode

---

## Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Framework** | React Native | Cross-platform iOS/Android |
| **Camera** | react-native-vision-camera | Modern, good flash control |
| **State** | Zustand or Redux | Simple state for counting result |
| **Image Processing** | JavaScript + WASM (or native module) | Custom algorithm implementation |
| **UI** | React Native Reanimated + react-native-svg | Smooth animations, overlay drawing |
| **Testing** | Jest + Detox (e2e) | Unit & integration tests |
| **Build** | EAS Build (Expo) or local (bare React Native) | Easier than managing Xcode/Android Studio |

---

## Realistic Timeline

| Phase | Duration | Start | End |
|-------|----------|-------|-----|
| 1. Algorithm R&D | 2-3 weeks | Week 1 | Week 3 |
| 2. Mobile scaffold | 1-2 weeks | Week 3 | Week 5 |
| 3. Motion detection | 1 week | Week 5 | Week 6 |
| 4. Processing integration | 1-2 weeks | Week 6 | Week 8 |
| 5. Results UI | 1 week | Week 8 | Week 9 |
| 6. Testing & polish | 2-3 weeks | Week 9 | Week 12 |
| **Total** | **~12 weeks** | — | — |

**For faster iteration**: Parallelize phases 2-3 while doing algorithm work. Could compress to **8-10 weeks** with focused effort.

---

## Key Risks & Mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Algorithm fails on worn/dirty gears | High | Extensive test dataset early; add lighting normalization |
| Flash API unavailable on some Android devices | Medium | Fallback to software brightness boost; user can add external light |
| Performance: Processing > 2sec | Medium | Profile early; consider native module if WASM too slow |
| User captures at bad angle (>45°) | Low | Add angle detection; guide user with visual feedback |
| Motion detection too sensitive/insensitive | Medium | Threshold tuning; A/B test with real users early |

---

## MVP vs. Future Features

### MVP (This Plan)
- ✅ Live camera feed
- ✅ Motion detection → auto-capture
- ✅ Flash on capture
- ✅ Tooth counting algorithm
- ✅ Visual overlay
- ✅ Reset button
- ✅ Offline (no backend)

### Phase 2 (Future, not in this plan)
- 📱 Batch processing (upload multiple gears)
- 📊 Gear database (save common sizes as reference)
- 🎯 Automatic gear type detection (chainring vs. sprocket vs. belt)
- ⚙️ Cassette support (multi-gear systems)
- 🌐 Cloud backup of history (if user wants)
- 📸 Gallery import (process saved photos)

---

## Development Approach Recommendation

### Option A: Start with Claude Code (Recommended)
1. Build Phase 1 (algorithm) in Python/JavaScript with Claude Code
2. Test thoroughly
3. Then move to React Native for Phases 2-6
4. Use Claude Code for iterative algorithm refinement

### Option B: Full App in React Native from Start
- More cohesive, but slower algorithm iteration
- Requires more testing on device
- Better if you're comfortable with React Native already

### Option C: Hybrid
1. Prototype algorithm + UI in web React (faster feedback)
2. Move successful prototype to React Native
3. Refine on real devices

**My recommendation**: **Option A** → Start algorithm work in Claude Code (desktop), validate it works, then build the mobile wrapper. Separates concerns, faster validation.

---

## Success Criteria

- [ ] Algorithm achieves 100% accuracy on 30+ test gears (15-60T range)
- [ ] App captures photo automatically when gear stops moving
- [ ] Flash activates on capture (all supported devices)
- [ ] Tooth count displayed in < 2 seconds
- [ ] Visual overlay shows detected teeth correctly
- [ ] Reset button clears results and returns to live feed
- [ ] App works offline
- [ ] No crashes during 10 consecutive captures
- [ ] Tested on iOS 14+ and Android 10+

---

## Next Steps

1. **Confirm tech stack** (React Native + react-native-vision-camera)
2. **Start Phase 1**: Build algorithm prototype in Python (desktop)
3. **Validate algorithm** on real gear photos
4. **Set up React Native project** (parallel to algorithm work)
5. **Weekly sync**: Algorithm accuracy → UI decisions

Would you like me to start with Phase 1 (algorithm prototype) in Claude Code?
