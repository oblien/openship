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
import { encrypt, decrypt } from "../../lib/encryption";
import { verifyHmacSha256 } from "../webhooks/webhook.service";
import { webhookActorCtx } from "../github/webhook-shared";
import { resolveOrgOwner } from "../../lib/org-actor";
import { triggerDeployment } from "../deployments/build.service";
import { runJobNow } from "../jobs/job.service";
import { audit } from "../../lib/audit";
import { incomingWebhookUrl } from "../../lib/public-url";
import { env } from "../../config";

const ACTION_TYPES: IncomingWebhookActionType[] = ["deploy", "job"];
const AUTH_MODES: IncomingWebhookAuthMode[] = ["token", "hmac", "none"];

export function isValidActionType(v: unknown): v is IncomingWebhookActionType {
  return typeof v === "string" && (ACTION_TYPES as string[]).includes(v);
}
export function isValidAuthMode(v: unknown): v is IncomingWebhookAuthMode {
  return typeof v === "string" && (AUTH_MODES as string[]).includes(v);
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
  if (authMode === "token") return { tokenEncrypted: encrypt(generateSecret()), hmacSecretEncrypted: null };
  if (authMode === "hmac") return { tokenEncrypted: null, hmacSecretEncrypted: encrypt(generateSecret()) };
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
}

export async function updateHook(
  projectId: string,
  id: string,
  patch: UpdateHookInput,
  reveal = false,
): Promise<IncomingWebhookView | null> {
  const row = await getScoped(projectId, id);
  if (!row) return null;

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name.trim() || row.name;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.actionType !== undefined) data.actionType = patch.actionType;
  if (patch.actionConfig !== undefined) data.actionConfig = patch.actionConfig;

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
  if (authChanged) data.authMode = patch.authMode;
  if (authChanged || typeChanged) {
    Object.assign(data, mintCredentials(patch.authMode ?? row.authMode));
  }

  await repos.incomingWebhook.update(id, data);
  const updated = await repos.incomingWebhook.findById(id);
  // `reveal` is the caller's decision (mask unless they may USE the credential —
  // a benign PATCH on a job hook must NOT leak its secret to a non-runner).
  return updated ? toView(updated, reveal) : null;
}

/** Regenerate the credential for the hook's current auth mode. */
export async function rotateCredential(
  projectId: string,
  id: string,
): Promise<IncomingWebhookView | null> {
  const row = await getScoped(projectId, id);
  if (!row) return null;
  if (row.authMode === "none") return toView(row, true);
  await repos.incomingWebhook.update(id, mintCredentials(row.authMode));
  const updated = await repos.incomingWebhook.findById(id);
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

  // ── Dispatch ──
  const owner = await resolveOrgOwner(hook.organizationId).catch(() => null);
  const actorUserId = owner?.userId ?? hook.createdBy ?? "system";
  const ctx = webhookActorCtx(actorUserId, hook.organizationId, `incoming-webhook:${hook.actionType}`);
  const cfg = (hook.actionConfig ?? {}) as IncomingWebhookActionConfig;

  try {
    let ref: string | undefined;
    if (hook.actionType === "deploy") {
      const result = await triggerDeployment(ctx, {
        projectId: hook.projectId,
        trigger: "webhook",
        serviceIds: cfg.serviceId ? [cfg.serviceId] : undefined,
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
  void repos.webhookDelivery
    .record({
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
    })
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
export async function listProjectDeliveries(projectId: string, opts?: PageOpts): Promise<DeliveryPage> {
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
export async function listOrgDeliveries(organizationId: string, opts?: PageOpts): Promise<DeliveryPage> {
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
      actorUserId: hook.createdBy ?? null,
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
