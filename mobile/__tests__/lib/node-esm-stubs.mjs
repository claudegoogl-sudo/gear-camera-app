/**
 * PAP-1635: resolve hook that lets the algorithm modules be imported by plain
 * `node` instead of jest.
 *
 * Why this exists: under babel-jest the tight typed-array loops in
 * imageUtils/gearCounter run ~400x slower than the same source under plain V8
 * (measured: gaussianBlur5x5 19ms -> 8100ms on a 900x675 frame). That makes
 * jest unusable as a profiler — the stage shares it reports are a property of
 * the transform, not of the algorithm — and makes a full-corpus run take
 * hours instead of minutes.
 *
 * gearCounter only imports the two expo native modules for the on-device
 * photoUri path, which no harness uses; mapping them to an empty module is
 * the same substitution the jest config already makes via moduleNameMapper.
 *
 * Usage: node --import ./mobile/__tests__/lib/node-esm-stubs.mjs <script.mjs>
 */
import { registerHooks } from 'node:module';

const STUBBED = new Set(['expo-file-system/legacy', 'expo-image-manipulator']);
const EMPTY = 'data:text/javascript,export default {};';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBBED.has(specifier)) return { url: EMPTY, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (e) {
      // Metro (and babel-jest) resolve extensionless relative imports like
      // `./fft`; node does not. Retry with the extension the repo uses.
      if (e.code === 'ERR_MODULE_NOT_FOUND' && /^\.{1,2}\//.test(specifier)) {
        return nextResolve(`${specifier}.js`, context);
      }
      throw e;
    }
  },
});
