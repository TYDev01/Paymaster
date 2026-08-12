"use client";

import {PrivyProvider, usePrivy} from "@privy-io/react-auth";
import {createContext, useCallback, useContext, useEffect, useState, type ReactNode} from "react";

/**
 * Sign-in, in two steps that are easy to conflate and must not be.
 *
 *   1. **Privy proves who you are.** It returns an access token that says "this is
 *      did:privy:alice", and nothing more. It cannot say what alice may touch, because it has never
 *      heard of our tenants.
 *   2. **We decide what you may act as.** The token goes to our server, which asks the paymaster
 *      backend for a session bound to one tenant — and the backend checks `tenant_members` before
 *      issuing one. Naming a tenant is a request, never a grant.
 *
 * The second token never reaches this file. It is set as an httpOnly cookie by the route handler
 * (see lib/session.ts), so what this component holds is only enough to render a name.
 */
export interface TenantView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly role: string;
}

export interface Session {
  readonly subject: string;
  readonly tenant: TenantView;
  readonly expiresAt: number;
}

interface AuthState {
  /** Whether Privy is configured at all. False means this deployment cannot sign anyone in. */
  readonly configured: boolean;
  /**
   * The identity provider has not answered in a reasonable time.
   *
   * Found by running the app with an app id that could not resolve: `ready` never flips, and the
   * page sits on "Checking your session…" indefinitely with nothing to click. That is what an
   * outage at the provider, a blocked script, or a corporate proxy all look like from here, and a
   * permanent spinner tells a customer neither what is wrong nor that it is not their fault.
   */
  readonly identityStalled: boolean;
  /** True until Privy has told us whether there is an existing login. */
  readonly loading: boolean;
  readonly identityReady: boolean;
  readonly session: Session | undefined;
  /** Organisations this person belongs to, once known. Empty means they need to create one. */
  readonly memberships: readonly TenantView[] | undefined;
  readonly error: string | undefined;
  signIn(): void;
  signOut(): Promise<void>;
  chooseTenant(tenantId: string): Promise<void>;
  createOrganisation(name: string): Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === undefined) throw new Error("useAuth must be used inside <AuthProvider>");
  return value;
}

const APP_ID = process.env["NEXT_PUBLIC_PRIVY_APP_ID"];

export function AuthProvider({children}: {children: ReactNode}) {
  // Rendered without the Privy provider when unconfigured, rather than mounting it with an empty
  // app id: that throws inside the SDK, and a blank screen would look like our bug rather than a
  // missing environment variable. `Unconfigured` renders the same shell with an explanation.
  if (APP_ID === undefined || APP_ID === "") {
    return <Unconfigured>{children}</Unconfigured>;
  }

  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        appearance: {theme: "dark", accentColor: "#8a8f98"},
        // An embedded wallet for anyone without one, because funding a balance needs a wallet and
        // "install a browser extension first" is where a signup flow loses people.
        // Nested under the chain in Privy v3. Worth being explicit about: the flat shape from
        // earlier versions type-errors here rather than silently doing nothing, which is the only
        // reason this was caught before a customer hit "fund" with no wallet.
        embeddedWallets: {ethereum: {createOnLogin: "users-without-wallets"}},
      }}
    >
      <SessionBridge>{children}</SessionBridge>
    </PrivyProvider>
  );
}

function Unconfigured({children}: {children: ReactNode}) {
  const state: AuthState = {
    configured: false,
    identityStalled: false,
    loading: false,
    identityReady: false,
    session: undefined,
    memberships: undefined,
    error: "NEXT_PUBLIC_PRIVY_APP_ID is not set, so this deployment cannot sign anyone in.",
    signIn: () => undefined,
    signOut: async () => undefined,
    chooseTenant: async () => undefined,
    createOrganisation: async () => undefined,
  };
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

/**
 * Turns a Privy login into a paymaster session.
 *
 * The exchange is not automatic past the first step. Once Privy says who someone is, we ask which
 * organisations they belong to — and if there is more than one, we stop and let them choose. A
 * dashboard that guessed would let an operator edit the wrong customer's policy without ever
 * seeing which account they were in.
 */
function SessionBridge({children}: {children: ReactNode}) {
  const {ready, authenticated, login, logout, getAccessToken} = usePrivy();
  const [session, setSession] = useState<Session | undefined>(undefined);
  const [memberships, setMemberships] = useState<readonly TenantView[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [working, setWorking] = useState(false);
  const [waitedTooLong, setWaitedTooLong] = useState(false);

  // Eight seconds: long enough that a slow connection is not accused of being broken, short enough
  // that nobody sits watching a spinner wondering whether to reload.
  //
  // The timer only ever sets the flag; "stalled" is then DERIVED as `waitedTooLong && !ready`, so a
  // provider that answers late clears the notice without this effect writing state back.
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setWaitedTooLong(true), 8_000);
    return () => clearTimeout(timer);
  }, [ready]);

  const post = useCallback(async <T,>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(path, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => ({}))) as T & {error?: string};
    if (!response.ok) throw new Error(parsed.error ?? `request failed (${response.status})`);
    return parsed;
  }, []);

  // Once Privy has a login, find out which organisations this person belongs to. Deliberately does
  // not create a session yet — see the note above.
  useEffect(() => {
    if (!ready || !authenticated || session !== undefined || memberships !== undefined) return;
    let cancelled = false;

    void (async () => {
      setWorking(true);
      try {
        const token = await getAccessToken();
        if (token === null) throw new Error("Privy returned no access token");
        const result = await post<{tenants: TenantView[]}>("/api/auth/tenants", {token});
        if (cancelled) return;

        setMemberships(result.tenants);
        // Exactly one organisation is not a choice, so do not make it one.
        if (result.tenants.length === 1) {
          const created = await post<Session>("/api/auth/session", {token, tenantId: result.tenants[0]!.id});
          if (!cancelled) setSession(created);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setWorking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, authenticated, session, memberships, getAccessToken, post]);

  const chooseTenant = useCallback(
    async (tenantId: string) => {
      setError(undefined);
      setWorking(true);
      try {
        const token = await getAccessToken();
        if (token === null) throw new Error("Privy returned no access token");
        setSession(await post<Session>("/api/auth/session", {token, tenantId}));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setWorking(false);
      }
    },
    [getAccessToken, post],
  );

  const createOrganisation = useCallback(
    async (name: string) => {
      setError(undefined);
      setWorking(true);
      try {
        const token = await getAccessToken();
        if (token === null) throw new Error("Privy returned no access token");
        const created = await post<Session>("/api/auth/signup", {token, name});
        setSession(created);
        setMemberships([created.tenant]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setWorking(false);
      }
    },
    [getAccessToken, post],
  );

  const signOut = useCallback(async () => {
    // Our cookie first. If Privy's logout hangs or fails, the session that can spend money is
    // already gone — the reverse order would leave it in place after the UI said "signed out".
    await fetch("/api/auth/logout", {method: "POST"}).catch(() => undefined);
    setSession(undefined);
    setMemberships(undefined);
    setError(undefined);
    await logout();
  }, [logout]);

  const state: AuthState = {
    configured: true,
    identityStalled: waitedTooLong && !ready,
    loading: !ready || working,
    identityReady: ready && authenticated,
    session,
    memberships,
    error,
    signIn: login,
    signOut,
    chooseTenant,
    createOrganisation,
  };

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
