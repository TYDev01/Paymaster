-- Subscriptions: what a tenant pays for platform access, separately from the gas they fund.
--
-- The pricing decision this implements: the subscription buys platform access and a quota tier,
-- while gas comes out of the tenant's own on-chain balance (see TenantPaymaster). The platform
-- therefore never fronts gas and carries no credit risk on it.
--
-- PREPAID PERIODS, NOT A RECURRING PULL. Billing is crypto-only, and crypto has no equivalent of a
-- card mandate: there is nothing to charge when a period ends. So a tenant BUYS a period and it
-- expires. Everything here follows from that — `paid_through` is an instant, not a renewal date,
-- and lapsing is the normal end of a period rather than a payment failure.
--
-- ------------------------------------------------------------------------------------------------
-- A CORRECTION to 0004, which cannot be edited once applied.
--
-- That migration describes `tenants.status = 'suspended'` as "what an unpaid subscription reaches".
-- Building it that way would have been a serious mistake, and this migration deliberately does not.
-- `TenantSessionService.issue` refuses a session for a suspended tenant — so suspending a tenant for
-- non-payment would lock them out of the very dashboard where they would go to pay, leaving support
-- tickets as the only route back. A billing state that can only be escaped by contacting support is
-- a billing state that loses customers who wanted to pay.
--
-- So the two are kept distinct:
--
--   * `tenants.status = 'suspended'` is an OPERATOR action — abuse, fraud, a legal hold. It stops
--     everything, including sign-in, and that is the intent.
--   * a LAPSED subscription stops sponsorship and nothing else. The customer can still sign in,
--     see what they owe, read their balance and their keys, and pay. It is derived from
--     `paid_through` and the clock rather than stored, so it cannot drift out of step with what
--     was actually bought.
-- ------------------------------------------------------------------------------------------------

CREATE TABLE tenant_subscriptions (
    tenant_id     TEXT PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,

    -- Free-text rather than an enum: plans are a commercial artefact and change more often than
    -- schemas should. What a plan MEANS (quota tier, chain access) belongs in configuration.
    plan          TEXT NOT NULL,

    -- Paid THROUGH this instant. The subscription is active while now() <= paid_through.
    paid_through  TIMESTAMPTZ NOT NULL,

    -- Sponsorship continues for this long after `paid_through`, so a customer who is a day late
    -- does not have their production traffic stop. Zero is permitted and means no grace.
    --
    -- Default is three days: long enough to survive a weekend, which is when a period ending
    -- unnoticed is most likely and least fixable.
    grace_seconds INTEGER NOT NULL DEFAULT 259200 CHECK (grace_seconds >= 0),

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sweep that finds tenants about to lapse — the useful direction, since nobody needs a list of
-- subscriptions that are comfortably paid.
CREATE INDEX tenant_subscriptions_paid_through_idx ON tenant_subscriptions (paid_through);

-- ------------------------------------------------------------------------------------------------
-- subscription_payments
-- ------------------------------------------------------------------------------------------------
--
-- Every extension of `paid_through`, with what bought it. Without this, `paid_through` is a number
-- someone can move with no record of why — which is exactly the property a billing system must not
-- have. The subscription row is the current state; this is how it got there.
CREATE TABLE subscription_payments (
    id            BIGSERIAL PRIMARY KEY,
    tenant_id     TEXT NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    -- What was received. Nullable together: a period granted rather than sold (a trial, a credit,
    -- a goodwill extension) has no payment behind it, and recording that honestly is better than
    -- inventing a zero-value transfer.
    amount_wei    NUMERIC(78, 0) CHECK (amount_wei IS NULL OR amount_wei >= 0),
    chain_id      INTEGER,
    tx_hash       TEXT,

    -- What it bought. Both stored, so the history reconstructs without replaying arithmetic.
    extended_from TIMESTAMPTZ NOT NULL,
    extended_to   TIMESTAMPTZ NOT NULL CHECK (extended_to > extended_from),

    -- Who recorded it, and why. `note` carries the reason for a grant.
    recorded_by   TEXT NOT NULL,
    note          TEXT,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX subscription_payments_tenant_idx ON subscription_payments (tenant_id, recorded_at DESC);

-- One on-chain transfer buys one period, ever.
--
-- A retried admin call, a double-click, or a reconciler that re-reads the same block would
-- otherwise extend the subscription twice for a single payment. Enforced in the database rather
-- than by the caller remembering, because the caller that forgets is the one under load.
--
-- Partial, so the many grants with no transaction behind them do not collide with each other.
CREATE UNIQUE INDEX subscription_payments_tx_idx
    ON subscription_payments (chain_id, tx_hash)
    WHERE tx_hash IS NOT NULL;

-- A payment either identifies a transaction fully or not at all: a chain id with no hash cannot be
-- checked against the chain, and a hash with no chain id is ambiguous across chains.
ALTER TABLE subscription_payments
    ADD CONSTRAINT subscription_payments_tx_complete
    CHECK ((chain_id IS NULL) = (tx_hash IS NULL));
