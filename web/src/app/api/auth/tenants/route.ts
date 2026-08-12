import {NextResponse} from "next/server";

import {api} from "@/lib/session";

/**
 * Which organisations this person belongs to.
 *
 * Asked BEFORE a session exists, which is why it takes the Privy token rather than the session
 * cookie: a person who belongs to two organisations has to be asked which one they are signing in
 * to, and picking one silently would let them act on the wrong customer's account without noticing
 * which.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {token?: unknown};
  if (typeof body.token !== "string" || body.token === "") {
    return NextResponse.json({error: "an identity token is required"}, {status: 400});
  }

  const result = await api<{subject: string; tenants: unknown[]}>("/auth/tenants", {
    method: "POST",
    body: JSON.stringify({token: body.token}),
  });

  if (!result.ok) {
    return NextResponse.json({error: result.error}, {status: result.status === 0 ? 502 : result.status});
  }
  return NextResponse.json(result.data);
}
