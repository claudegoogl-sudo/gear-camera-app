# Algorithm — Phase 4 placeholder

The Python algorithm from `../../algorithm/gear_tooth_counter.py` will be
ported here in Phase 4 as a JavaScript/WASM module.

Entry point will be:

```js
import { countTeeth } from './gearCounter';

const result = await countTeeth(photoUri);
// { toothCount: 20, confidence: 0.85, gearContour: { centerX, centerY, radius } }
```

The port will follow the same pipeline:
1. Decode JPEG → grayscale pixel buffer
2. Gaussian blur + Canny edge detection
3. Radial edge-density scan to find gear radius
4. Grayscale intensity sampling at tooth-tip circle
5. FFT with harmonic weighting → dominant frequency = tooth count
