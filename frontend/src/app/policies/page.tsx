"use client";

import {useEffect, useState} from "react";
import {LuKeyRound, LuLock, LuScrollText} from "react-icons/lu";

import {PageHeader} from "@/components/panels/page-header";
import {Panel, EmptyState} from "@/components/viz/panel";
import {Skeleton} from "@/components/ui/skeleton";
import {Badge} from "@/components/ui/badge";
import {StatusPill} from "@/components/viz/status";
import {useTelemetry} from "@/hooks/use-telemetry";

interface StoredPolicy {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  rules: {ruleType: string; config: unknown}[];
}

interface ApiKeyView {
  id: string;
  name: string;
  displayPrefix: string;
  roles: string[];
  policyId?: string;
  enabled: boolean;
  expiresAt?: number;
  lastUsedAt?: number;
}

/**
 * The configuration that decides what gets sponsored.
 *
 * Read-only, and the server proxy enforces that (GET on an allowlist of resources) rather than
 * relying on this page not offering a button. Editing policy changes what money is spent on, and
 * that belongs behind the operator's own authenticated session, not behind whoever can reach this
 * console.
 *
 * The admin key lives on the dashboard SERVER and never reaches the browser, so a deployment
 * without one degrades to a clear message rather than to a broken page.
 */
export default function PoliciesPage() {
  const {telemetry} = useTelemetry();
  const policies = useAdminResource<StoredPolicy[]>("policies");
  const keys = useAdminResource<ApiKeyView[]>("keys");

  return (
    <>
      <PageHeader
        title="Policies & keys"
        description="The rule sets that decide whether to sponsor, and the credentials that may ask. Read-only: this console observes, it does not change what gets sponsored."
        actions={
          telemetry?.health?.policies !== undefined ? (
            <span className="text-xs text-ash-500">
              generation <span className="tnum text-ash-200">{telemetry.health.policies.generation}</span>
            </span>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Panel
          title="Policies"
          subtitle={policies.data === undefined ? "Loading" : `${policies.data.length} loaded`}
          hint="Every rule must allow; the first denial refuses the request and names itself. Rules are evaluated cheapest-first, so a rule that makes a chain call runs last."
          delay={0}
        >
          <Resource state={policies} icon={LuScrollText}>
            {(list) => (
              <ul className="space-y-3">
                {list.map((policy) => (
                  <li key={policy.id} className="rounded-md border border-border bg-oil-900 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-ash-100">{policy.id}</span>
                      <StatusPill
                        severity={policy.enabled ? "good" : "unknown"}
                        label={policy.enabled ? "enabled" : "disabled"}
                      />
                      <span className="ml-auto text-[11px] text-ash-600">
                        {policy.rules.length} rule{policy.rules.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    {policy.name !== policy.id ? (
                      <p className="mt-1 text-xs text-ash-400">{policy.name}</p>
                    ) : null}
                    {policy.description !== undefined ? (
                      <p className="mt-1 text-[11px] leading-relaxed text-ash-600">{policy.description}</p>
                    ) : null}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {policy.rules.map((rule, index) => (
                        <Badge
                          key={`${rule.ruleType}-${index}`}
                          variant="outline"
                          className="border-ash-800 bg-oil-800 font-mono text-[10px] font-normal text-ash-400"
                        >
                          {rule.ruleType}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Resource>
        </Panel>

        <Panel
          title="API keys"
          subtitle={keys.data === undefined ? "Loading" : `${keys.data.length} registered`}
          hint="Only the hash of a key is ever stored, so the secret shown at creation is the only copy. Revocation is a flag, which is what keeps the audit history intact."
          delay={0.06}
        >
          <Resource state={keys} icon={LuKeyRound}>
            {(list) => (
              <ul className="divide-y divide-border">
                {list.map((key) => (
                  <li key={key.id} className="flex flex-wrap items-center gap-2 py-2.5 first:pt-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm text-ash-100">{key.name}</span>
                        {!key.enabled ? (
                          <Badge variant="outline" className="border-critical/30 text-[10px] text-critical">
                            revoked
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ash-600">
                        <span className="font-mono">{key.displayPrefix}…</span>
                        {key.policyId !== undefined ? (
                          <>
                            <span className="text-ash-700">·</span>
                            <span className="inline-flex items-center gap-1">
                              <LuLock className="size-2.5" aria-hidden />
                              {key.policyId}
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {key.roles.map((role) => (
                        <Badge
                          key={role}
                          variant="outline"
                          className="border-ash-800 bg-oil-800 text-[10px] font-normal text-ash-400"
                        >
                          {role}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Resource>
        </Panel>
      </div>
    </>
  );
}

interface ResourceState<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

function useAdminResource<T>(resource: string): ResourceState<T> {
  const [state, setState] = useState<ResourceState<T>>({data: undefined, error: undefined, loading: true});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/admin/${resource}`, {cache: "no-store"});
        const body = (await response.json()) as {data?: T; error?: string};
        if (cancelled) return;
        setState({data: body.data, error: body.error, loading: false});
      } catch (cause) {
        if (!cancelled) {
          setState({data: undefined, error: cause instanceof Error ? cause.message : String(cause), loading: false});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resource]);

  return state;
}

function Resource<T>({
  state,
  icon: Icon,
  children,
}: {
  state: ResourceState<T[]>;
  icon: React.ComponentType<{className?: string}>;
  children: (data: T[]) => React.ReactNode;
}) {
  if (state.loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-16 w-full rounded-md bg-oil-800" />
        ))}
      </div>
    );
  }

  if (state.error !== undefined) {
    // The most likely cause by far is an unconfigured key, so it is named explicitly rather than
    // left as "request failed" — the fix is one environment variable.
    const missingKey = state.error.includes("PAYMASTER_ADMIN_KEY");
    return (
      <EmptyState
        title={missingKey ? "Admin API not configured" : "Could not load"}
        detail={
          missingKey
            ? "Set PAYMASTER_ADMIN_KEY on the dashboard server to an admin API key. It stays server-side and is never sent to the browser."
            : state.error
        }
      />
    );
  }

  if (state.data === undefined || state.data.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-6">
        <Icon className="size-5 text-ash-700" aria-hidden />
        <EmptyState title="Nothing here yet" />
      </div>
    );
  }

  return <>{children(state.data)}</>;
}
