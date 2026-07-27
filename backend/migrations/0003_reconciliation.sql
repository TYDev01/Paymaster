-- Spend-cap reconciliation.
--
-- Spend caps reserve worst-case `max_cost_wei` at sponsorship time; the reconciler reads settled
-- UserOperationEvents and trues the reserved counters up to actual on-chain cost. These columns
-- record the realised outcome per attestation, and the checkpoint table tracks how far each chain
-- has been scanned so the loop resumes rather than rescans from genesis.

ALTER TABLE sponsorships
    -- What the operation actually cost on-chain, from UserOperationEvent.actualGasCost. NULL until
    -- reconciled. NUMERIC(78,0) for the same reason max_cost_wei is: a uint256 does not fit BIGINT.
    ADD COLUMN actual_gas_cost_wei NUMERIC(78,0) CHECK (actual_gas_cost_wei IS NULL OR actual_gas_cost_wei >= 0),
    -- Whether the op succeeded on-chain. A reverted op still costs gas, so it is still reconciled.
    ADD COLUMN on_chain_success    BOOLEAN,
    -- Set once, when the reservation has been trued up. The claim is `WHERE reconciled_at IS NULL`,
    -- so this column is what makes reconciliation idempotent under retries and across replicas.
    ADD COLUMN reconciled_at       TIMESTAMPTZ;

-- The claim query: the latest unreconciled attestation for a settled op. Partial index so it stays
-- small — reconciled rows, the overwhelming majority over time, are not indexed here.
CREATE INDEX sponsorships_unreconciled_idx
    ON sponsorships (chain_id, sender, nonce, created_at DESC)
    WHERE reconciled_at IS NULL;

-- How far the reconciler has scanned each chain. One row per chain; last_block is monotonic.
CREATE TABLE reconciliation_checkpoints (
    chain_id   BIGINT PRIMARY KEY,
    last_block NUMERIC(78,0) NOT NULL CHECK (last_block >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
