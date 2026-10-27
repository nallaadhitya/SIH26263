module.exports = {
  testEnvironment: 'node',
  // Real cost-12 bcrypt runs exceeded the default five-second execution budget
  // on this machine (six operations took 7.8s outside Jest). Keep all assertions
  // and cryptographic costs intact; bound integration tests to thirty seconds.
  testTimeout: 30000,
  sandboxInjectedGlobals: ['Math'],
};
