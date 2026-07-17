import type {Address} from "viem";

import type {DatabasePool} from "./pool.js";

/** An attestation we issued. Written at issue time, before the client can possibly submit it. */
export interface SponsorshipRecord {
  readonly chainId: number;
  readonly sender: Address;
  readonly nonce: bigint;
  readonly paymaster: Address;
  readonly entryPoint: Address;
  readonly apiKeyId: string;
  readonly policyId: string;
  readonly signer: Address;
  readonly maxCostWei: bigint;
  readonly validAfter: number;
  readonly validUntil: number;
}

export interface StoredSponsorship extends SponsorshipRecord {
  readonly id: bigint;
  readonly createdAt: number;
}

export interface SponsorshipQuery {
  readonly apiKeyId?: string;
  readonly chainId?: number;
  readonly sender?: Address;
  readonly limit?: number;
}

/**
 * Records what the paymaster committed to pay for.
 *
 * This is NOT a record of spending. It is a record of PROMISES: most rows here never reach the
 * chain, because clients abandon operations, bundlers drop them, and windows expire. Reading this
 * table as if it were spend would overstate cost — sometimes by a lot. Actual spend comes from
 * UserOperationEvent, correlated back to these rows by (chain_id, sender, nonce).
 */
export class SponsorshipRepository {
  constructor(private readonly pool: DatabasePool) {}

  async record(sponsorship: SponsorshipRecord): Promise<bigint> {
    const {rows} = await this.pool.query<{id: string}>(
      `INSERT INTO sponsorships (
         chain_id, sender, nonce, paymaster, entry_point,
         api_key_id, policy_id, signer, max_cost_wei, valid_after, valid_until
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10), to_timestamp($11))
       RETURNING id`,
      [
        sponsorship.chainId,
        sponsorship.sender.toLowerCase(),
        // bigint -> string: node-postgres will not bind a JS bigint to NUMERIC, and going via
        // Number would lose precision above 2^53. A nonce is a uint256.
        sponsorship.nonce.toString(),
        sponsorship.paymaster.toLowerCase(),
        sponsorship.entryPoint.toLowerCase(),
        sponsorship.apiKeyId,
        sponsorship.policyId,
        sponsorship.signer.toLowerCase(),
        sponsorship.maxCostWei.toString(),
        sponsorship.validAfter,
        sponsorship.validUntil,
      ],
    );
    return BigInt(rows[0]!.id);
  }

  /** Attestations issued for one operation. Several are normal: clients re-estimate gas. */
  async findForOperation(chainId: number, sender: Address, nonce: bigint): Promise<readonly StoredSponsorship[]> {
    const {rows} = await this.pool.query<SponsorshipRow>(
      `${SELECT_COLUMNS}
         WHERE chain_id = $1 AND sender = $2 AND nonce = $3
         ORDER BY created_at DESC`,
      [chainId, sender.toLowerCase(), nonce.toString()],
    );
    return rows.map(toStored);
  }

  /**
   * Lists recent attestations.
   *
   * Filters are composed as parameterised fragments, never interpolated. `limit` is bounded
   * because an admin endpoint without a ceiling is a way to ask the database to read the whole
   * table, which is a denial of service wearing a report's clothes.
   */
  async list(query: SponsorshipQuery = {}): Promise<readonly StoredSponsorship[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.apiKeyId !== undefined) {
      params.push(query.apiKeyId);
      conditions.push(`api_key_id = $${params.length}`);
    }
    if (query.chainId !== undefined) {
      params.push(query.chainId);
      conditions.push(`chain_id = $${params.length}`);
    }
    if (query.sender !== undefined) {
      params.push(query.sender.toLowerCase());
      conditions.push(`sender = $${params.length}`);
    }

    params.push(Math.min(query.limit ?? 100, 1_000));
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const {rows} = await this.pool.query<SponsorshipRow>(
      `${SELECT_COLUMNS} ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toStored);
  }

  /**
   * Sum of what we PROMISED in a window, per chain.
   *
   * Deliberately named to prevent the obvious misreading: this is committed worst-case, not spend.
   * Useful as an upper bound and for spotting a runaway policy; useless as a cost report.
   */
  async sumCommittedWei(since: number, chainId?: number): Promise<bigint> {
    const params: unknown[] = [since];
    let filter = "";
    if (chainId !== undefined) {
      params.push(chainId);
      filter = ` AND chain_id = $${params.length}`;
    }

    const {rows} = await this.pool.query<{total: string | null}>(
      `SELECT COALESCE(SUM(max_cost_wei), 0)::text AS total
         FROM sponsorships
        WHERE created_at >= to_timestamp($1)${filter}`,
      params,
    );
    return BigInt(rows[0]?.total ?? "0");
  }
}

const SELECT_COLUMNS = `
  SELECT id, chain_id, sender, nonce::text AS nonce, paymaster, entry_point,
         api_key_id, policy_id, signer, max_cost_wei::text AS max_cost_wei,
         valid_after, valid_until, created_at
    FROM sponsorships`;

interface SponsorshipRow {
  id: string;
  chain_id: string;
  sender: string;
  nonce: string;
  paymaster: string;
  entry_point: string;
  api_key_id: string;
  policy_id: string;
  signer: string;
  max_cost_wei: string;
  valid_after: Date;
  valid_until: Date;
  created_at: Date;
}

function toStored(row: SponsorshipRow): StoredSponsorship {
  return {
    id: BigInt(row.id),
    chainId: Number(row.chain_id),
    sender: row.sender as Address,
    nonce: BigInt(row.nonce),
    paymaster: row.paymaster as Address,
    entryPoint: row.entry_point as Address,
    apiKeyId: row.api_key_id,
    policyId: row.policy_id,
    signer: row.signer as Address,
    maxCostWei: BigInt(row.max_cost_wei),
    validAfter: Math.floor(row.valid_after.getTime() / 1000),
    validUntil: Math.floor(row.valid_until.getTime() / 1000),
    createdAt: Math.floor(row.created_at.getTime() / 1000),
  };
}
