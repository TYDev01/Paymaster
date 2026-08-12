import {NextResponse} from "next/server";

import {api, SESSION_COOKIE, sessionCookieOptions} from "@/lib/session";

/**
 * Exchanges a Privy access token for a paymaster session, and stores the session in an httpOnly
 * cookie.
 *
 * The Privy token arrives from the browser, which is fine: it is the customer's own credential and
 * proves only who they are. What comes BACK is the thing that must not touch the browser — a
 * session that can mint API keys — so it goes straight into a cookie script cannot read, and the
 * response carries only what the UI needs to render.
 *
 * Membership is never asserted here. The browser can name a tenant, and the backend decides whether
 * this person belongs to it; a tenant a caller could name is a tenant a caller could act as.
 */
interface SessionResponse {
  token: string;
  expiresAt: number;
  subject: string;
  tenant: {id: string; name: string; status: string; role: string};
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {token?: unknown; tenantId?: unknown};
  if (typeof body.token !== "string" || body.token === "") {
    return NextResponse.json({error: "an identity token is required"}, {status: 400});
  }

  const result = await api<SessionResponse>("/auth/session", {
    method: "POST",
    body: JSON.stringify({
      token: body.token,
      ...(typeof body.tenantId === "string" ? {tenantId: body.tenantId} : {}),
    }),
  });

  if (!result.ok) {
    // The backend answers every auth failure identically so the response cannot be used to probe
    // which tenants exist. Passing its status and message through unchanged preserves that.
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
