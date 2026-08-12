import {NextResponse} from "next/server";

import {adminFetch} from "@/lib/backend";

/**
 * A read-only window onto the admin API.
 *
 * Two deliberate restrictions:
 *
 *   1. **Allowlisted resources, never a path passthrough.** A `[...path]` proxy would forward
 *      anything the caller wrote, including `DELETE /admin/keys/:id`, with the server's admin
 *      credential attached — turning a dashboard into an unauthenticated remote for the whole
 *      admin API. The allowlist is the control.
 *   2. **GET only.** This dashboard observes; it does not mutate policy or revoke keys. Those
 *      change what gets sponsored, and they belong behind the operator's own authenticated session
 *      rather than behind whoever can reach this page.
 *
 * The admin key stays on the server (see lib/backend.ts) and is never sent to the browser.
 */
/**
 * Each resource's path and the key its list arrives under.
 *
 * The admin API wraps every list in a named envelope (`{policies: [...]}`) — deliberately, so a
 * response can carry a caveat alongside the rows, which `/admin/sponsorships` does. Unwrapping here
 * means the UI works with arrays and the caveat stays available rather than being dropped silently.
 */
const ALLOWED = {
  policies: {path: "/admin/policies", key: "policies"},
  keys: {path: "/admin/keys", key: "keys"},
  sponsorships: {path: "/admin/sponsorships", key: "sponsorships"},
  audit: {path: "/admin/audit", key: "entries"},
} as const;

type Resource = keyof typeof ALLOWED;

function isAllowed(value: string): value is Resource {
  return Object.hasOwn(ALLOWED, value);
}

// Route handlers are uncached in Next 16, which is what a monitoring endpoint needs; no opt-out
// is required, and adding `force-dynamic` would only imply that caching was otherwise in play.
export async function GET(request: Request, context: {params: Promise<{resource: string}>}) {
  const {resource} = await context.params;
  if (!isAllowed(resource)) {
    return NextResponse.json({error: `unknown resource "${resource}"`}, {status: 404});
  }

  // Only the query parameters the admin API documents, so a caller cannot smuggle anything through.
  const incoming = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();
  for (const key of ["limit", "chainId", "apiKeyId", "sender"]) {
    const value = incoming.get(key);
    if (value !== null) forwarded.set(key, value);
  }

  const {path, key} = ALLOWED[resource];
  const query = forwarded.toString();
  const result = await adminFetch<Record<string, unknown>>(`${path}${query === "" ? "" : `?${query}`}`);

  if (!result.ok) {
    return NextResponse.json({error: result.error, status: result.status ?? null}, {status: 200});
  }

  const envelope = result.data;
  const rows = envelope?.[key];
  return NextResponse.json({
    data: Array.isArray(rows) ? rows : [],
    // `/admin/sponsorships` ships a note saying these are commitments rather than spend. Carrying
    // it through means the UI can show the caveat instead of quietly presenting them as spend.
    note: typeof envelope?.["note"] === "string" ? envelope["note"] : undefined,
  });
}
