"use client";

import {useState} from "react";
import {LuBuilding, LuLoader, LuTriangleAlert, LuZap} from "react-icons/lu";

import {useAuth} from "@/components/auth-provider";

/**
 * Everything before a session exists: signing in, choosing an organisation, creating one.
 *
 * They are one component because they are one flow with branches, and splitting them across routes
 * would mean holding "which step am I on" in the URL — where a refresh or a shared link lands
 * someone on a step whose preconditions no longer hold.
 */
export function SignIn() {
  const {configured, loading, identityReady, identityStalled, memberships, error, signIn} = useAuth();

  if (!configured) return <UnconfiguredNotice message={error} />;
  // A stalled provider outranks the spinner: the spinner is what it looked like for the last eight
  // seconds, and continuing to show it is the failure mode this replaces. Already accounts for a
  // provider that answered late — see `identityStalled` in the auth provider.
  if (identityStalled) return <StalledNotice />;

  return (
    <Centred>
      <Brand />

      {error !== undefined ? <ErrorNote message={error} /> : null}

      {loading ? (
        <Busy label={identityReady ? "Loading your account…" : "Checking your session…"} />
      ) : !identityReady ? (
        <>
          <p className="mt-2 text-sm leading-relaxed text-ash-500">
            Sponsor gas for your users, from a balance you fund and control. Sign in to mint an API key.
          </p>
          <button
            type="button"
            onClick={signIn}
            className="mt-6 w-full rounded-md bg-ash-200 px-4 py-2.5 text-sm font-medium text-oil-950 transition-colors hover:bg-ash-100"
          >
            Sign in
          </button>
          <p className="mt-3 text-[11px] leading-relaxed text-ash-700">
            Email, a social account, or a wallet. A wallet is created for you if you do not have one —
            you need one to fund your balance.
          </p>
        </>
      ) : memberships !== undefined && memberships.length === 0 ? (
        <CreateOrganisation />
      ) : memberships !== undefined && memberships.length > 1 ? (
        <ChooseOrganisation />
      ) : (
        <Busy label="Opening your account…" />
      )}
    </Centred>
  );
}

/**
 * More than one organisation, so we ask.
 *
 * Picking one silently is the tempting shortcut and the wrong one: someone who belongs to two
 * accounts would edit policy, mint keys and read spend in whichever we guessed, with nothing on
 * screen saying which. The cost of asking is one click on a rare path.
 */
function ChooseOrganisation() {
  const {memberships, chooseTenant} = useAuth();

  return (
    <div className="mt-6">
      <h2 className="text-sm font-medium text-ash-200">Choose an organisation</h2>
      <p className="mt-1 text-[11px] text-ash-600">You belong to more than one. Everything you do applies to the one you pick.</p>
      <ul className="mt-4 space-y-2">
        {(memberships ?? []).map((tenant) => (
          <li key={tenant.id}>
            <button
              type="button"
              onClick={() => void chooseTenant(tenant.id)}
              className="flex w-full items-center justify-between rounded-md border border-ash-800 bg-oil-900 px-3 py-2.5 text-left transition-colors hover:border-ash-700 hover:bg-oil-800"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm text-ash-100">{tenant.name}</span>
                <span className="block truncate font-mono text-[11px] text-ash-600">{tenant.id}</span>
              </span>
              <span className="ml-3 shrink-0 rounded border border-ash-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ash-500">
                {tenant.role}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CreateOrganisation() {
  const {createOrganisation, loading} = useAuth();
  const [name, setName] = useState("");

  return (
    <form
      className="mt-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() !== "") void createOrganisation(name.trim());
      }}
    >
      <h2 className="text-sm font-medium text-ash-200">Name your organisation</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-ash-600">
        Your keys, policies and balance live under it. Only the name is yours to choose — the account
        id is generated, so it cannot collide with another customer&apos;s.
      </p>
      <div className="mt-4 flex items-center gap-2 rounded-md border border-ash-800 bg-oil-900 px-3 py-2 focus-within:border-ash-600">
        <LuBuilding className="size-4 shrink-0 text-ash-600" aria-hidden />
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Acme"
          maxLength={80}
          className="min-w-0 flex-1 bg-transparent text-sm text-ash-100 outline-none placeholder:text-ash-700"
          aria-label="Organisation name"
        />
      </div>
      <button
        type="submit"
        disabled={name.trim() === "" || loading}
        className="mt-4 w-full rounded-md bg-ash-200 px-4 py-2.5 text-sm font-medium text-oil-950 transition-colors hover:bg-ash-100 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Create organisation
      </button>
    </form>
  );
}

function Centred({children}: {children: React.ReactNode}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-oil-950 px-4">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-md bg-ash-200 text-oil-950">
        <LuZap className="size-4" aria-hidden />
      </span>
      <span className="text-base font-semibold text-ash-100">Paymaster</span>
    </div>
  );
}

function Busy({label}: {label: string}) {
  return (
    <p className="mt-6 flex items-center gap-2 text-sm text-ash-500">
      <LuLoader className="size-4 animate-spin" aria-hidden />
      {label}
    </p>
  );
}

function ErrorNote({message}: {message: string}) {
  return (
    <p className="mt-4 flex gap-2 rounded-md border border-critical/25 bg-critical/10 px-3 py-2 text-[11px] leading-relaxed text-critical">
      <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

/**
 * The identity provider is not answering.
 *
 * Says plainly that it is not the customer's account, offers the one thing that sometimes works
 * (reload), and names the likely causes rather than making them guess. Anything is better than a
 * spinner that never resolves.
 */
function StalledNotice() {
  return (
    <Centred>
      <Brand />
      <div className="mt-6 rounded-md border border-warning/25 bg-warning/10 px-3 py-3">
        <p className="flex gap-2 text-[11px] leading-relaxed text-warning">
          <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">Sign-in is not responding.</span> Nothing is wrong with your
            account — the identity provider has not answered.
          </span>
        </p>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ash-600">
        A content blocker, a corporate network, or an outage at the provider will all do this. Your
        balance, keys and sponsorship are unaffected: they do not go through this page.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-4 w-full rounded-md border border-ash-800 bg-oil-900 px-4 py-2.5 text-sm text-ash-200 transition-colors hover:border-ash-700 hover:bg-oil-800"
      >
        Try again
      </button>
    </Centred>
  );
}

/**
 * A deployment with no identity provider configured.
 *
 * Named as OUR misconfiguration rather than shown as a failed login, because that is what it is:
 * nobody can sign in, and a customer retrying will not change that.
 */
function UnconfiguredNotice({message}: {message: string | undefined}) {
  return (
    <Centred>
      <Brand />
      <div className="mt-6 rounded-md border border-warning/25 bg-warning/10 px-3 py-3">
        <p className="flex gap-2 text-[11px] leading-relaxed text-warning">
          <LuTriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">Sign-in is not configured on this deployment.</span> {message}
          </span>
        </p>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ash-600">
        Set <code className="font-mono text-ash-400">NEXT_PUBLIC_PRIVY_APP_ID</code> to a Privy app id
        and restart. The backend needs <code className="font-mono text-ash-400">PRIVY_APP_ID</code> set
        to the same value, or the sessions this app asks for will be refused.
      </p>
    </Centred>
  );
}
