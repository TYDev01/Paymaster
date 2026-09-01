"use client";

import {useState} from "react";
import {LuCheck, LuCopy, LuKeyRound, LuTriangleAlert} from "react-icons/lu";

import {Busy, Empty, ErrorNote, Note, PageHeader, Panel} from "@/components/panel";
import {formatDate, postAccountResource, useAccountResource} from "@/lib/account";

/**
 * The customer's API keys: what exists, and how to mint another.
 *
 * The secret is the whole reason this page is shaped the way it is. It comes back exactly once, in
 * the response to the mint, and is never recoverable — the backend stores only a hash. So the newly
 * created key is rendered as a panel that stays put until it is dismissed, rather than as a toast
 * that disappears on a stray click, and the list below shows only the display prefix.
 */
interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly displayPrefix: string;
  readonly roles: readonly string[];
  readonly policyId?: string;
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly expiresAt?: number;
  readonly lastUsedAt?: number;
}

interface CreatedKey extends ApiKey {
  readonly secret: string;
  readonly warning?: string;
}

/**
 * The roles offered here, and why the list is short.
 *
 * `sponsor` is the one nearly every key should have: it can spend the deposit within policy and do
 * nothing else. `viewer` is read-only. The wider roles are deliberately absent — a browser session
 * holds `tenant_admin`, and the backend refuses to mint any key granting a permission the caller
 * does not itself hold, so offering them here would only produce a rejection with a confusing
 * message. `sponsor:create` is the single exception the backend delegates, and that is the product.
 */
const ROLES = [
  {value: "sponsor", label: "Sponsor", detail: "For your server. Spends the balance within policy, and nothing else."},
  {value: "viewer", label: "Viewer", detail: "Read-only: keys, policies and usage. Cannot spend or change anything."},
] as const;

export default function KeysPage() {
  const keys = useAccountResource<ApiKey[]>("keys");
  const [created, setCreated] = useState<CreatedKey | undefined>(undefined);

  return (
    <div className="space-y-6">
      <PageHeader
        title="API keys"
        lede="The credential your dApp presents when it asks for a sponsorship. Each key carries a role, and a key can be revoked without disturbing the others."
      />

      {created === undefined ? null : <SecretPanel created={created} onDismiss={() => setCreated(undefined)} />}

      <MintForm
        onCreated={(key) => {
          setCreated(key);
          keys.reload();
        }}
      />

      <Panel title="Your keys">
        {keys.loading && keys.data === undefined ? (
          <Busy label="Loading your keys…" />
        ) : keys.error !== undefined ? (
          <ErrorNote message={keys.error} onRetry={keys.reload} />
        ) : (keys.data ?? []).length === 0 ? (
          <Empty>
            No keys yet. Mint one above — your dApp cannot call the paymaster without it.
          </Empty>
        ) : (
          <KeyTable keys={keys.data ?? []} />
        )}
      </Panel>
    </div>
  );
}

/**
 * The secret, shown once.
 *
 * The warning is not decoration. A customer who closes this without copying has no way back: the
 * only remedy is to mint another key and revoke this one, and saying so here is cheaper than
 * discovering it later.
 */
function SecretPanel({created, onDismiss}: {created: CreatedKey; onDismiss: () => void}) {
  const [copied, setCopied] = useState(false);

  return (
    <section className="rounded-lg border border-warning/30 bg-warning/5 p-4">
      <p className="flex items-start gap-2 text-[12px] leading-relaxed text-warning">
        <LuTriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          <span className="font-medium">Copy this now.</span>{" "}
          {created.warning ?? "The secret is shown once and is not recoverable."} We store only its
          hash, so if it is lost the only fix is to mint a replacement and revoke this one.
        </span>
      </p>

      <p className="mt-2 pl-6 text-[11px] leading-relaxed text-ash-500">
        Keep it on a server you control. A key is a bearer secret with no origin binding, so one
        shipped to a browser can be read out of the page by anyone who loads it and used to spend
        your balance until it is empty. Have your own backend hold it and decide who gets sponsored.
      </p>

      <div className="mt-3 flex items-center gap-2 rounded-md border border-ash-800 bg-oil-950 px-3 py-2">
        <code className="min-w-0 flex-1 font-mono text-[12px] break-all text-ash-100">{created.secret}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              .writeText(created.secret)
              .then(() => setCopied(true))
              // A clipboard the browser refuses is not an error worth a banner: the secret is on
              // screen and can be selected by hand. Saying "copied" when it was not would be worse.
              .catch(() => setCopied(false));
          }}
          className="flex shrink-0 items-center gap-1.5 rounded border border-ash-800 px-2 py-1 text-[11px] text-ash-300 transition-colors hover:border-ash-700 hover:text-ash-100"
        >
          {copied ? <LuCheck className="size-3.5" aria-hidden /> : <LuCopy className="size-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-[11px] text-ash-600">
          {created.name} · {created.roles.join(", ")}
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[11px] text-ash-500 transition-colors hover:text-ash-300"
        >
          I have copied it
        </button>
      </div>
    </section>
  );
}

