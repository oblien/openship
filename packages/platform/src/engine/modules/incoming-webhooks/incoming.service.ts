/**
 * Incoming webhooks — generic, per-project inbound hooks that fire a pluggable
 * action (deploy / job) when their dynamic URL (`POST /api/webhooks/incoming/:id`)
 * is called. Generalizes the backup token-trigger pattern
 * (`backups/triggers/webhook.ts`) into a first-class primitive.
 *
 * Auth is per hook: opaque bearer token (default), HMAC-SHA256 signature, or
 * open (`none`). Token/HMAC secrets are stored ENCRYPTED at rest
 * (ENCRYPTED_COLUMNS) and only ever revealed to the owning project's editors.
 */

import crypto from "node:crypto";
import { repos, type IncomingWebhook, type WebhookDelivery } from "@repo/db";
import type {
  IncomingWebhookActionType,
  IncomingWebhookActionConfig,
  IncomingWebhookAuthMode,
} from "@repo/db";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { verifyHmacSha256 } from "@repo/platform/engine/modules/webhooks/webhook.service";
import { ConflictError, NotFoundError, type ExecutionAuthority } from "@repo/core";
import { resolveExecutionAuthority } from "../../lib/execution-authority";
import { authorization } from "../../lib/authorization";
import { freezeContext } from "../../../context";
import { assertJobRunnable } from "../jobs/job-access";
import { trackBackgroundWork } from "../../lib/background-work";
import { triggerDeployment } from "@repo/platform/engine/modules/deployments/build.service";
import { runJobNow } from "@repo/platform/engine/modules/jobs/job.service";
import { audit } from "@repo/platform/engine/lib/audit-emitter";
import { incomingWebhookUrl } from "@repo/platform/engine/lib/public-url";
import { env } from "@repo/platform/engine/config/index";
import { deployServiceIds } from "@repo/platform/engine/modules/incoming-webhooks/incoming-action";
import { assertExactServiceTargets } from "@repo/platform/engine/modules/deployments/exact-service-targets";

const ACTION_TYPES: IncomingWebhookActionType[] = ["deploy", "job"];
const AUTH_MODES: IncomingWebhookAuthMode[] = ["token", "hmac", "none"];

export function isValidActionType(v: unknown): v is IncomingWebhookActionType {
  return typeof v === "string" && (ACTION_TYPES as string[]).includes(v);
}
export function isValidAuthMode(v: unknown): v is IncomingWebhookAuthMode {
  return typeof v === "string" && (AUTH_MODES as string[]).includes(v);
}

/** Fail instead of silently turning stale/cross-project ids into a partial or
 * whole-project deployment. */
export async function assertDeployServiceTargets(
  projectId: string,
  config: IncomingWebhookActionConfig,
): Promise<string[] | undefined> {
  const requested = deployServiceIds(config);
  if (!requested) return undefined;
  const services = await repos.service.listByProject(projectId);
  assertExactServiceTargets(services, requested, "Webhook");
  return requested;
}

