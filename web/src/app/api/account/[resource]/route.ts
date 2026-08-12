import {NextResponse} from "next/server";

import {api, sessionToken} from "@/lib/session";

/**
 * The customer's own account, proxied with their session.
 *
 * Every path is allowlisted rather than forwarded. A `[...path]` proxy would pass through whatever
 * the browser wrote — including `POST /admin/subscriptions/payments` — with the caller's session
 * attached. That particular call would be refused by the backend for lack of `billing:write`, and
 * relying on that is exactly the reasoning that goes wrong when a new endpoint is added: the
 * allowlist means a route has to be added here deliberately, not merely exist.
 *
 * The backend is the authority on scope regardless. Every one of these resolves to the tenant in
 * the session's signed claims, so this layer cannot widen what a customer sees even by accident —
 * it can only decide which questions are askable.
 */
const ALLOWED = {
  keys: {path: "/admin/keys", methods: ["GET", "POST"], key: "keys"},
  policies: {path: "/admin/policies", methods: ["GET"], key: "policies"},
  funding: {path: "/admin/funding", methods: ["GET"], key: "funding"},
  subscription: {path: "/admin/subscription", methods: ["GET"], key: undefined},
  sponsorships: {path: "/admin/sponsorships", methods: ["GET"], key: "sponsorships"},
} as const satisfies Record<string, {path: string; methods: readonly string[]; key: string | undefined}>;

type Resource = keyof typeof ALLOWED;

function isAllowed(value: string): value is Resource {
  return Object.hasOwn(ALLOWED, value);
}

/** Only the query parameters the admin API documents, so nothing can be smuggled through. */
const FORWARDED_QUERY = ["limit", "chainId"] as const;

async function proxy(request: Request, resource: string, method: "GET" | "POST"): Promise<NextResponse> {
  if (!isAllowed(resource)) {
    return NextResponse.json({error: `unknown resource "${resource}"`}, {status: 404});
  }

  const route = ALLOWED[resource];
  if (!(route.methods as readonly string[]).includes(method)) {
    return NextResponse.json({error: `${method} is not allowed on ${resource}`}, {status: 405});
  }

  const token = await sessionToken();
  if (token === undefined) {
    // 401 rather than a redirect: this is an API, and the client decides how to present signing in.
    return NextResponse.json({error: "not signed in"}, {status: 401});
  }

  const incoming = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();
  for (const key of FORWARDED_QUERY) {
    const value = incoming.get(key);
    if (value !== null) forwarded.set(key, value);
  }
  const query = forwarded.toString();

  const result = await api<Record<string, unknown>>(`${route.path}${query === "" ? "" : `?${query}`}`, {
    method,
    token,
    ...(method === "POST" ? {body: await request.text()} : {}),
  });

  if (!result.ok) {
    // 401 is passed through unchanged so the client can prompt for sign-in rather than showing an
    // error a customer cannot act on.
    return NextResponse.json({error: result.error}, {status: result.status === 0 ? 502 : result.status});
  }

  // Lists arrive in a named envelope so a response can carry a caveat alongside its rows — which
  // `/admin/sponsorships` does. Unwrapping keeps the UI working with arrays while preserving it.
  if (route.key === undefined) return NextResponse.json({data: result.data});
  const rows = result.data[route.key];
  return NextResponse.json({
    data: Array.isArray(rows) ? rows : [],
    ...(typeof result.data["note"] === "string" ? {note: result.data["note"]} : {}),
  });
}

export async function GET(request: Request, context: {params: Promise<{resource: string}>}) {
  const {resource} = await context.params;
  return proxy(request, resource, "GET");
}

export async function POST(request: Request, context: {params: Promise<{resource: string}>}) {
  const {resource} = await context.params;
  return proxy(request, resource, "POST");
}
