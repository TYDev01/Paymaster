import "server-only";

/**
 * Server-side access to the paymaster backend.
 *
 * Everything here runs on the server, and the `server-only` import makes that a build error rather
 * than a convention. The reason is the admin API key: it authenticates writes to the policy set,
 * so it must never reach the browser bundle. The dashboard therefore talks to route handlers in
 * this app, and only those route handlers hold the credential.
 *
 * This also means the browser never needs CORS on the backend, and the backend never needs to be
 * publicly reachable — only this server does.
 */
export interface BackendConfig {
  readonly baseUrl: string;
  readonly adminKey: string | undefined;
  readonly prometheusUrl: string | undefined;
  readonly timeoutMs: number;
}

export function backendConfig(): BackendConfig {
  return {
    baseUrl: (process.env["PAYMASTER_API_URL"] ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    adminKey: process.env["PAYMASTER_ADMIN_KEY"],
    // Optional. When set, charts show REAL history from Prometheus; without it they show a rolling
    // window built from polling /metrics, which starts empty when the page opens.
    prometheusUrl: process.env["PROMETHEUS_URL"]?.replace(/\/+$/, ""),
    timeoutMs: Number(process.env["PAYMASTER_TIMEOUT_MS"] ?? 5_000),
  };
}

export type BackendResult<T> =
  | {readonly ok: true; readonly data: T; readonly latencyMs: number}
  | {readonly ok: false; readonly error: string; readonly status?: number};

/**
 * Fetches from the backend, converting every failure into a value.
 *
 * A monitoring dashboard exists to be looked at while things are broken, so an unreachable backend
 * is an expected state to RENDER, not an exception to throw: a 500 page tells an operator nothing,
 * while "backend unreachable, last seen 40s ago" tells them what they came to find out.
 */
export async function backendFetch<T>(
  path: string,
  init: RequestInit & {as?: "json" | "text"} = {},
): Promise<BackendResult<T>> {
  const config = backendConfig();
  const {as = "json", ...requestInit} = init;
  const started = Date.now();

  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...requestInit,
      headers: {accept: as === "json" ? "application/json" : "text/plain", ...requestInit.headers},
      signal: AbortSignal.timeout(config.timeoutMs),
      // Always live. A cached monitoring view is worse than no monitoring view: it looks current.
      cache: "no-store",
    });

    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {ok: false, error: `backend responded ${response.status}`, status: response.status};
    }
    const data = (as === "json" ? await response.json() : await response.text()) as T;
    return {ok: true, data, latencyMs};
  } catch (error) {
    return {ok: false, error: describe(error)};
  }
}

/** Admin calls carry the server-held key. Absent key is reported, never silently unauthenticated. */
export async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<BackendResult<T>> {
  const {adminKey} = backendConfig();
  if (adminKey === undefined) {
    return {ok: false, error: "PAYMASTER_ADMIN_KEY is not configured on the dashboard server"};
  }
  return backendFetch<T>(path, {
    ...init,
    headers: {...init.headers, authorization: `Bearer ${adminKey}`},
  });
}

function describe(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "backend timed out";
  if (error instanceof Error) {
    // Node's fetch wraps connection refusals; the cause carries the useful part.
    const cause = (error as {cause?: {code?: string}}).cause;
    if (cause?.code === "ECONNREFUSED") return "backend refused the connection";
    if (cause?.code === "ENOTFOUND") return "backend host not found";
    return error.message;
  }
  return String(error);
}
