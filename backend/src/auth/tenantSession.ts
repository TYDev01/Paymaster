import type {Membership, TenantRepository, TenantRole} from "../db/tenantRepository.js";
import {tenantId} from "../db/scope.js";
import type {IdentityProvider} from "./identity.js";
import type {JwtService} from "./jwt.js";
import type {Role} from "./permissions.js";

/**
 * Turns a verified person into a session scoped to one tenant.
 *
 * The exchange is the whole security boundary of the dashboard, and it is deliberately three
 * separate steps that cannot be collapsed:
 *
 *   1. The identity provider says WHO this is. It says nothing about what they may do.
 *   2. `tenant_members` says which tenants that person may act within. This is our data, not the
 *      provider's — a Privy token cannot assert membership of anything.
 *   3. The session is minted for ONE tenant, with the role that membership grants.
 *
 * A provider that was compromised could therefore impersonate a person, but could not grant itself
 * access to a tenant that person is not a member of.
 */
export interface TenantSessionOptions {
  /**
   * Whether an unknown person may create their own tenant on first sign-in.
   *
   * Off by default. Self-service signup is a product decision with an abuse dimension — every
   * unauthenticated visitor with a provider account can create rows — so a deployment opts in
   * rather than discovering it.
   */
  readonly allowSelfSignup: boolean;
  /** Generates a tenant id. Injected so tests are deterministic. */
  readonly newTenantId?: () => string;
}

export type SessionFailure =
  | {readonly ok: false; readonly reason: "invalid-identity"}
  | {readonly ok: false; readonly reason: "no-membership"}
  | {readonly ok: false; readonly reason: "not-a-member"}
  | {readonly ok: false; readonly reason: "ambiguous-tenant"; readonly memberships: readonly Membership[]}
  | {readonly ok: false; readonly reason: "tenant-suspended"}
  | {readonly ok: false; readonly reason: "signup-disabled"};

export type SessionResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt: number;
      readonly subject: string;
      readonly membership: Membership;
    }
  | SessionFailure;

export class TenantSessionService {
  constructor(
    private readonly identity: IdentityProvider,
    private readonly tenants: TenantRepository,
    private readonly jwt: JwtService,
    private readonly options: TenantSessionOptions,
  ) {}

  /** The tenants this person belongs to. Used by the dashboard to offer a choice. */
  async membershipsFor(
    providerToken: string,
  ): Promise<{subject: string; memberships: readonly Membership[]} | undefined> {
    const verified = await this.identity.verify(providerToken);
    if (!verified.ok) return undefined;
    return {
      subject: verified.identity.subject,
      memberships: await this.tenants.membershipsFor(verified.identity.subject),
    };
  }

  /**
   * Exchanges a provider token for a session.
   *
   * When the caller names a tenant, membership of THAT tenant is required — naming one is a request,
   * never a grant. When they do not, a single membership is used implicitly and several are refused
   * as ambiguous rather than picked from: silently choosing one would mean an operator could act on
   * the wrong customer's configuration without noticing which.
   */
  async issue(providerToken: string, requested?: string): Promise<SessionResult> {
    const verified = await this.identity.verify(providerToken);
    if (!verified.ok) return {ok: false, reason: "invalid-identity"};

    const subject = verified.identity.subject;

    let membership: Membership | undefined;
    if (requested !== undefined) {
      membership = await this.tenants.membership(subject, tenantId(requested));
      if (membership === undefined) return {ok: false, reason: "not-a-member"};
    } else {
      const memberships = await this.tenants.membershipsFor(subject);
      if (memberships.length === 0) return {ok: false, reason: "no-membership"};
      if (memberships.length > 1) return {ok: false, reason: "ambiguous-tenant", memberships};
      membership = memberships[0]!;
    }

    // A suspended tenant keeps its data and its balance and is refused a session. This is what an
    // unpaid subscription reaches — recoverable by paying, never by us deleting anything.
    if (membership.tenant.status === "suspended") return {ok: false, reason: "tenant-suspended"};

    return this.#mint(subject, membership);
  }

  /**
   * Creates a tenant with this person as owner, and returns a session for it.
   *
   * The tenant id is generated, never taken from the caller. A caller-chosen id would let someone
   * claim `default` — the id every existing single-tenant deployment's data is backfilled to.
   */
  async signUp(providerToken: string, name: string): Promise<SessionResult> {
    if (!this.options.allowSelfSignup) return {ok: false, reason: "signup-disabled"};

    const verified = await this.identity.verify(providerToken);
    if (!verified.ok) return {ok: false, reason: "invalid-identity"};

    const id = tenantId(this.options.newTenantId?.() ?? randomTenantId());
    const tenant = await this.tenants.createWithOwner({id, name, subject: verified.identity.subject});

    return this.#mint(verified.identity.subject, {tenant, role: "owner"});
  }

  #mint(subject: string, membership: Membership): SessionResult {
    const {token, expiresAt} = this.jwt.sign({
      // The provider's subject, not an api key id: this session belongs to a PERSON, and the audit
      // log should name them rather than a credential they do not have.
      sub: subject,
      tenantId: membership.tenant.id,
      name: membership.tenant.name,
      roles: rolesFor(membership.role),
      policyId: undefined,
    });
    return {ok: true, token, expiresAt, subject, membership};
  }
}

/**
 * Tenant role → what the session may do.
 *
 * `tenant_admin` rather than `admin`, and the difference is the whole point: neither grants
 * `sponsor:create`, so a browser session cannot spend the tenant's balance directly. It can still
 * MINT a key that spends — that is the product, and the escalation rule permits exactly that one
 * delegation — but the theft then has to write an audit entry naming a credential that can be
 * revoked on its own, rather than quietly spending as the person whose tab was open.
 */
export function rolesFor(role: TenantRole): readonly Role[] {
  switch (role) {
    case "owner":
    case "admin":
      return ["tenant_admin"];
    case "member":
      return ["viewer"];
  }
}

/**
 * A tenant id: `t_` plus 128 bits of randomness, base36.
 *
 * Random rather than sequential because tenant ids appear in api keys, in on-chain balance keys and
 * in billing records — an id that leaks how many customers exist, or that lets one be guessed from
 * another, is an id that will eventually be embarrassing.
 */
function randomTenantId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return `t_${value.toString(36)}`;
}
