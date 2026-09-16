import type {Hex} from "viem";

import type {TenantLedgerEvent} from "../chain/chainAdapter.js";
import type {TenantLedgerStore} from "../reconciliation/tenantLedgerReconciler.js";
import type {DatabasePool} from "./pool.js";

/**
 * The replayed tenant ledger in PostgreSQL. See migration 0006.
 *
 * Not `Scope`-parameterised: this is platform bookkeeping keyed by on-chain tenant key, read only by
 * the reconciler, and never served to a tenant request.
 */
export class PostgresTenantLedgerStore implements TenantLedgerStore {
  constructor(private readonly pool: DatabasePool) {}

  async getCheckpoint(chainId: number): Promise<bigint | undefined> {
    const {rows} = await this.pool.query<{last_block: string}>(
      "SELECT last_block FROM tenant_ledger_checkpoints WHERE chain_id = $1",
      [chainId],
    );
    return rows[0] === undefined ? undefined : BigInt(rows[0].last_block);
  }

  async balances(chainId: number): Promise<ReadonlyMap<Hex, bigint>> {
    const {rows} = await this.pool.query<{tenant_key: string; balance_wei: string}>(
      "SELECT tenant_key, balance_wei::text AS balance_wei FROM tenant_ledger_balances WHERE chain_id = $1",
      [chainId],
    );
    return new Map(rows.map((row) => [row.tenant_key as Hex, BigInt(row.balance_wei)]));
  }

  async commitWindow(
    chainId: number,
    toBlock: bigint,
    entries: readonly TenantLedgerEvent[],
    balances: ReadonlyMap<Hex, bigint>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      for (const entry of entries) {
        await client.query(
          `INSERT INTO tenant_ledger_entries
             (chain_id, tenant_key, kind, delta_wei, balance_after_wei, block_number, log_index, tx_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
          [
            chainId,
            entry.tenant.toLowerCase(),
            entry.kind,
            entry.deltaWei.toString(),
            entry.balanceAfterWei.toString(),
            entry.blockNumber.toString(),
            entry.logIndex,
            entry.transactionHash.toLowerCase(),
          ],
        );
      }

      for (const [tenantKey, balance] of balances) {
        await client.query(
          `INSERT INTO tenant_ledger_balances (chain_id, tenant_key, balance_wei, as_of_block, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (chain_id, tenant_key) DO UPDATE
              SET balance_wei = EXCLUDED.balance_wei, as_of_block = EXCLUDED.as_of_block, updated_at = now()
            WHERE tenant_ledger_balances.as_of_block <= EXCLUDED.as_of_block`,
          [chainId, tenantKey.toLowerCase(), balance.toString(), toBlock.toString()],
        );
      }

      // GREATEST: a slower replica finishing an older window must not rewind the checkpoint.
      await client.query(
        `INSERT INTO tenant_ledger_checkpoints (chain_id, last_block, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (chain_id) DO UPDATE
            SET last_block = GREATEST(tenant_ledger_checkpoints.last_block, EXCLUDED.last_block), updated_at = now()`,
        [chainId, toBlock.toString()],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