/** 192 bits of entropy — same generator the backup webhook token uses. */
function generateSecret(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Mint the encrypted credential column set for an auth mode. */
function mintCredentials(authMode: IncomingWebhookAuthMode): {
  tokenEncrypted: string | null;
  hmacSecretEncrypted: string | null;
} {
  if (authMode === "token")
    return { tokenEncrypted: encrypt(generateSecret()), hmacSecretEncrypted: null };
  if (authMode === "hmac")
    return { tokenEncrypted: null, hmacSecretEncrypted: encrypt(generateSecret()) };
  return { tokenEncrypted: null, hmacSecretEncrypted: null };
}

/** The owner-facing view of a hook: the delivery URL + revealed credential. */
export interface IncomingWebhookView {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  actionType: IncomingWebhookActionType;
  actionConfig: IncomingWebhookActionConfig;
  authMode: IncomingWebhookAuthMode;
  url: string;
  /** Revealed secret for the current auth mode (token/hmac); null when `none`. */
  secret: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  requiresReauthorization: boolean;
}

function tryDecrypt(sealed: string | null): string | null {
  if (!sealed) return null;
  try {
    return decrypt(sealed);
  } catch {
    return null; // key-rotated / corrupted — surface as "no secret" rather than throw
  }
}

/**
 * Map a row to the owner-facing view. `reveal` MUST be false unless the caller
 * has project:write — the plaintext token/HMAC is a trigger credential, so
 * read-only principals (incl. project:read PAT/MCP scopes) get it masked; it is
 * revealed only on create/rotate and to writers.
 */
export function toView(row: IncomingWebhook, reveal = false): IncomingWebhookView {
  const secret = !reveal
    ? null
    : row.authMode === "token"
      ? tryDecrypt(row.tokenEncrypted)
      : row.authMode === "hmac"
        ? tryDecrypt(row.hmacSecretEncrypted)
        : null;
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    enabled: row.enabled,
    actionType: row.actionType,
    actionConfig: row.actionConfig ?? {},
    authMode: row.authMode,
    url: incomingWebhookUrl(row.id),
    secret,
    lastFiredAt: row.lastFiredAt ? row.lastFiredAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    requiresReauthorization: !row.executionAuthority,
  };
}

// ─── CRUD (management, project-scoped) ───────────────────────────────────────

export interface CreateHookInput {
  projectId: string;
  organizationId: string;
  name: string;
  actionType: IncomingWebhookActionType;
  actionConfig: IncomingWebhookActionConfig;
  authMode: IncomingWebhookAuthMode;
  createdBy?: string | null;
  executionAuthority?: ExecutionAuthority;
}

export async function createHook(input: CreateHookInput): Promise<IncomingWebhookView> {
  const creds = mintCredentials(input.authMode);
  const row = await repos.incomingWebhook.create({
    projectId: input.projectId,
    organizationId: input.organizationId,
    name: input.name.trim() || "Webhook",
    enabled: true,
    actionType: input.actionType,
    actionConfig: input.actionConfig ?? {},
    authMode: input.authMode,
    tokenEncrypted: creds.tokenEncrypted,
    hmacSecretEncrypted: creds.hmacSecretEncrypted,
    createdBy: input.createdBy ?? null,
    executionAuthority: input.executionAuthority ?? null,
  });
  return toView(row, true); // reveal once at creation (caller has project:write)
}

/** Raw rows — the caller decides `reveal` PER hook (e.g. job hooks need job-run
 *  authz, not just project:write, before their credential is shown). */
export async function listHookRows(projectId: string): Promise<IncomingWebhook[]> {
  return repos.incomingWebhook.listByProject(projectId);
}

/** Guarded read — returns null when the hook isn't in this project. */
async function getScoped(projectId: string, id: string): Promise<IncomingWebhook | null> {
  const row = await repos.incomingWebhook.findById(id);
  if (!row || row.projectId !== projectId) return null;
  return row;
}

/** Public scoped read (for the controller's job-authz re-check on update). */
export async function getHookForProject(
  projectId: string,
  id: string,
): Promise<IncomingWebhook | null> {
  return getScoped(projectId, id);
}

export interface UpdateHookInput {
  name?: string;
  enabled?: boolean;
  actionType?: IncomingWebhookActionType;
  actionConfig?: IncomingWebhookActionConfig;
  authMode?: IncomingWebhookAuthMode;
  executionAuthority?: ExecutionAuthority;
}