function MintForm({onCreated}: {onCreated: (key: CreatedKey) => void}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>(ROLES[0].value);
  const [environment, setEnvironment] = useState<"live" | "test">("live");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const disabled = name.trim() === "" || submitting;

  return (
    <Panel title="Mint a key">
      <form
        className="space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          setError(undefined);
          setSubmitting(true);
          void (async () => {
            try {
              const created = await postAccountResource<CreatedKey>("keys", {
                name: name.trim(),
                roles: [role],
                environment,
              });
              setName("");
              onCreated(created);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setSubmitting(false);
            }
          })();
        }}
      >
        <div>
          <label htmlFor="key-name" className="block text-[11px] uppercase tracking-wide text-ash-600">
            Name
          </label>
          <input
            id="key-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Checkout service"
            maxLength={200}
            className="mt-1.5 w-full rounded-md border border-ash-800 bg-oil-950 px-3 py-2 text-sm text-ash-100 outline-none transition-colors focus:border-ash-600 placeholder:text-ash-700"
          />
          <p className="mt-1 text-[11px] text-ash-600">
            For you, not for the paymaster. Name it after the thing that will hold it, so a key you
            need to revoke later is the one you can identify.
          </p>
        </div>

        <fieldset>
          <legend className="text-[11px] uppercase tracking-wide text-ash-600">Role</legend>
          <div className="mt-1.5 space-y-2">
            {ROLES.map((option) => (
              <label
                key={option.value}
                className={`flex cursor-pointer gap-2.5 rounded-md border px-3 py-2 transition-colors ${
                  role === option.value
                    ? "border-ash-600 bg-oil-800/60"
                    : "border-ash-800 hover:border-ash-700"
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  value={option.value}
                  checked={role === option.value}
                  onChange={() => setRole(option.value)}
                  className="mt-1 accent-ash-300"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ash-100">{option.label}</span>
                  <span className="block text-[11px] leading-relaxed text-ash-500">{option.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-[11px] uppercase tracking-wide text-ash-600">Environment</legend>
          <div className="mt-1.5 flex gap-2">
            {(["live", "test"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setEnvironment(value)}
                className={`rounded-md border px-3 py-1.5 text-[12px] transition-colors ${
                  environment === value
                    ? "border-ash-600 bg-oil-800 text-ash-100"
                    : "border-ash-800 text-ash-500 hover:border-ash-700"
                }`}
              >
                pm_{value}_…
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-ash-600">
            A label in the key’s prefix, so a test credential is recognisable in a log. It does not
            change what the key may do.
          </p>
        </fieldset>

        {error === undefined ? null : (
          <p className="flex gap-2 rounded-md border border-critical/25 bg-critical/10 px-3 py-2 text-[11px] leading-relaxed text-critical">
            <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={disabled}
          className="flex items-center gap-2 rounded-md bg-ash-200 px-4 py-2 text-sm font-medium text-oil-950 transition-colors hover:bg-ash-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <LuKeyRound className="size-4" aria-hidden />
          {submitting ? "Minting…" : "Mint key"}
        </button>
      </form>
    </Panel>
  );
}

function KeyTable({keys}: {keys: readonly ApiKey[]}) {
  return (
    <>
      {/* Its own scroller: a wide table must not make the whole page scroll sideways. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] text-left text-sm">
          <thead>
            <tr className="border-b border-ash-800/60 text-[11px] uppercase tracking-wide text-ash-600">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Prefix</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Created</th>
              <th className="px-4 py-2 font-medium">Last used</th>
              <th className="px-4 py-2 font-medium">State</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className="border-b border-ash-800/30 last:border-b-0">
                <td className="px-4 py-2.5 text-ash-200">{key.name}</td>
                <td className="px-4 py-2.5 font-mono text-[12px] text-ash-400">{key.displayPrefix}…</td>
                <td className="px-4 py-2.5 text-ash-400">{key.roles.join(", ")}</td>
                <td className="px-4 py-2.5 text-ash-500">{formatDate(key.createdAt)}</td>
                {/* "Never" is the useful reading of an absent timestamp here: it means the key was
                    minted and then not wired up, which is worth noticing. */}
                <td className="px-4 py-2.5 text-ash-500">
                  {key.lastUsedAt === undefined ? "Never" : formatDate(key.lastUsedAt)}
                </td>
                <td className="px-4 py-2.5">
                  <span className={key.enabled ? "text-ash-300" : "text-ash-600"}>
                    {key.enabled ? "Active" : "Revoked"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-ash-800/60 p-4">
        <Note>
          Revoking a key is not yet possible from this page — the dashboard proxy allows only reads
          and mints. Until it is, revoke with{" "}
          <code className="font-mono text-ash-400">DELETE /admin/keys/&lt;id&gt;</code> using a key
          that holds <code className="font-mono text-ash-400">key:write</code>.
        </Note>
      </div>
    </>
  );
}
