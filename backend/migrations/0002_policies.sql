-- Policies, stored rather than compiled in.
--
-- Until now `PolicySource.reload()` re-read the same in-code array, which made hot reload
-- structurally present but functionally a no-op. These tables are what make it mean something.

CREATE TABLE policies (
    id          TEXT PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9._:-]{1,128}$'),
    name        TEXT NOT NULL,
    description TEXT,

    -- A disabled policy is not loaded at all, so a request naming it fails as unknown. Disabling
    -- is therefore a way to take a customer offline without deleting their configuration.
    enabled     BOOLEAN NOT NULL DEFAULT true,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX policies_enabled_idx ON policies (enabled) WHERE enabled;

-- One row per rule. Rules are typed, and their configuration is JSONB validated in application
-- code against a schema per rule type — see policyFactory.ts.
--
-- Why JSONB and not a column per rule kind: the rule set is the extension point td.md calls
-- "custom policy plugins". A schema that must be migrated every time someone adds a rule is a
-- schema that discourages adding rules, which is the opposite of what an extension point is for.
-- The cost is that the database cannot validate the config; the factory does, and refuses to load
-- a policy it cannot fully build.
CREATE TABLE policy_rules (
    id          BIGSERIAL PRIMARY KEY,
    policy_id   TEXT NOT NULL REFERENCES policies (id) ON DELETE CASCADE,

    -- Declaration order. The engine re-orders by cost, but order within a cost tier is stable and
    -- observable, so it must be reproducible across reloads rather than left to row order.
    ordinal     INT NOT NULL CHECK (ordinal >= 0),

    rule_type   TEXT NOT NULL,
    config      JSONB NOT NULL DEFAULT '{}'::jsonb,

    UNIQUE (policy_id, ordinal)
);

-- The reload query: every rule for every enabled policy, in order.
CREATE INDEX policy_rules_policy_idx ON policy_rules (policy_id, ordinal);

-- ---------------------------------------------------------------------------------------------
-- api_keys.policy_id
-- ---------------------------------------------------------------------------------------------

-- Now that policies exist as rows, a key pinned to a policy can be checked against them.
--
-- ON DELETE RESTRICT, not CASCADE: deleting a policy that keys depend on must fail loudly. Under
-- CASCADE it would silently unpin those keys, and an unpinned key falls back to the request body's
-- policyId — turning a delete into a privilege escalation for every key that referenced it.
ALTER TABLE api_keys
    ADD CONSTRAINT api_keys_policy_fk
    FOREIGN KEY (policy_id) REFERENCES policies (id) ON DELETE RESTRICT;
