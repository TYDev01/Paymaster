-- Initial schema.
--
-- Conventions used throughout:
--
--   * Wei amounts are NUMERIC(78,0), never BIGINT. This is not fussiness: BIGINT tops out at
--     ~9.22e18, and 1 ETH is 1e18 wei, so a BIGINT wei column overflows at about 9.22 ETH. A
--     paymaster with a 10 ETH deposit would fail to record its own spending. 78 digits holds any
--     uint256.
--
--   * Addresses and hashes are TEXT with a CHECK constraint rather than BYTEA. They arrive and
--     leave as 0x hex strings; storing bytes would mean encoding on every read and write, and the
--     CHECK catches malformed values at the boundary where they are cheapest to diagnose.
--     Addresses are stored lowercased so equality never depends on checksum casing.
--
--   * Timestamps are TIMESTAMPTZ. A paymaster spans chains and regions; a naive timestamp is a
--     bug waiting for a deployment in another zone.

-- Note: `schema_migrations` is NOT declared here. The table that records migrations cannot itself
-- be a migration, so the runner creates it before applying anything. See src/db/migrate.ts.

-- ---------------------------------------------------------------------------------------------
-- api_keys
-- ---------------------------------------------------------------------------------------------

CREATE TABLE api_keys (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,

    -- SHA-256 of the key. The key itself is never stored: a dump of this table yields no usable
    -- credential. Lookups are by this column, so it carries the UNIQUE index the request path hits.
    key_hash        TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),

    -- Non-secret fragment, for identifying a key in an admin list or a support conversation.
    display_prefix  TEXT NOT NULL,

    roles           TEXT[] NOT NULL CHECK (array_length(roles, 1) >= 1),

    -- The policy this key's sponsorships are evaluated against. NULL means the request may name
    -- one. FK is deliberately absent: policies are reloaded as a set and a key referencing a
    -- policy that has not loaded yet should fail at evaluation, not block the key's creation.
    policy_id       TEXT,

    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,

    CONSTRAINT api_keys_revoked_consistency CHECK ((revoked_at IS NULL) = enabled)
);

-- The request path does exactly one lookup, and it must be an index hit, never a scan.
CREATE UNIQUE INDEX api_keys_key_hash_idx ON api_keys (key_hash);
CREATE INDEX api_keys_enabled_idx ON api_keys (enabled) WHERE enabled;

-- ---------------------------------------------------------------------------------------------
-- sponsorships
-- ---------------------------------------------------------------------------------------------

-- Every attestation we issue. Written before the client can submit, so this is the record of what
-- we COMMITTED to pay, not what was ultimately spent — most rows here will never land on-chain,
-- because clients abandon operations, bundlers drop them, and windows expire.
--
-- Correlation to the chain is by (chain_id, sender, nonce), which is what UserOperationEvent
-- carries. It is deliberately not unique: a client re-estimating gas legitimately asks for several
-- attestations for the same nonce, and only one can win.
CREATE TABLE sponsorships (
    id              BIGSERIAL PRIMARY KEY,

    chain_id        BIGINT NOT NULL,
    sender          TEXT NOT NULL CHECK (sender ~ '^0x[0-9a-f]{40}$'),
    nonce           NUMERIC(78,0) NOT NULL CHECK (nonce >= 0),

    paymaster       TEXT NOT NULL CHECK (paymaster ~ '^0x[0-9a-f]{40}$'),
    entry_point     TEXT NOT NULL CHECK (entry_point ~ '^0x[0-9a-f]{40}$'),

    -- Which key and policy authorised this, and which signer attested. All three are needed to
    -- answer "why did we pay for this?" months later.
    api_key_id      TEXT NOT NULL REFERENCES api_keys (id) ON DELETE RESTRICT,
    policy_id       TEXT NOT NULL,
    signer          TEXT NOT NULL CHECK (signer ~ '^0x[0-9a-f]{40}$'),

    -- Worst case, in wei. See the NUMERIC note at the top of this file.
    max_cost_wei    NUMERIC(78,0) NOT NULL CHECK (max_cost_wei >= 0),

    valid_after     TIMESTAMPTZ NOT NULL,
    valid_until     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT sponsorships_window CHECK (valid_until > valid_after)
);

-- Correlating an on-chain UserOperationEvent back to the attestation that paid for it.
CREATE INDEX sponsorships_correlation_idx ON sponsorships (chain_id, sender, nonce);
-- "What has this customer been spending?" — the admin API's main query.
CREATE INDEX sponsorships_api_key_created_idx ON sponsorships (api_key_id, created_at DESC);
CREATE INDEX sponsorships_created_idx ON sponsorships (created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------------------------

-- Append-only record of administrative action. Never UPDATEd or DELETEd; an audit log you can
-- edit is not an audit log.
CREATE TABLE audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    -- Who acted: an api key id, an admin id, or 'system' for automated action.
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    -- What was acted upon, e.g. 'api_key:abc' or 'policy:default'.
    subject     TEXT,
    -- Structured detail. Must never contain a credential; see AuditLogRepository.
    detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
    client_ip   INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_created_idx ON audit_logs (actor, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action);
