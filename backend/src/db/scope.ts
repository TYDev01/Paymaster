/**
 * Who a query is being run on behalf of.
 *
 * Every repository method that touches tenant-owned data takes one of these. That is the whole
 * mechanism, and it is deliberately not a convention: the parameter is required and typed, so a new
 * endpoint cannot forget to scope its query — it will not compile.
 *
 * The alternative designs were considered and rejected:
 *
 *   * **Scoping in the controller.** One new route that forgets the filter is a cross-tenant data
 *     leak, and controllers are added far more often than repositories are.
 *   * **A plain `tenantId: string` parameter.** It compiles when someone passes a policy id, an api
 *     key id, or the empty string. `TenantId` is branded, so only `tenantId()` produces one.
 *   * **Postgres row-level security.** Genuinely stronger, and worth revisiting: it would enforce
 *     this below the application entirely. It needs a per-request session variable on a pooled
 *     connection, which is a larger change than this slice, and it is additive to what is here.
 *
 * Platform scope — reading across every tenant — is a real requirement for the operator console and
 * the background loops, so it exists. It is a named, greppable value rather than an omitted
 * argument, so "this query sees everything" is always a deliberate, reviewable choice: `grep
 * PLATFORM_SCOPE` lists every place it happens.
 */
declare const brand: unique symbol;

export type TenantId = string & {readonly [brand]: "TenantId"};

export const TENANT_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,64}$/;

export class InvalidTenantIdError extends Error {
  constructor(value: string) {
    super(`invalid tenant id: ${JSON.stringify(value)}`);
    this.name = "InvalidTenantIdError";
  }
}

/**
 * The only way to make a `TenantId`.
 *
 * Validated against the same pattern the column's CHECK enforces, so a malformed id is refused here
 * rather than by the database three layers down — and never interpolated anywhere, since every
 * query below uses a bound parameter.
 */
export function tenantId(value: string): TenantId {
  if (!TENANT_ID_PATTERN.test(value)) throw new InvalidTenantIdError(value);
  return value as TenantId;
}

/** The tenant every existing row is backfilled to, and the one a single-tenant deployment uses. */
export const DEFAULT_TENANT_ID = tenantId("default");

export interface TenantScope {
  readonly kind: "tenant";
  readonly tenantId: TenantId;
}

export interface PlatformScope {
  readonly kind: "platform";
}

export type Scope = TenantScope | PlatformScope;

export function forTenant(id: TenantId | string): TenantScope {
  return {kind: "tenant", tenantId: typeof id === "string" ? tenantId(id) : id};
}

/**
 * Reads across every tenant.
 *
 * Used by the operator console and by the background loops, which are platform components by
 * definition — the spend reconciler correlates on-chain events to sponsorships without knowing or
 * caring whose they are. Never reachable from a tenant-authenticated request.
 */
export const PLATFORM_SCOPE: PlatformScope = {kind: "platform"};

export function isPlatform(scope: Scope): scope is PlatformScope {
  return scope.kind === "platform";
}

/**
 * Renders a scope as a SQL predicate plus its parameters.
 *
 * Returning `TRUE` for platform scope rather than omitting the clause keeps every caller's SQL one
 * shape, so a query cannot accidentally be written without the predicate and still parse.
 *
 * @param column     the tenant column on the table being queried, qualified where a join needs it
 * @param firstIndex the next free bind parameter number ($1, $2, …)
 */
export function scopePredicate(
  scope: Scope,
  column = "tenant_id",
  firstIndex = 1,
): {sql: string; params: readonly string[]; nextIndex: number} {
  if (isPlatform(scope)) return {sql: "TRUE", params: [], nextIndex: firstIndex};
  return {
    sql: `${column} = $${firstIndex}`,
    params: [scope.tenantId],
    nextIndex: firstIndex + 1,
  };
}

/**
 * The tenant a write belongs to.
 *
 * Writes must name a tenant: there is no such thing as creating a row on behalf of everybody. A
 * platform-scoped write is a programming error, caught here rather than producing a row with a NULL
 * owner that no tenant-scoped read will ever return again.
 */
export class PlatformScopeCannotWriteError extends Error {
  constructor(what: string) {
    super(`platform scope cannot ${what}: a write must belong to exactly one tenant`);
    this.name = "PlatformScopeCannotWriteError";
  }
}

export function writingTenant(scope: Scope, what: string): TenantId {
  if (isPlatform(scope)) throw new PlatformScopeCannotWriteError(what);
  return scope.tenantId;
}
