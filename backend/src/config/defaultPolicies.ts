import {parseChainsJson, type Env} from "./env.js";
import type {Policy} from "../policy/engine.js";
import {InMemoryQuotaStore} from "../policy/quota/inMemoryQuotaStore.js";
import type {QuotaStore} from "../policy/quota/quotaStore.js";
import {ChainEnabledRule} from "../policy/rules/accessLists.js";
import {QuotaRule} from "../policy/rules/quotaRules.js";

/**
 * The bootstrap policy set.
 *
 * This is real configuration, not a stand-in: it is the policy the service serves until the
 * database-backed PolicyRepository lands and `PolicySource` starts reloading from there. It
 * implements td.md's "sponsor everyone" — no allowlist — but bounded by per-wallet and per-IP
 * quotas, because an unbounded "sponsor everyone" paymaster is a faucet that drains its deposit to
 * the first script that finds it.
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