export async function updateHook(
  projectId: string,
  id: string,
  patch: UpdateHookInput,
  reveal = false,
  expected?: IncomingWebhook,
): Promise<IncomingWebhookView | null> {
  const row = expected ?? await getScoped(projectId, id);
  if (!row) return null;
  if (row.projectId !== projectId || row.id !== id) throw new NotFoundError("Webhook", id);

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim() || row.name;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.actionType !== undefined) data.actionType = patch.actionType;
  if (patch.actionConfig !== undefined) data.actionConfig = patch.actionConfig;
  if (patch.executionAuthority !== undefined) data.executionAuthority = patch.executionAuthority;

  // Re-mint the credential whenever the auth mode OR the action type changes.
  // Re-minting on an action-TYPE change is a security invariant, not a nicety:
  // a job hook's token is a run-this-job capability, so flipping the hook to
  // `deploy` (or back) MUST rotate the secret. Otherwise a project:write-only
  // principal could downgrade a job hook to `deploy` (skipping the job-run
  // gate), read the unchanged job token, and re-fire the job once anyone
  // re-arms it. Rotating on type change severs that lineage: the old job token
  // dies, and any value revealed on a `deploy` result is a fresh deploy-only
  // credential the caller was entitled to anyway.
  const authChanged = patch.authMode !== undefined && patch.authMode !== row.authMode;
  const typeChanged = patch.actionType !== undefined && patch.actionType !== row.actionType;
  const authorityChanged = patch.executionAuthority !== undefined && JSON.stringify(patch.executionAuthority) !== JSON.stringify(row.executionAuthority);
  if (authChanged) data.authMode = patch.authMode;
  if (authChanged || typeChanged || authorityChanged) {
    Object.assign(data, mintCredentials(patch.authMode ?? row.authMode));
  }

  const updated = await repos.incomingWebhook.updateIfUnchanged(row, data);
  if (!updated) throw new ConflictError("This webhook changed. Reload it before retrying.");
  // `reveal` is the caller's decision (mask unless they may USE the credential —
  // a benign PATCH on a job hook must NOT leak its secret to a non-runner).
  return updated ? toView(updated, reveal) : null;
}

/** Regenerate the credential for the hook's current auth mode. */
export async function rotateCredential(
  projectId: string,
  id: string,
  executionAuthority?: ExecutionAuthority,
  expected?: IncomingWebhook,
): Promise<IncomingWebhookView | null> {
  const row = expected ?? await getScoped(projectId, id);
  if (!row) return null;
  if (row.projectId !== projectId || row.id !== id) throw new NotFoundError("Webhook", id);
  const updated = await repos.incomingWebhook.updateIfUnchanged(row, {
    ...mintCredentials(row.authMode), ...(executionAuthority ? { executionAuthority } : {}),
  });
  if (!updated) throw new ConflictError("This webhook changed. Reload it before retrying.");
  return updated ? toView(updated, true) : null;
}

export async function deleteHook(projectId: string, id: string): Promise<boolean> {
  const row = await getScoped(projectId, id);
  if (!row) return false;
  await repos.incomingWebhook.removeForProject(projectId, id);
  return true;
}

// ─── Trigger (public) ────────────────────────────────────────────────────────

export type TriggerResult =
  | { ok: true; action: IncomingWebhookActionType; ref?: string }
  | { error: "not_found" | "unauthorized" | "disabled" | "action_failed" };

/**
 * Authenticate an inbound call against the hook's own auth mode, then dispatch
 * its action. Every failure the caller could probe (missing hook, disabled,
 * bad credential) is reported the same so the route can answer an opaque 404.
 */
