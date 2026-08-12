import {NextResponse} from "next/server";

import {SESSION_COOKIE} from "@/lib/session";

/**
 * Drops the session cookie.
 *
 * The session JWT itself stays valid until it expires — it is stateless, and there is no
 * revocation list. That is a deliberate limit worth knowing rather than papering over: signing out
 * ends the session in THIS browser, and a token already copied out of it would keep working for
 * the rest of its short life. The mitigation is the short life, not the button.
 */
export async function POST() {
  const response = NextResponse.json({ok: true});
  response.cookies.set(SESSION_COOKIE, "", {httpOnly: true, path: "/", maxAge: 0});
  return response;
}
