import {NextResponse} from "next/server";

import {api, SESSION_COOKIE, sessionCookieOptions} from "@/lib/session";

/**
 * Creates an organisation with this person as its owner, and signs them in to it.
 *
 * There is deliberately no `tenantId` parameter, here or in the backend. A caller-chosen id could
 * claim `default` — the tenant every existing single-tenant deployment's data was backfilled to —
 * so the id is generated server-side and the customer names the ORGANISATION instead.
 */
interface SessionResponse {
  token: string;
  expiresAt: number;
  subject: string;
  tenant: {id: string; name: string; status: string; role: string};
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {token?: unknown; name?: unknown};
  if (typeof body.token !== "string" || body.token === "") {
    return NextResponse.json({error: "an identity token is required"}, {status: 400});
  }
  if (typeof body.name !== "string" || body.name.trim() === "") {
    return NextResponse.json({error: "an organisation name is required"}, {status: 400});
  }

  const result = await api<SessionResponse>("/auth/signup", {
    method: "POST",
    body: JSON.stringify({token: body.token, name: body.name.trim()}),
  });

  if (!result.ok) {
    return NextResponse.json({error: result.error}, {status: result.status === 0 ? 502 : result.status});
  }

  const response = NextResponse.json({
    subject: result.data.subject,
    tenant: result.data.tenant,
    expiresAt: result.data.expiresAt,
  });
  response.cookies.set(SESSION_COOKIE, result.data.token, sessionCookieOptions(result.data.expiresAt));
  return response;
}
