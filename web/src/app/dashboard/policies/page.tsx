"use client";

import {useState} from "react";
import {LuCheck, LuPlus, LuTriangleAlert} from "react-icons/lu";

import {Busy, Empty, ErrorNote, Mono, Note, PageHeader, Panel} from "@/components/panel";
import {formatDate, postAccountResource, useAccountResource} from "@/lib/account";

/**
 * The account's own sponsorship policies, editable.
 *
 * A policy is an ordered list of rules that must ALL pass for an operation to be sponsored. Customers
 * write their own; the platform appends its plan's ceilings when the policy loads, so a rule here can
 * tighten what the plan allows but never loosen it. Validation happens on the server, against the
 * same schema that builds the rules — the error it returns names the rule and field to fix.
 *
 * Edited as JSON on purpose. The rule set is small and precisely specified, and a form per rule type
 * would be seven forms that drift from the schema they imitate.
 */
interface StoredPolicy {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly rules: readonly {readonly ruleType: string; readonly config?: unknown}[];
  readonly updatedAt: number;
}

const NEW_POLICY = {
  id: "production",
  name: "Production",
  description: "Sponsors calls to our contracts only.",
  enabled: true,
  rules: [
    {ruleType: "target-allowlist", config: {addresses: ["0x0000000000000000000000000000000000000000"]}},
    {
      ruleType: "quota",
      config: {name: "per-wallet-daily", subject: "wallet", unit: "operations", limit: "50", windowSeconds: 86400},
    },
  ],
};

export default function PoliciesPage() {
  const policies = useAccountResource<StoredPolicy[]>("policies");
  const rows = policies.data ?? [];
  const [editing, setEditing] = useState<string | undefined>(undefined);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Policies"
        lede="What your API keys may sponsor. Every rule in a policy must pass. Your plan's limits are applied on top, so nothing here can raise them."
      />

      {policies.loading && policies.data === undefined ? (
        <Panel>
          <Busy label="Reading your policies…" />
        </Panel>
      ) : policies.error !== undefined ? (
        <Panel>
          <ErrorNote message={policies.error} onRetry={policies.reload} />
        </Panel>
      ) : (
        <>
          {rows.length === 0 ? (
            <Panel>
              <Empty>This account has no policies, so no key can sponsor anything yet.</Empty>
            </Panel>
          ) : (
            rows.map((policy) => (
              <PolicyEditor
                key={policy.id}
                initial={policy}
                open={editing === policy.id}
                onToggle={() => setEditing(editing === policy.id ? undefined : policy.id)}
                onSaved={policies.reload}
              />
            ))
          )}

          {editing === "__new" ? (
            <PolicyEditor
              initial={undefined}
              open
              onToggle={() => setEditing(undefined)}
              onSaved={() => {
                setEditing(undefined);
                policies.reload();
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing("__new")}
              className="flex items-center gap-2 rounded-md border border-ash-700 px-3 py-1.5 text-sm text-ash-200 transition-colors hover:border-ash-500"
            >
              <LuPlus className="size-4" aria-hidden />
              New policy
            </button>
          )}

          <Note>
            Rule types: <Mono>chain-enabled</Mono>, <Mono>sender-allowlist</Mono>, <Mono>sender-blocklist</Mono>,{" "}
            <Mono>target-allowlist</Mono>, <Mono>method-allowlist</Mono>, <Mono>no-value-transfer</Mono>,{" "}
            <Mono>token-ownership</Mono> and <Mono>quota</Mono>. Amounts are strings of wei. A key uses the policy named{" "}
            <Mono>default</Mono> unless it is pinned to another one. Changes apply to live traffic within seconds.
          </Note>
        </>
      )}
    </div>
  );
}

function PolicyEditor({
  initial,
  open,
  onToggle,
  onSaved,
}: {
  initial: StoredPolicy | undefined;
  open: boolean;
  onToggle: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(() =>
    JSON.stringify(
      initial === undefined
        ? NEW_POLICY
        : {
            id: initial.id,
            name: initial.name,
            description: initial.description,
            enabled: initial.enabled,
            rules: initial.rules,
          },
      null,
      2,
    ),
  );
  const [result, setResult] = useState<{ok: boolean; message: string} | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  async function save() {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (err) {
      setResult({ok: false, message: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}`});
      return;
    }
    setSaving(true);
    try {
      await postAccountResource("policies", body);
      setResult({ok: true, message: "Saved. It applies to new sponsorship requests now."});
      onSaved();
    } catch (err) {
      setResult({ok: false, message: err instanceof Error ? err.message : String(err)});
    } finally {
      setSaving(false);
    }
  }

  return (
    <Panel
      title={initial === undefined ? "New policy" : `${initial.name} · ${initial.id}`}
      action={
        <button type="button" onClick={onToggle} className="text-[11px] text-ash-500 hover:text-ash-300">
          {open ? "Close" : "Edit"}
        </button>
      }
    >
      {initial !== undefined && !open ? (
        <p className="px-4 pb-4 text-[12px] text-ash-500">
          {initial.enabled ? "Enabled" : <span className="text-warning">Disabled</span>} · {initial.rules.length} rule
          {initial.rules.length === 1 ? "" : "s"} · updated {formatDate(initial.updatedAt)}
        </p>
      ) : null}
      {open ? (
        <div className="space-y-2 p-4 pt-0">
          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setResult(undefined);
            }}
            spellCheck={false}
            rows={Math.min(28, Math.max(10, text.split("\n").length + 1))}
            className="w-full rounded-md border border-ash-800 bg-oil-950 p-3 font-mono text-[12px] leading-relaxed text-ash-100 outline-none focus:border-ash-600"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-md bg-ash-200 px-4 py-1.5 text-sm font-medium text-oil-950 hover:bg-ash-100 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {result === undefined ? null : (
              <p className={`flex gap-1.5 text-[11px] leading-relaxed ${result.ok ? "text-ash-300" : "text-critical"}`}>
                {result.ok ? (
                  <LuCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                ) : (
                  <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                )}
                {result.message}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
