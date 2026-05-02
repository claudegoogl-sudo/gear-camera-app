// Parameterized Jest config for one-off diagnostic / audit / sweep harnesses
// under mobile/__tests__/. Replaces the per-harness .jest.<name>.config.js
// files (PAP-972).
//
// Usage:
//   HARNESS=<basename> npx jest --config mobile/__tests__/.jest.harness.config.js
//
// where <basename> is the harness file's name without the `.js` suffix, e.g.:
//   HARNESS=pap796.crosscheck   -> mobile/__tests__/pap796.crosscheck.js
//   HARNESS=pap760.audit        -> mobile/__tests__/pap760.audit.js
//   HARNESS=pap815.xltargets    -> mobile/__tests__/pap815.xltargets.js
//
// These harnesses are local-only diagnostics and are not run from CI.

const harness = process.env.HARNESS;
if (!harness) {
  throw new Error(
    'Set the HARNESS env var to the harness basename, e.g. ' +
      'HARNESS=pap796.crosscheck npx jest --config mobile/__tests__/.jest.harness.config.js'
  );
}

module.exports = {
  rootDir: '../',
  testEnvironment: 'node',
  testMatch: [`**/__tests__/${harness}.js`],
  transform: { '\\.[jt]sx?$': 'babel-jest' },
  // Stub the native expo modules pulled in by gearCounter.
  moduleNameMapper: {
    '^expo-file-system/legacy$': '<rootDir>/__tests__/__stubs__/empty.js',
    '^expo-image-manipulator$': '<rootDir>/__tests__/__stubs__/empty.js',
  },
};
