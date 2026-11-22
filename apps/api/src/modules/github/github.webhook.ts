import { processGitDelivery } from "../git/webhook-delivery";
/**
 * GitHub webhook handler - processes incoming GitHub App webhook events.
 *
 * Implements the WebhookProvider interface so it plugs into the
 * unified webhook dispatcher in modules/webhooks/.
 *
 * Handles:
 *   - installation.created  → store installation in DB
 *   - installation.deleted  → remove installation from DB
 *   - push                  → trigger branch-matched redeployment
 *   - check_run             → acknowledged, no action
 */

import { repositorySigningKeys } from "@repo/platform/engine/modules/git/webhook-keys";
import { repos } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { verifyHmacSha256 } from "@repo/platform/engine/modules/webhooks/webhook.service";
import { handleInstallation } from "./webhook-installation";
import { webhookRepository } from "@repo/platform/engine/modules/github/webhook-repository";
import { handlePush } from "./webhook-push";
import { handleCheckRun } from "./webhook-check-run";
import { collectGitHubSourceWebhookSecrets } from "@repo/platform/engine/modules/github/github-source.service";
import type {
  WebhookProvider,
  WebhookVerifyResult,
  WebhookHandlerResult,
} from "@repo/platform/engine/modules/webhooks/webhook.types";
import type {
  GitHubCheckRunPayload,
  GitHubInstallationPayload,
  GitHubPushPayload,
} from "@repo/contracts";

// ─── Per-project webhook secret resolution ──────────────────────────────────

interface GitHubVerification extends WebhookVerifyResult {
  githubApp?: boolean;
  sourceIds?: readonly string[];
}

// ─── GitHub Webhook Provider ─────────────────────────────────────────────────

export const githubWebhookProvider: WebhookProvider<GitHubVerification> = {
  name: "github",

  async verify(payload, headers): Promise<GitHubVerification> {
    const signature = headers["x-hub-signature-256"];
    if (!signature) return { valid: false, error: "Missing x-hub-signature-256 header" };
    const event = headers["x-github-event"];
    let parsed: {
      installation?: { id?: unknown; app_id?: unknown };
      hook?: { app_id?: unknown };
    } | null;
    try {
      parsed = JSON.parse(payload.toString());
    } catch {
      // The controller rejects invalid JSON after authenticating the raw body.
      parsed = null;
    }
    let installationId: number | undefined;
    let appId: number | undefined;
    const rawInstallationId = parsed?.installation?.id;
    if (
      typeof rawInstallationId === "number" &&
      Number.isSafeInteger(rawInstallationId) &&
      rawInstallationId > 0
    )
      installationId = rawInstallationId;
    const rawAppId = parsed?.installation?.app_id ?? parsed?.hook?.app_id;
    if (typeof rawAppId === "number" && Number.isSafeInteger(rawAppId) && rawAppId > 0)
      appId = rawAppId;

    const ref = ["push", "check_run", "pull_request"].includes(event) && webhookRepository(parsed);
    const [candidates, sourceSecrets] = await Promise.all([
      ref ? repositorySigningKeys(ref) : [],
      collectGitHubSourceWebhookSecrets({
        installationId,
        appId,
        allowAllFallback: event === "ping",
      }),
    ]);
    // The default App can also deliver a push for a repository with per-project hooks.
    // Its installation claim supplies the workspace scope independently of those hooks.
    const legacySecret =
      !sourceSecrets.length && (!candidates.length || installationId !== undefined)
        ? env.GITHUB_WEBHOOK_SECRET
        : undefined;
    if (!legacySecret && !sourceSecrets.length && !candidates.length)
      return { valid: false, error: "No webhook secret configured — signature cannot be verified" };

    const matches = ({ secret }: { secret: string | null }) =>
      secret !== null && verifyHmacSha256(payload, secret, signature);
    const apps = sourceSecrets.filter(matches);
    const bindings = candidates.filter(matches);
    const legacy = legacySecret && matches({ secret: legacySecret });
    if (!apps.length && !bindings.length && !legacy)
      return { valid: false, error: "Invalid signature" };
    let organizationIds: string[] | undefined;
    if (legacy && installationId !== undefined && event !== "installation") {
      const installations = await repos.gitInstallation.findByInstallationIdForProvider(
        installationId,
        null,
      );
      organizationIds = installations.map((row) => row.organizationId);
    } else if (!legacy) {
      organizationIds = [...new Set([...apps, ...bindings].map((row) => row.organizationId))];
    }
    return {
      valid: true,
      ...(installationId !== undefined && (apps.length || legacy) ? { githubApp: true } : {}),
      ...(organizationIds ? { organizationIds } : {}),
      ...(apps.length ? { sourceIds: apps.map((row) => row.sourceId) } : {}),
    };
  },

  async handle(
    payload: unknown,
    headers: Record<string, string>,
    verification?: GitHubVerification,
  ): Promise<WebhookHandlerResult> {
    const event = headers["x-github-event"];
    if (!event) {
      return { success: true, event: "unknown", message: "Missing x-github-event header" };
    }

    // Idempotency: completed and in-flight deliveries are deduplicated; a
    // finished failure can be reclaimed when the operator redelivers it.
    // (persistent — survives restarts/replicas). The claim row is the ANCHOR
    // (source='github', project-less); per-project feed rows are recorded later
    // by the push handler. Missing id or claim error → process (fail-open; the
    // commit-sha guard in triggerDeployment is the backstop).
    const deliveryId = headers["x-github-delivery"];
    // Accept Actions work durably before the legacy deployment receipt claim.
    // A repeated delivery fills any interrupted fan-out without executing twice.
    if (verification?.githubApp && deliveryId)
      await (
        await import("@repo/platform/engine/modules/actions/triggers")
      ).enqueueActionWebhook(event, payload, deliveryId, verification.organizationIds);
    return processGitDelivery("github", event, deliveryId, async handledProjectIds => {
      switch (event) {
        case "installation":
          return handleInstallation(
            payload as GitHubInstallationPayload,
            verification?.sourceIds,
          );
        case "push":
          return handlePush(
            payload as GitHubPushPayload,
            handledProjectIds,
            verification?.organizationIds,
          );
        case "check_run":
          return handleCheckRun(
            payload as GitHubCheckRunPayload,
            verification?.organizationIds,
          );
        case "pull_request":
          const previewEvent = payload as { number?: number };
          const ref = webhookRepository(payload);
          if (ref && previewEvent.number)
            await (
              await import("@repo/platform/engine/modules/projects/pull-request-previews")
            ).enqueuePullRequestPreviews(ref, previewEvent.number, verification?.organizationIds);
          return { success: true, event, message: "Pull request automation queued" };
        case "ping":
          return { success: true, event, message: "Pong" };
        default:
          return { success: true, event, message: `Event '${event}' not handled` };
      }
    });
  },
};
