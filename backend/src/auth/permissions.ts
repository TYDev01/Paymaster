/**
 * Permissions are the unit of authorisation; roles are only a bundle of them.
 *
 * Checks are written against permissions, never roles. `hasRole("admin")` scattered through the
 * code is how authorisation ossifies: adding a role then means auditing every call site. A guard
 * that asks "may this caller create a sponsorship?" keeps the answer in one place.
 */
export const PERMISSIONS = [
  "sponsor:create",
  "policy:read",
  "policy:write",
  "chain:read",
  "chain:write",
  "key:read",
  "key:write",
  "metrics:read",
  /**
   * Read across every tenant.
   *
   * The operator's view, and nothing else: it widens READS to platform scope and never widens
   * writes, which stay bound to the holder's own tenant. Deliberately a permission rather than a
   * special case in a controller, so "who can see everything" is answerable by grepping for it.
   */
  "platform:read",
  /**
   * Record a subscription payment for any tenant.
   *
   * Separate from `platform:read` and held only by `platform`, because it is a WRITE that reaches
   * across the tenant boundary — the one exception to "writes never widen". It has to be: billing
   * is something the platform does TO an account, and a customer who could extend their own
   * subscription would not need to pay for one.
   *
   * It grants nothing else. A key with only this permission can move a paid-through date and read
   * nothing at all.
   */
  "billing:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = {
  /**
   * A dApp integrating the paymaster. Deliberately the narrowest useful role: it can spend the
   * deposit within policy and can do nothing else. This is the role nearly every key should have.
   */
  sponsor: ["sponsor:create"],

  /** Read-only operator access: dashboards and support, no mutation. */
  viewer: ["policy:read", "chain:read", "key:read", "metrics:read"],

  /** Full access WITHIN one tenant, including rotating keys and changing policy. */
  admin: [
    "sponsor:create",
    "policy:read",
    "policy:write",
    "chain:read",
    "chain:write",
    "key:read",
    "key:write",
    "metrics:read",
  ],

  /**
   * A customer administering their OWN account from the dashboard.
   *
   * Everything `admin` grants except `sponsor:create`: a browser session must not be able to spend
   * the tenant's balance directly. It can still ISSUE a key that spends — that is the product — and
   * the difference is not cosmetic. Spending from a stolen session leaves an api key id in the
   * sponsorship record that was never deliberately created; spending through a minted key means the
   * theft first had to write an audit entry naming the new credential, which is both visible and
   * revocable without ending every other session.
   */
  tenant_admin: ["policy:read", "policy:write", "chain:read", "key:read", "key:write", "metrics:read"],

  /**
   * The platform operator: everything `admin` grants, plus reads across every tenant.
   *
   * Never grantable through the API. `createKey` refuses to grant a role its caller does not hold,
   * and no tenant-scoped session ever holds this one — it can only arrive by seeding
   * (BOOTSTRAP_API_KEY) or by an operator writing the row. That restriction is the whole reason it
   * is safe for this role to exist at all: otherwise any tenant admin could mint themselves a key
   * that reads every other customer's configuration.
   */
  platform: [
    "sponsor:create",
    "policy:read",
    "policy:write",
    "chain:read",
    "chain:write",
    "key:read",
    "key:write",
    "metrics:read",
    "platform:read",
    "billing:write",
  ],
} as const satisfies Record<string, readonly Permission[]>;

export type Role = keyof typeof ROLES;

export const ROLE_NAMES = Object.keys(ROLES) as readonly Role[];

export function isRole(value: string): value is Role {
  return Object.hasOwn(ROLES, value);
}

/** Flattens roles to the permission set they grant. Union, never intersection. */
export function permissionsFor(roles: readonly Role[]): ReadonlySet<Permission> {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLES[role]) granted.add(permission);
  }
  return granted;
}
