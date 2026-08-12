/**
 * Human identity, as a port.
 *
 * The two authentication paths in this system answer different questions and must not be conflated:
 *
 *   * An **API key** authenticates a MACHINE — a dApp's server asking for a sponsorship. It is
 *     long-lived, it belongs to a tenant, and it may spend.
 *   * An **identity** authenticates a PERSON — someone opening the dashboard. It is provided by an
 *     external provider (Privy), proves only who they are, and by itself grants nothing: the tenants
 *     that person may act within come from `tenant_members`, not from the token.
 *
 * Keeping this a port means the provider is a composition-root decision. Privy is the adapter today;
 * swapping it, or adding a second provider for enterprise SSO, does not reach the session logic.
 */
export interface VerifiedIdentity {
  /**
   * The provider's stable subject for this person — a Privy DID (`did:privy:…`).
   *
   * Stored in `tenant_members.subject`. Deliberately opaque: this system never parses it, so a
   * provider that changes its format does not require a migration.
   */
  readonly subject: string;
  /** Present when the provider asserts one. Used for display only, never for authorisation. */
  readonly email: string | undefined;
  /** Unix seconds at which the provider's own token expires. */
  readonly expiresAt: number;
}

export type IdentityFailureReason =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "wrong-issuer"
  | "wrong-audience"
  | "unknown-key"
  | "provider-unavailable";

export type IdentityResult =
  | {readonly ok: true; readonly identity: VerifiedIdentity}
  | {readonly ok: false; readonly reason: IdentityFailureReason};

export interface IdentityProvider {
  /**
   * Verifies a token from the identity provider.
   *
   * Returns a result rather than throwing, for the same reason the API key authenticator does: the
   * caller responds uniformly regardless of WHY verification failed, and the specific reason goes to
   * the log. Telling a caller whether a token was expired, forged or issued for another application
   * tells an attacker which of those to fix.
   */
  verify(token: string): Promise<IdentityResult>;
}
