import type {Address} from "viem";

import type {DatabasePool} from "./pool.js";
import type {ClaimedReservation, SpendReconciliationStore} from "../reconciliation/spendReconciler.js";
import type {TenantId} from "./scope.js";

/**
 * Postgres-backed reconciliation state: the per-chain scan checkpoint and the atomic claim of an
 * unreconciled sponsorship.
 *
 * The claim is the load-bearing part. It marks a row reconciled and returns its reserved cost in one
 * statement, under `FOR UPDATE SKIP LOCKED`, so two replicas scanning overlapping windows can never
 * both refund the same reservation — one claims the row, the other's subquery skips the locked row
 * and finds the next unreconciled attestation (or none).
 */
export class PostgresSpendReconciliationStore implements SpendReconciliationStore {
  constructor(private readonly pool: DatabasePool) {}

  async getCheckpoint(chainId: number): Promise<bigint | undefined> {
    const {rows} = await this.pool.query<{last_block: string}>(
      "SELECT last_block FROM reconciliation_checkpoints WHERE chain_id = $1",
      [chainId],
    );
    return rows.length === 0 ? undefined : BigInt(rows[0]!.last_block);
  }

  async saveCheckpoint(chainId: number, block: bigint): Promise<void> {
    // GREATEST keeps the checkpoint monotonic: a slower replica writing a lower block must not
    // rewind progress and cause a re-scan.
    await this.pool.query(
      `INSERT INTO reconciliation_checkpoints (chain_id, last_block, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (chain_id)
       DO UPDATE SET last_block = GREATEST(reconciliation_checkpoints.last_block, EXCLUDED.last_block),
                     updated_at = now()`,
      [chainId, block.toString()],
    );
  }

  async claim(params: {
    chainId: number;
    sender: Address;
    nonce: bigint;
    actualGasCostWei: bigint;
    success: boolean;
  }): Promise<ClaimedReservation | undefined> {
    const {rows} = await this.pool.query<ClaimRow>(
      `UPDATE sponsorships AS s
          SET reconciled_at = now(),
              actual_gas_cost_wei = $4,
              on_chain_success = $5
        WHERE s.id = (
          SELECT id FROM sponsorships
           WHERE chain_id = $1 AND sender = $2 AND nonce = $3 AND reconciled_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
        )
      RETURNING s.id,
                s.tenant_id,
                s.policy_id,
                s.api_key_id,
                s.max_cost_wei::text AS max_cost_wei,
                EXTRACT(EPOCH FROM s.created_at)::bigint AS reserved_at`,
      [
        params.chainId,
        params.sender.toLowerCase(),
        params.nonce.toString(),
        params.actualGasCostWei.toString(),
        params.success,
      ],
    );

    if (rows.length === 0) return undefined;
    const row = rows[0]!;
    return {
      sponsorshipId: BigInt(row.id),
      tenantId: row.tenant_id as TenantId,
      policyId: row.policy_id,
      apiKeyId: row.api_key_id,
      reservedMaxCostWei: BigInt(row.max_cost_wei),
      reservedAt: Number(row.reserved_at),
    };
  }
}

interface ClaimRow {
  id: string;
  tenant_id: string;
  policy_id: string;
  api_key_id: string;
  max_cost_wei: string;
  reserved_at: string;
}
