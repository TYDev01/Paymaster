/**
 * The SDK targets `fetch`, which is global in every runtime it supports — browsers, Node >= 18,
 * Deno, Bun, edge. Depending on a specific HTTP library is what makes an SDK framework-bound; a
 * caller with their own fetch (a proxy, a test double) passes it in.
 */
export type FetchLike = typeof fetch;

export class PaymasterSdkError extends Error {
  constructor(message: string, cause?: unknown) {
    // Error.cause is standard since ES2022; use it rather than shadowing it with a field.
    super(message, cause === undefined ? undefined : {cause});
    this.name = "PaymasterSdkError";
  }
}

/** A JSON-RPC error returned by the bundler, carrying the code a caller needs to branch on. */
export class JsonRpcError extends PaymasterSdkError {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

/** An error body from the sponsorship/admin HTTP API, which is REST-shaped, not JSON-RPC. */
export class HttpApiError extends PaymasterSdkError {
  constructor(
    readonly status: number,
    readonly errorCode: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "HttpApiError";
  }
}

export interface TransportOptions {
  readonly fetch?: FetchLike | undefined;
  readonly headers?: Record<string, string> | undefined;
  /** Per-request timeout in ms. A hung bundler must not hang the caller forever. */
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Resolves `fetch`, preferring an injected one, erroring clearly when none exists. */
function resolveFetch(injected: FetchLike | undefined): FetchLike {
  if (injected !== undefined) return injected;
  if (typeof fetch !== "undefined") return fetch;
  throw new PaymasterSdkError(
    "no global fetch available; pass one via { fetch } (Node < 18, or a non-standard runtime)",
  );
}

async function post(url: string, body: unknown, options: TransportOptions): Promise<unknown> {
  const doFetch = resolveFetch(options.fetch);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers: {"content-type": "application/json", ...options.headers},
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new PaymasterSdkError(`request to ${url} timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    }
    throw new PaymasterSdkError(`request to ${url} failed`, cause);
  } finally {
    clearTimeout(timeout);
  }

  const text = await response.text();
  const parsed = text === "" ? undefined : safeJson(text);
  return {response, parsed};
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {__raw: text};
  }
}

/** A JSON-RPC 2.0 call, for the bundler. */
export async function jsonRpc<T>(url: string, method: string, params: unknown[], options: TransportOptions): Promise<T> {
  const {parsed} = (await post(url, {jsonrpc: "2.0", id: 1, method, params}, options)) as {parsed: unknown};
  const body = parsed as {result?: T; error?: {code: number; message: string; data?: unknown}} | undefined;

  if (body?.error != null) {
    throw new JsonRpcError(body.error.code, body.error.message, body.error.data);
  }
  if (body === undefined || !("result" in body)) {
    throw new PaymasterSdkError(`malformed JSON-RPC response from ${url} for ${method}`);
  }
  return body.result as T;
}

/** A REST-shaped POST/GET, for the sponsorship and admin API. */
export async function httpApi<T>(
  url: string,
  body: unknown,
  options: TransportOptions,
): Promise<T> {
  const {response, parsed} = (await post(url, body, options)) as {response: Response; parsed: unknown};

  if (!response.ok) {
    const err = parsed as {error?: string; message?: string; code?: string} | undefined;
    throw new HttpApiError(
      response.status,
      err?.code ?? err?.error ?? "ERROR",
      err?.message ?? `${response.status} from ${url}`,
      parsed,
    );
  }
  return parsed as T;
}
