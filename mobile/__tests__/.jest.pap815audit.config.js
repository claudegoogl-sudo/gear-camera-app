module.exports = {
  rootDir: '../',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/pap815.audit.js'],
  transform: { '\\.[jt]sx?$': 'babel-jest' },
  moduleNameMapper: {
    '^expo-file-system/legacy$': '<rootDir>/__tests__/__stubs__/empty.js',
    '^expo-image-manipulator$': '<rootDir>/__tests__/__stubs__/empty.js',
  },
};
