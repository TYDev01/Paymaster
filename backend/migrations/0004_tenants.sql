-- Tenants: the boundary the multi-tenant product is built on.
--
-- Everything that can be attributed to a customer gains a tenant_id, and the uniqueness rules that
-- were global become per-tenant. Two consequences are worth stating up front because they are the
-- whole point of this migration:
--
--   1. A policy id is unique WITHIN a tenant, not globally. Without that, the first customer to
--      create a policy called "default" would take the name from everyone else — and "default" is
--      exactly the name the bootstrap policy and DEFAULT_POLICY_ID use.
--
--   2. An api key belongs to exactly one tenant, and the policy it pins must belong to the SAME
--      tenant. That is enforced by a composite foreign key rather than by application code, so a
--      bug in the admin path cannot pin one customer's key to another customer's policy.
--
-- Existing single-tenant deployments upgrade cleanly: every existing row is backfilled to one
-- default tenant, which keeps working exactly as before.

-- ------------------------------------------------------------------------------------------------
-- tenants
-- ------------------------------------------------------------------------------------------------

CREATE TABLE tenants (
    -- Opaque and caller-supplied at creation (a ULID/UUID from the application), not a serial:
    -- tenant ids appear in api keys, on-chain balance keys and billing records, so they must be
    -- stable, unguessable and independent of insertion order.
    id          TEXT PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9._:-]{1,64}$'),
    name        TEXT NOT NULL,

    -- suspended: the tenant exists, keeps its data and its balance, and is refused new
    -- sponsorship. This is what an unpaid subscription reaches — never deletion, because deleting
    -- a tenant would take the audit trail and the spend history with it.
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX tenants_status_idx ON tenants (status) WHERE status = 'active';

-- ------------------------------------------------------------------------------------------------
-- tenant_members
-- ------------------------------------------------------------------------------------------------

-- A join table rather than a tenant_id on the user, because one person legitimately belongs to
-- several tenants: an agency running three clients' dApps, a contractor with access to one
-- customer, a founder who also has a personal sandbox. Modelling that later would mean migrating
-- every session and every key; modelling it now costs one table.
CREATE TABLE tenant_members (
    tenant_id   TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    -- The identity provider's subject for this person — a Privy DID today. Deliberately opaque
    -- TEXT: this table should not need migrating if the provider changes, and it never holds a
    -- credential, only an identifier the provider will vouch for.
    subject     TEXT NOT NULL,

    -- Role WITHIN the tenant, distinct from the api-key roles in `roles`: those authorise machine
    -- calls, these authorise a human in a dashboard.
    role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, subject)
);

-- "Which tenants can this person see?" — the query every authenticated page runs first.
CREATE INDEX tenant_members_subject_idx ON tenant_members (subject);

-- ------------------------------------------------------------------------------------------------
-- The default tenant, and the backfill
-- ------------------------------------------------------------------------------------------------

-- Existing deployments have rows that belong to the operator running them. They all become one
-- tenant, so an upgrade changes nothing an operator can observe: the same keys authorise the same
-- policies, and the single-tenant deployment stays single-tenant.
INSERT INTO tenants (id, name) VALUES ('default', 'Default tenant');

-- ------------------------------------------------------------------------------------------------
-- policies: unique per tenant, not globally
-- ------------------------------------------------------------------------------------------------

ALTER TABLE policies ADD COLUMN tenant_id TEXT REFERENCES tenants (id) ON DELETE RESTRICT;
UPDATE policies SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE policies ALTER COLUMN tenant_id SET NOT NULL;

-- The FK from api_keys names the old primary key, so it has to go before the key can be replaced.
-- It is recreated below as a composite that also carries the tenant.
ALTER TABLE api_keys DROP CONSTRAINT api_keys_policy_fk;

-- policy_rules references policies(id) too.
ALTER TABLE policy_rules DROP CONSTRAINT policy_rules_policy_id_fkey;

ALTER TABLE policies DROP CONSTRAINT policies_pkey;
ALTER TABLE policies ADD PRIMARY KEY (tenant_id, id);

-- ------------------------------------------------------------------------------------------------
-- policy_rules follows its policy's tenant
-- ------------------------------------------------------------------------------------------------

ALTER TABLE policy_rules ADD COLUMN tenant_id TEXT;
UPDATE policy_rules SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE policy_rules ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE policy_rules
    ADD CONSTRAINT policy_rules_policy_fk
    FOREIGN KEY (tenant_id, policy_id) REFERENCES policies (tenant_id, id) ON DELETE CASCADE;

-- The old (policy_id, ordinal) uniqueness would now collide across tenants.
ALTER TABLE policy_rules DROP CONSTRAINT policy_rules_policy_id_ordinal_key;
ALTER TABLE policy_rules ADD CONSTRAINT policy_rules_order_unique UNIQUE (tenant_id, policy_id, ordinal);

DROP INDEX policy_rules_policy_idx;
CREATE INDEX policy_rules_policy_idx ON policy_rules (tenant_id, policy_id, ordinal);

-- ------------------------------------------------------------------------------------------------
-- api_keys belong to a tenant, and may only pin that tenant's policies
-- ------------------------------------------------------------------------------------------------

ALTER TABLE api_keys ADD COLUMN tenant_id TEXT REFERENCES tenants (id) ON DELETE RESTRICT;
UPDATE api_keys SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE api_keys ALTER COLUMN tenant_id SET NOT NULL;

-- The composite FK is the load-bearing part of this migration. It makes "key from tenant A pinned
-- to a policy from tenant B" unrepresentable in the database, rather than something the admin
-- service has to remember to check on every write.
--
-- ON DELETE RESTRICT for the same reason as before: silently unpinning a key turns a policy delete
-- into a privilege escalation, because an unpinned key may name any policy in its request.
ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_policy_fk
    FOREIGN KEY (tenant_id, policy_id) REFERENCES policies (tenant_id, id) ON DELETE RESTRICT;

-- Every admin listing is scoped to one tenant, so that is the leading column.
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

-- ------------------------------------------------------------------------------------------------
-- sponsorships carry their tenant directly
-- ------------------------------------------------------------------------------------------------

-- Denormalised from api_keys deliberately. Usage metering and billing group by tenant over a date
-- range, and a join to api_keys on every one of those queries buys nothing: a sponsorship's tenant
-- is fixed at write time and cannot drift, because the key it came from cannot change tenant.
ALTER TABLE sponsorships ADD COLUMN tenant_id TEXT REFERENCES tenants (id) ON DELETE RESTRICT;
UPDATE sponsorships SET tenant_id = 'default' WHERE tenant_id IS NULL;
ALTER TABLE sponsorships ALTER COLUMN tenant_id SET NOT NULL;

-- The billing query: what did this tenant commit, over this period.
CREATE INDEX sponsorships_tenant_created_idx ON sponsorships (tenant_id, created_at DESC);

-- ------------------------------------------------------------------------------------------------
-- audit_logs
-- ------------------------------------------------------------------------------------------------

-- NULL means a platform-level action with no tenant — an operator changing global configuration,
-- or the system acting on its own behalf. Tenant-scoped reads filter on the id and therefore never
-- see those rows, which is the intended behaviour: a customer should not see the platform's
-- internal administration in their own audit trail.
ALTER TABLE audit_logs ADD COLUMN tenant_id TEXT REFERENCES tenants (id) ON DELETE RESTRICT;
UPDATE audit_logs SET tenant_id = 'default' WHERE tenant_id IS NULL;

CREATE INDEX audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at DESC);