export async function triggerIncomingWebhook(opts: {
  id: string;
  bearer?: string | null;
  signature?: string | null;
  rawBody: Buffer;
  clientIp?: string;
  userAgent?: string;
}): Promise<TriggerResult> {
  const hook = await repos.incomingWebhook.findById(opts.id);
  if (!hook) return { error: "not_found" };
  if (!hook.enabled) {
    auditAttempt(hook, opts, "incoming_webhook.disabled");
    return { error: "disabled" };
  }

  // Jobs are a self-hosted control-plane feature (the Jobs API is localOnly and
  // hidden from the SaaS). A job hook must NEVER dispatch in CLOUD_MODE — else a
  // tenant could drive instance-global maintenance jobs on the shared control
  // plane. Refuse at dispatch even if a row exists (dump/restore/legacy); the
  // controller also blocks arming a job hook on the SaaS.
  if (hook.actionType === "job" && env.CLOUD_MODE) {
    // Opaque 404 (not 502) so a dump-imported job row on the SaaS is
    // indistinguishable from a missing hook — no existence oracle.
    return { error: "not_found" };
  }

  // Dispatch-time backstop for the none+job invariant: an unauthenticated job
  // trigger is command-execution RCE. The controller blocks this at arm time,
  // but a row could still arrive via a direct DB write or a dump/restore import
  // (incoming_webhook is in the transfer subgraph), so refuse it here too.
  if (hook.actionType === "job" && hook.authMode === "none") {
    auditAttempt(hook, opts, "incoming_webhook.auth_failed");
    return { error: "unauthorized" };
  }

  // ── Auth per mode ──
  if (hook.authMode === "token") {
    const stored = tryDecrypt(hook.tokenEncrypted);
    if (!stored || !opts.bearer || !constantTimeEqual(opts.bearer, stored)) {
      auditAttempt(hook, opts, "incoming_webhook.auth_failed");
      return { error: "unauthorized" };
    }
  } else if (hook.authMode === "hmac") {
    const secret = tryDecrypt(hook.hmacSecretEncrypted);
    if (!secret || !opts.signature || !verifyHmacSha256(opts.rawBody, secret, opts.signature)) {
      auditAttempt(hook, opts, "incoming_webhook.auth_failed");
      return { error: "unauthorized" };
    }
  } else if (hook.authMode !== "none") {
    // Only an explicit "none" is open. Any unexpected authMode value (a bad
    // migration / direct DB write) must fail CLOSED, never fall through to open.
    auditAttempt(hook, opts, "incoming_webhook.auth_failed");
    return { error: "unauthorized" };
  }
  // authMode === "none": open — no credential required.

  return dispatchIncomingWebhook(hook, opts).catch(() => {
    auditAttempt(hook, opts, "incoming_webhook.auth_failed");
    return { error: "unauthorized" };
  });
}

/** Shared by authenticated SDK invocation and the signature/token ingress adapter. */
export async function dispatchIncomingWebhook(
  hook: IncomingWebhook,
  opts: { clientIp?: string; userAgent?: string },
): Promise<TriggerResult> {
  const resolved = await resolveExecutionAuthority(hook.executionAuthority, `incoming-webhook:${hook.id}`);
  if (resolved.organizationId !== hook.organizationId) throw new NotFoundError("Webhook", hook.id);
  const ctx = await authorization.authorize(freezeContext({ ...resolved, source: "webhook" }), {
    resourceType: "project", resourceId: hook.projectId, action: "write",
  });
  const cfg = (hook.actionConfig ?? {}) as IncomingWebhookActionConfig;
  if (hook.actionType === "job") {
    if (env.CLOUD_MODE || hook.authMode === "none" || !cfg.jobKey) return { error: "unauthorized" };
    await assertJobRunnable(ctx, cfg.jobKey);
  }

  try {
    let ref: string | undefined;
    if (hook.actionType === "deploy") {
      const serviceIds = await assertDeployServiceTargets(hook.projectId, cfg);
      const result = await triggerDeployment(ctx, {
        projectId: hook.projectId,
        trigger: "webhook",
        serviceIds,
        strictServiceScope: serviceIds !== undefined,
        // Incoming deploy hooks promise a redeploy, not just a container
        // recreate from an already-cached mutable tag. Persist this intent on
        // the deployment snapshot so the worker force-pulls selected external
        // images while the deployment still retains webhook provenance.
        forcePullImages: true,
      });
      ref = result?.deployment?.id;
    } else if (hook.actionType === "job") {
      if (!cfg.jobKey) return { error: "action_failed" };
      const result = await runJobNow(cfg.jobKey);
      ref = result?.runId;
    } else {
      return { error: "action_failed" };
    }

    await repos.incomingWebhook.markFired(hook.id);
    auditAttempt(hook, opts, "incoming_webhook.fired", ref);
    recordIncomingDelivery(hook, opts, "dispatched", { actionRef: ref });
    return { ok: true, action: hook.actionType, ref };
  } catch (err) {
    console.warn(
      `[incoming-webhook] action ${hook.actionType} failed for hook ${hook.id}: ${(err as Error)?.message ?? err}`,
    );
    recordIncomingDelivery(hook, opts, "failed", { error: (err as Error)?.message ?? String(err) });
    return { error: "action_failed" };
  }
}

