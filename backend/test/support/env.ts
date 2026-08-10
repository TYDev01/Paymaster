import {envSchema, type Env} from "../../src/config/env.js";

/**
 * A validated `Env` for tests.
 *
 * Built by running the REAL schema, not by hand-listing every field. Hand-written Env literals were
 * duplicated across three test files and had to be edited every time a variable was added, which
 * made adding one look like it broke the tests. Going through the schema means a new variable with
 * a default arrives here automatically, and a new REQUIRED one fails in a single place.
 *
 * Everything that would start a timer, open a socket, or accumulate state is off by default, so a
 * test that wants a background loop turns it on deliberately.
 */
const TEST_SIGNER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export function testEnv(overrides: Partial<Env> = {}): Env {
  const base = envSchema.parse({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    SPONSORSHIP_SIGNER_KEY: overrides.SPONSORSHIP_SIGNER_KEY ?? TEST_SIGNER_KEY,
    CHAINS: "[]",
    FUNDING_MONITOR_ENABLED: "false",
    RECONCILER_ENABLED: "false",
    METRICS_ENABLED: "false",
    IP_THROTTLE_ENABLED: "false",
  });
  // Port 0 after parsing: the schema rejects it (a real deployment must name its port) but tests
  // want the ephemeral port the OS picks.
  return {...base, PORT: 0, ...overrides};
}
