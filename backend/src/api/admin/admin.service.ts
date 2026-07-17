import {randomUUID} from "node:crypto";

import type {Address} from "viem";

import {generateApiKey} from "../../auth/apiKey.js";
import type {ApiKeyRecord, ApiKeyStore} from "../../auth/apiKeyStore.js";
import type {Role} from "../../auth/permissions.js";
import type {AuditLogRepository} from "../../db/auditLogRepository.js";
import type {PolicyDefinition, PostgresPolicyRepository, StoredPolicy} from "../../db/postgresPolicyRepository.js";
import type {SponsorshipRepository, StoredSponsorship} from "../../db/sponsorshipRepository.js";
import type {PolicySource} from "../../policy/policySource.js";
import type {ApiKeyView, CreateKeyRequest, CreatedApiKeyView, UpsertPolicyRequest} from "./admin.dto.js";

export class AdminUnavailableError extends Error {
  constructor() {
    super("admin operations require a database; DATABASE_URL is not configured");
    this.name = "AdminUnavailableError";
  }
}

export class PolicyInUseError extends Error {
  constructor(id: string) {
    super(`policy ${id} is still referenced by one or more API keys`);
    this.name = "PolicyInUseError";
  }
}

export interface AdminDeps {
  readonly policies: PostgresPolicyRepository | undefined;
  readonly policySource: PolicySource;
  readonly apiKeys: ApiKeyStore;
  readonly sponsorships: SponsorshipRepository | undefined;
  readonly audit: AuditLogRepository | undefined;
}

export interface ActorContext {
  readonly actor: string;
  readonly clientIp: string | undefined;
}

/**
 * Administrative operations.
 *
 * Every mutation writes an audit entry, and writes it AFTER the change succeeds — an audit log
 * recording things that did not happen is as misleading as one missing things that did. The write
 * is awaited: if we cannot record who changed the policy that spends the money, we do not report
 * the change as done.
 */
export class AdminService {
  constructor(private readonly deps: AdminDeps) {}

  // ------------------------------------------------------------------------------------------
  // policies
  // ------------------------------------------------------------------------------------------

  async listPolicies(): Promise<readonly StoredPolicy[]> {
    return this.#policies().list();
  }

  async getPolicy(id: string): Promise<StoredPolicy> {
    return this.#policies().get(id);
  }