/** Best-effort webhook_delivery feed row for an incoming-hook dispatch. The audit
 *  log (auditAttempt) remains the security record; this is the observability feed. */
function recordIncomingDelivery(
  hook: IncomingWebhook,
  opts: { clientIp?: string; userAgent?: string },
  outcome: string,
  extra?: { actionRef?: string; error?: string },
): void {
  void trackBackgroundWork(repos.webhookDelivery.record({
      organizationId: hook.organizationId,
      projectId: hook.projectId,
      source: "incoming",
      hookId: hook.id,
      event: hook.actionType,
      authResult: "ok",
      outcome,
      actionRef: extra?.actionRef,
      error: extra?.error,
      clientIp: opts.clientIp,
      userAgent: opts.userAgent,
      summary: { name: hook.name },
    }))
    .catch(() => {});
}

// ─── Delivery feed (webhook_delivery — history/observability) ────────────────

export interface WebhookDeliveryView {
  id: string;
  source: string;
  event: string;
  outcome: string;
  hookId: string | null;
  projectId: string | null;
  actionRef: string | null;
  authResult: string | null;
  statusCode: number | null;
  error: string | null;
  summary: unknown;
  receivedAt: string;
  processedAt: string | null;
}

function toDeliveryView(r: WebhookDelivery): WebhookDeliveryView {
  return {
    id: r.id,
    source: r.source,
    event: r.event,
    outcome: r.outcome,
    hookId: r.hookId,
    projectId: r.projectId,
    actionRef: r.actionRef,
    authResult: r.authResult,
    statusCode: r.statusCode,
    error: r.error,
    summary: r.summary,
    receivedAt: r.receivedAt.toISOString(),
    processedAt: r.processedAt ? r.processedAt.toISOString() : null,
  };
}

export interface DeliveryPage {
  deliveries: WebhookDeliveryView[];
  nextCursor?: string;
}
type PageOpts = { cursor?: string; limit?: number };

/** All webhook deliveries for a project (github pushes + custom hooks), newest first. */
export async function listProjectDeliveries(
  projectId: string,
  opts?: PageOpts,
): Promise<DeliveryPage> {
  const page = await repos.webhookDelivery.listByProject(projectId, opts);
  return { deliveries: page.rows.map(toDeliveryView), nextCursor: page.nextCursor };
}

/** Deliveries for one incoming hook — scoped to its project (guarded by the caller's project:read). */
export async function listHookDeliveries(
  projectId: string,
  hookId: string,
  opts?: PageOpts,
): Promise<DeliveryPage> {
  const hook = await getHookForProject(projectId, hookId);
  if (!hook) return { deliveries: [] };
  const page = await repos.webhookDelivery.listByHook(hookId, opts);
  return { deliveries: page.rows.map(toDeliveryView), nextCursor: page.nextCursor };
}

/** Org-wide deliveries — includes project-less forwarded/ignored GitHub rows. */
export async function listOrgDeliveries(
  organizationId: string,
  opts?: PageOpts & { projectIds?: string[]; includeUnassigned?: boolean },
): Promise<DeliveryPage> {
  const page = await repos.webhookDelivery.listByOrg(organizationId, opts);
  return { deliveries: page.rows.map(toDeliveryView), nextCursor: page.nextCursor };
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function auditAttempt(
  hook: IncomingWebhook,
  opts: { clientIp?: string; userAgent?: string },
  eventType: string,
  ref?: string,
): void {
  audit.recordAsync(
    {
      organizationId: hook.organizationId,
      actorUserId: hook.executionAuthority?.userId ?? hook.createdBy ?? null,
      ipAddress: opts.clientIp ?? null,
      userAgent: opts.userAgent ?? null,
      // The actor is whoever created the hook, but the caller is the remote
      // system that fired it — that's what "webhook" records.
      source: "webhook",
    },
    {
      eventType,
      resourceType: "incoming_webhook",
      resourceId: hook.id,
      ...(ref ? { after: { ref } } : {}),
    },
  );
}
