-- Billing notices, and a replayed copy of every tenant balance movement.
--
-- Two unrelated additions in one migration because they ship together; neither touches an existing
-- table, so both are safe on a live database.

-- ------------------------------------------------------------------------------------------------
-- subscription_notices
-- ------------------------------------------------------------------------------------------------
--
-- One row per notice sent. The primary key is the deduplication: a notice is for a specific
-- (tenant, paid_through) — the period that is ending — so paying extends paid_through and the NEXT
-- period's notices are new rows, while a replica restarting mid-sweep cannot send the same one twice.
--
-- Written BEFORE the notice is delivered (claim, then send). A delivery failure therefore drops that
-- one notice rather than retrying it into a customer's inbox every tick; the dashboard banner still
-- shows the same state, so a missed webhook costs a reminder, not the information.
CREATE TABLE subscription_notices (
    tenant_id     TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    paid_through  TIMESTAMPTZ NOT NULL,
    -- renewal-due: the period ends within the notice window.
    -- grace:       the period has ended and the grace window is running; sponsorship stops at its end.
    kind          TEXT NOT NULL CHECK (kind IN ('renewal-due', 'grace')),
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, paid_through, kind)
);

-- ------------------------------------------------------------------------------------------------
-- The tenant ledger
-- ------------------------------------------------------------------------------------------------
--
-- A mirror of TenantPaymaster's per-tenant balances, rebuilt from its events, so the chain's numbers
-- can be checked against their own history. The chain stays the source of truth: these tables exist
-- to notice when it and its history disagree (an accounting bug) or when the contract owes more
-- than it holds (insolvency), and to alert before a customer does.
--
-- Keyed by the on-chain tenant KEY, not the tenant id: the key is what the events carry, and a key
-- whose tenant was deleted from the database still has money on chain that must reconcile.

CREATE TABLE tenant_ledger_checkpoints (
    chain_id    INTEGER PRIMARY KEY,
    last_block  BIGINT NOT NULL CHECK (last_block >= 0),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_ledger_balances (
    chain_id     INTEGER NOT NULL,
    tenant_key   TEXT NOT NULL CHECK (tenant_key ~ '^0x[0-9a-f]{64}$'),
    balance_wei  NUMERIC(78, 0) NOT NULL CHECK (balance_wei >= 0),
    -- The block this balance is correct AT, so a comparison reads the chain at the same point.
    as_of_block  BIGINT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chain_id, tenant_key)
);

-- Every movement, once. The unique key makes re-scanning a window after a crash a no-op rather than
-- a double count.
CREATE TABLE tenant_ledger_entries (
    id                 BIGSERIAL PRIMARY KEY,
    chain_id           INTEGER NOT NULL,
    tenant_key         TEXT NOT NULL CHECK (tenant_key ~ '^0x[0-9a-f]{64}$'),
    kind               TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal', 'charge')),
    -- Signed: positive for a deposit, negative for a withdrawal or a charge.
    delta_wei          NUMERIC(78, 0) NOT NULL,
    -- As the contract reported it in the event.
    balance_after_wei  NUMERIC(78, 0) NOT NULL,
    block_number       BIGINT NOT NULL,
    log_index          INTEGER NOT NULL,
    tx_hash            TEXT NOT NULL,
    recorded_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (chain_id, tx_hash, log_index)
);

CREATE INDEX tenant_ledger_entries_tenant_idx ON tenant_ledger_entries (chain_id, tenant_key, block_number DESC);