  /**
   * Creates or replaces a policy, then reloads.
   *
   * Reloading immediately is the point: an operator who blocks an address expects it blocked now,
   * not at the next poll. The reload is awaited so the response only claims success once the new
   * policy is actually serving.
   */
  async upsertPolicy(request: UpsertPolicyRequest, context: ActorContext): Promise<StoredPolicy> {
    const definition: PolicyDefinition = {
      id: request.id,
      name: request.name,
      description: request.description,
      enabled: request.enabled,
      rules: request.rules.map((r) => ({ruleType: r.ruleType, config: r.config})),
    };

    // Throws InvalidRuleConfigError before writing anything if a rule cannot be built.
    await this.#policies().upsert(definition);
    await this.deps.policySource.reload();

    await this.#audit(context, "policy.upsert", `policy:${request.id}`, {
      enabled: request.enabled,
      ruleCount: request.rules.length,
      ruleTypes: request.rules.map((r) => r.ruleType),
    });

    return this.#policies().get(request.id);
  }

  async deletePolicy(id: string, context: ActorContext): Promise<boolean> {
    let deleted: boolean;
    try {
      deleted = await this.#policies().delete(id);
    } catch (error) {
      // The FK from api_keys.policy_id is ON DELETE RESTRICT: a policy still pinned by a key must
      // not vanish, because those keys would fall back to naming any policy they like.
      if (isForeignKeyViolation(error)) throw new PolicyInUseError(id);
      throw error;
    }

    if (deleted) {
      await this.deps.policySource.reload();
      await this.#audit(context, "policy.delete", `policy:${id}`, {});
    }
    return deleted;
  }

  /** td.md's hot reload, on demand. Also runs on a timer; this is the "now" button. */
  async reloadPolicies(context: ActorContext): Promise<{count: number; generation: number}> {
    const result = await this.deps.policySource.reload();
    await this.#audit(context, "policy.reload", undefined, {count: result.count, generation: result.generation});
    return {count: result.count, generation: result.generation};
  }

  // ------------------------------------------------------------------------------------------
  // api keys
  // ------------------------------------------------------------------------------------------

  async listKeys(): Promise<readonly ApiKeyView[]> {
    return (await this.deps.apiKeys.list()).map(toView);
  }

  /**
   * Mints a key. The secret is returned here and nowhere else, ever.
   *
   * The audit entry records that a key was created, by whom, with which roles — and not the
   * secret. AuditLogRepository would redact it anyway; not passing it is the belt to that braces.
   */
  async createKey(request: CreateKeyRequest, context: ActorContext): Promise<CreatedApiKeyView> {
    const generated = generateApiKey(request.environment);
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name: request.name,
      hash: generated.hash,
      displayPrefix: generated.displayPrefix,
      roles: request.roles as readonly Role[],
      policyId: request.policyId,
      enabled: true,
      createdAt: Math.floor(Date.now() / 1000),
      expiresAt: request.expiresAt,
      lastUsedAt: undefined,
    };

    await this.deps.apiKeys.create(record);
    await this.#audit(context, "key.create", `api_key:${record.id}`, {
      name: record.name,
      roles: record.roles,
      policyId: record.policyId ?? null,
      displayPrefix: record.displayPrefix,
    });

    return {...toView(record), secret: generated.secret};
  }

  /** td.md's "Rotate keys": revocation is a flag, so history survives. */
  async revokeKey(id: string, context: ActorContext): Promise<boolean> {
    const revoked = await this.deps.apiKeys.revoke(id, Math.floor(Date.now() / 1000));
    if (revoked) {
      await this.#audit(context, "key.revoke", `api_key:${id}`, {});
    }
    return revoked;
  }

  // ------------------------------------------------------------------------------------------
  // reporting
  // ------------------------------------------------------------------------------------------

  /**
   * Attestations issued.
   *
   * Reading these as spend overstates cost: they are commitments, and most never land. The route
   * documents that; there is no way to express it in the data itself short of a reconciliation
   * loop against UserOperationEvent, which does not exist yet.
   */
  async listSponsorships(query: {
    apiKeyId?: string;
    chainId?: number;
    sender?: string;
    limit?: number;
  }): Promise<readonly StoredSponsorship[]> {
    const repo = this.deps.sponsorships;
    if (repo === undefined) throw new AdminUnavailableError();
    return repo.list({
      ...(query.apiKeyId === undefined ? {} : {apiKeyId: query.apiKeyId}),
      ...(query.chainId === undefined ? {} : {chainId: query.chainId}),
      ...(query.sender === undefined ? {} : {sender: query.sender as Address}),
      ...(query.limit === undefined ? {} : {limit: query.limit}),
    });
  }

  async listAudit(query: {actor?: string; action?: string; since?: number; limit?: number}) {
    const repo = this.deps.audit;
    if (repo === undefined) throw new AdminUnavailableError();
    return repo.list(query);
  }

  // ------------------------------------------------------------------------------------------

  #policies(): PostgresPolicyRepository {
    if (this.deps.policies === undefined) throw new AdminUnavailableError();
    return this.deps.policies;
  }

  async #audit(
    context: ActorContext,
    action: string,
    subject: string | undefined,
    detail: Record<string, unknown>,
  ): Promise<void> {
    // Without a database there is no audit log — and no policy repository either, so every
    // mutating path has already thrown AdminUnavailableError before reaching here.
    await this.deps.audit?.record({
      actor: context.actor,
      action,
      subject,
      detail,
      clientIp: context.clientIp,
    });
  }
}

function toView(record: ApiKeyRecord): ApiKeyView {
  return {
    id: record.id,
    name: record.name,
    displayPrefix: record.displayPrefix,
    roles: record.roles,
    policyId: record.policyId,
    enabled: record.enabled,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
  };
}

/** PostgreSQL error 23503 is foreign_key_violation. */
function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as {code?: string}).code === "23503";
}
