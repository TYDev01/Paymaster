import {parseChainsJson, type Env} from "./env.js";
import type {PolicyDefinition} from "../db/postgresPolicyRepository.js";
import type {Policy} from "../policy/engine.js";
import {InMemoryQuotaStore} from "../policy/quota/inMemoryQuotaStore.js";
import type {QuotaStore} from "../policy/quota/quotaStore.js";
import {ChainEnabledRule} from "../policy/rules/accessLists.js";
import {QuotaRule} from "../policy/rules/quotaRules.js";

/**
 * The bootstrap policy set.
 *
 * This is real configuration, not a stand-in. It implements td.md's "sponsor everyone" — no
 * allowlist — but bounded by per-wallet and per-IP quotas, because an unbounded "sponsor everyone"
 * paymaster is a faucet that drains its deposit to the first script that finds it.
 *
 * WITHOUT a database this is the policy set the service serves. WITH one, policies come from the
 * database and this is used only to seed it — see `defaultPolicyDefinition` below.
 *
 * The store defaults to in-memory, which is per-process. With more than one replica each caller
 * effectively gets one quota per replica. `bootstrap` warns about this; the Redis adapter is what
 * makes these quotas real under horizontal scaling.
 */
export function defaultPolicies(env: Env, store: QuotaStore = new InMemoryQuotaStore()): readonly Policy[] {
  const enabledChainIds = parseChainsJson(env.CHAINS)
    .filter((c) => c.enabled)
    .map((c) => c.chainId);

  return [
    {
      id: env.DEFAULT_POLICY_ID,
      rules: [
        new ChainEnabledRule(enabledChainIds),
        new QuotaRule(store, {
          name: "wallet-daily-ops",
          subject: "wallet",
          unit: "operations",
          limit: 100n,
          windowSeconds: 86_400,
        }),
        new QuotaRule(store, {
          name: "wallet-daily-spend",
          subject: "wallet",
          unit: "wei",
          limit: 10n ** 17n, // 0.1 native token per wallet per day
          windowSeconds: 86_400,
        }),
        new QuotaRule(store, {
          name: "ip-hourly-ops",
          subject: "ip",
          unit: "operations",
          limit: 200n,
          windowSeconds: 3_600,
          // An IP is absent only for internal callers that bypass the HTTP edge; those should not
          // be blocked by a quota that cannot identify them.
          onMissingSubject: "skip",
        }),
        new QuotaRule(store, {
          name: "global-daily-spend",
          subject: "global",
          unit: "wei",
          limit: 10n ** 19n, // 10 native tokens per day across everything
          windowSeconds: 86_400,
        }),
      ],
    },
  ];
}

/**
 * The same bootstrap policy, as a storable DEFINITION.
 *
 * With a database configured, `PolicySource` loads from it and the in-code set above is never
 * consulted — so a fresh database means no policies at all, and every sponsorship fails with
 * "no policy with id default". That is correct for production, where policies are the operator's,
 * but it makes the documented quickstart impossible: bring the stack up, request a sponsorship,
 * get an error that names a policy nobody was told to create.
 *
 * `BOOTSTRAP_DEFAULT_POLICY` closes that, the same way `BOOTSTRAP_API_KEY` closes the equivalent
 * chicken-and-egg for credentials: opt-in, never a default in production, and seeded ONLY when the
 * policy table is empty — so it can never overwrite an operator's policy set or resurrect one they
 * deliberately deleted.
 *
 * The two representations are kept deliberately identical in effect. A drift between them would
 * mean the with-database and without-database deployments quietly sponsor different things.
 */
export function defaultPolicyDefinition(env: Env): PolicyDefinition {
  const enabledChainIds = parseChainsJson(env.CHAINS)
    .filter((c) => c.enabled)
    .map((c) => c.chainId);

  return {
    id: env.DEFAULT_POLICY_ID,
    name: "Default (bootstrap)",
    description: "Seeded by BOOTSTRAP_DEFAULT_POLICY. Sponsor everyone, bounded by quotas.",
    enabled: true,
    rules: [
      {ruleType: "chain-enabled", config: {chainIds: enabledChainIds}},
      {
        ruleType: "quota",
        config: {
          name: "wallet-daily-ops",
          subject: "wallet",
          unit: "operations",
          limit: "100",
          windowSeconds: 86_400,
        },
      },
      {
        ruleType: "quota",
        config: {
          name: "wallet-daily-spend",
          subject: "wallet",
          unit: "wei",
          limit: "100000000000000000",
          windowSeconds: 86_400,
        },
      },
      {
        ruleType: "quota",
        config: {
          name: "ip-hourly-ops",
          subject: "ip",
          unit: "operations",
          limit: "200",
          windowSeconds: 3_600,
          onMissingSubject: "skip",
        },
      },
      {
        ruleType: "quota",
        config: {
          name: "global-daily-spend",
          subject: "global",
          unit: "wei",
          limit: "10000000000000000000",
          windowSeconds: 86_400,
        },
      },
    ],
  };
}
