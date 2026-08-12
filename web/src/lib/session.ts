import "server-only";

import {cookies} from "next/headers";

/**
 * The customer's session, held in an httpOnly cookie and never in the browser's reach.
 *
 * WHY THE TOKEN LIVES HERE RATHER THAN IN THE BROWSER
 *
 * The obvious design is: sign in with Privy, exchange the Privy token for our session JWT in the
 * browser, keep it in `localStorage`, and call the backend directly. It is also the design where
 * one XSS anywhere on the page — an npm dependency, a chart library, a copied snippet — reads the
 * token and can mint API keys for that customer's account for the next fifteen minutes.
 *
 * So the exchange happens on the server and the result goes into an httpOnly cookie. Script on the
 * page cannot read it. Two things fall out of that for free:
 *
 *   * no CORS, because the browser only ever talks to this app;
 *   * the paymaster backend does not have to be publicly reachable at all — only this server does.
 *
 * The cost is that every call is a proxy hop through a route handler. That is the right trade for
 * an app whose entire purpose is administering an account that can spend money.
 */
export const SESSION_COOKIE = "pm_session";

export interface DashboardConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /**
   * Whether cookies are marked `Secure`. Off only for local http development — a session cookie
   * without it on a real deployment travels in clear text on the first request to an http URL.
   */
  readonly secureCookies: boolean;
}

export function dashboardConfig(): DashboardConfig {
  return {
    // 3100, not 3000: this app owns 3000, because that is the address a person types. The backend
    // keeps 3000 as its own PORT inside its container — only the host mapping moves.
    baseUrl: (process.env["PAYMASTER_API_URL"] ?? "http://127.0.0.1:3100").replace(/\/+$/, ""),
    timeoutMs: Number(process.env["PAYMASTER_TIMEOUT_MS"] ?? 8_000),
    // Defaults to ON. A deployment that forgets to set this gets the safe behaviour, and a
    // developer on http localhost is the one who has to opt out.
    secureCookies: process.env["DASHBOARD_INSECURE_COOKIES"] !== "true",
  };
}

export type ApiResult<T> =
  | {readonly ok: true; readonly data: T}
  | {readonly ok: false; readonly error: string; readonly status: number};

/**
 * Calls the paymaster backend.
 *
 * Failures are values, not exceptions: a dashboard that throws a 500 page when the backend is
 * unreachable tells a customer nothing, while "the paymaster API is unreachable" tells them the
 * problem is not theirs and not their account's.
 */
export async function api<T>(
  path: string,
  init: RequestInit & {token?: string | undefined} = {},
): Promise<ApiResult<T>> {
  const config = dashboardConfig();
  const {token, ...requestInit} = init;

  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...requestInit,
      headers: {
        accept: "application/json",
        ...(requestInit.body === undefined ? {} : {"content-type": "application/json"}),
        ...(token === undefined ? {} : {authorization: `Bearer ${token}`}),
        ...requestInit.headers,
      },
      signal: AbortSignal.timeout(config.timeoutMs),
      // Never cached. Every page here shows account state that a customer may have just changed.
      cache: "no-store",
    });

    const text = await response.text();
    const body: unknown = text === "" ? {} : safeParse(text);

    if (!response.ok) {
      return {ok: false, error: messageOf(body) ?? `the paymaster API responded ${response.status}`, status: response.status};
    }
    return {ok: true, data: body as T};
  } catch (error) {
    return {ok: false, error: describe(error), status: 0};
  }
}

/** The current session token, or undefined when signed out. */
export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/**
 * Cookie attributes for the session.
 *
 * `maxAge` mirrors the token's own expiry rather than outliving it. A cookie that survives its
 * token turns "your session expired, sign in again" into a page of failed requests.
 */
export function sessionCookieOptions(expiresAt: number) {
  const config = dashboardConfig();
  const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  return {
    httpOnly: true,
    secure: config.secureCookies,
    // `lax` rather than `strict`: the sign-in redirect back from an identity provider is a
    // cross-site navigation, and `strict` would drop the cookie on exactly that request.
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {message: text};
  }
}

function messageOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ["message", "error", "reason"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function describe(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "the paymaster API timed out";
  if (error instanceof Error) {
    const cause = (error as {cause?: {code?: string}}).cause;
    if (cause?.code === "ECONNREFUSED") return "the paymaster API refused the connection";
    if (cause?.code === "ENOTFOUND") return "the paymaster API host could not be found";
    return error.message;
  }
  return String(error);
}
