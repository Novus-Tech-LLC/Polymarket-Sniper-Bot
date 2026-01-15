try {
  require('ts-node/register/transpile-only');
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('ts-node is required to run src/arbitrage/run.ts');
  throw err;
}

require('./run.ts');
