const base = { preset: 'ts-jest', testEnvironment: 'node', transform: { '^.+\.ts$': ['ts-jest', { isolatedModules: true }] } };
module.exports = {
  projects: [
    { ...base, displayName: 'unit', rootDir: 'src', testRegex: '.*\.spec\.ts$' },
    { ...base, displayName: 'integration', rootDir: 'test', testRegex: '.*\.int\.ts$' },
  ],
};
