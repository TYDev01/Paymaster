import {DEFAULT_TENANT_ID, forTenant, tenantId} from "../../src/db/scope.js";

/**
 * Two tenants, for every test that needs to prove one cannot see the other.
 *
 * `ACME` is the default tenant, so a test that does not care about isolation behaves exactly as the
 * single-tenant deployment does. `RIVAL` exists to be the thing that must never appear in ACME's
 * results — naming it that way makes an assertion read as what it is checking.
 */
export const ACME = DEFAULT_TENANT_ID;
export const RIVAL = tenantId("rival");

export const ACME_SCOPE = forTenant(ACME);
export const RIVAL_SCOPE = forTenant(RIVAL);
