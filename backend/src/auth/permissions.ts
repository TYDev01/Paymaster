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

  /** Full operator access, including rotating keys and changing policy. */
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
