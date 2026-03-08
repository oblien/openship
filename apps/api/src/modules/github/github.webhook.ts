/**
 * GitHub webhook handler — processes incoming GitHub App webhook events.
 *
 * Implements the WebhookProvider interface so it plugs into the
 * unified webhook dispatcher in modules/webhooks/.
 *
 * Handles:
 *   - installation.created  → store installation in DB
 *   - installation.deleted  → remove installation from DB
 *   - push                  → trigger redeployment (delegates to deployment service)
 *   - check_run             → acknowledged, no action
 */

import { repos } from "@repo/db";
import { env } from "../../config/env";
import { verifyHmacSha256 } from "../webhooks/webhook.service";
import type {
  WebhookProvider,
  WebhookVerifyResult,
  WebhookHandlerResult,
} from "../webhooks/webhook.types";
import type {
  GitHubInstallationPayload,
  GitHubPushPayload,
} from "./github.types";

// ─── Push deduplication (prevents concurrent deploys for same repo) ──────────

const activePushes = new Set<string>();

// ─── GitHub Webhook Provider ─────────────────────────────────────────────────

export const githubWebhookProvider: WebhookProvider = {
  name: "github",

  verify(payload: string | Buffer, headers: Record<string, string>): WebhookVerifyResult {
    const secret = env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      return { valid: false, error: "GITHUB_WEBHOOK_SECRET is not configured" };
    }

    const signature = headers["x-hub-signature-256"];
    if (!signature) {
      return { valid: false, error: "Missing x-hub-signature-256 header" };
    }

    const valid = verifyHmacSha256(payload, secret, signature);
    return valid ? { valid: true } : { valid: false, error: "Invalid signature" };
  },

  async handle(payload: unknown, headers: Record<string, string>): Promise<WebhookHandlerResult> {
    const event = headers["x-github-event"];

    switch (event) {
      case "installation":
        return handleInstallation(payload as GitHubInstallationPayload);
      case "push":
        return handlePush(payload as GitHubPushPayload);
      case "check_run":
        return { success: true, event, message: "Check run acknowledged" };
      case "ping":
        return { success: true, event, message: "Pong" };
      default:
        return { success: true, event, message: `Event '${event}' not handled` };
    }
  },
};

// ─── Installation events ─────────────────────────────────────────────────────

async function handleInstallation(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  switch (payload.action) {
    case "created":
      return handleInstallationCreated(payload);
    case "deleted":
      return handleInstallationDeleted(payload);
    default:
      return {
        success: true,
        event: "installation",
        message: `Installation action '${payload.action}' not handled`,
      };
  }
}

async function handleInstallationCreated(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const senderId = String(payload.sender.id);
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();
  const accountType = payload.installation.account.type;

  /* Find the user by their GitHub provider ID in Better Auth's account table */
  const account = await findUserByGitHubId(senderId);
  if (!account) {
    return { success: false, event: "installation", error: "No linked user found for this GitHub account" };
  }

  await repos.gitInstallation.upsert({
    userId: account.userId,
    provider: "github",
    installationId,
    owner: accountLogin,
    ownerType: accountType,
    providerUserId: senderId,
    providerOwnerId: String(payload.installation.account.id),
    isOrg: accountType === "Organization",
  });

  return { success: true, event: "installation", message: `Installation created for ${accountLogin}` };
}

async function handleInstallationDeleted(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const senderId = String(payload.sender.id);
  const installationId = payload.installation.id;

  const account = await findUserByGitHubId(senderId);
  if (!account) {
    return { success: false, event: "installation", error: "No linked user found" };
  }

  await repos.gitInstallation.removeByInstallationId(account.userId, installationId);

  return { success: true, event: "installation", message: "Installation removed" };
}

// ─── Push events ─────────────────────────────────────────────────────────────

async function handlePush(payload: GitHubPushPayload): Promise<WebhookHandlerResult> {
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;

  if (!owner || !repo) {
    return { success: false, event: "push", error: "Missing repository info in payload" };
  }

  const pushKey = `${owner}/${repo}`.toLowerCase();

  /* Deduplicate: skip if we're already processing a push for this repo */
  if (activePushes.has(pushKey)) {
    return { success: true, event: "push", message: "Already processing a push for this repo" };
  }

  activePushes.add(pushKey);

  try {
    /**
     * TODO: Integrate with deployment service once it's implemented.
     *
     * The flow should be:
     *   1. Look up project by owner+repo in the deployments/projects table
     *   2. Create a new build session
     *   3. Queue the deployment via BullMQ
     *   4. Create a GitHub check run to track status
     *
     * For now we log and acknowledge the event so the webhook infrastructure
     * is fully operational.
     */
    console.log(`[GitHub Webhook] Push received: ${owner}/${repo} ref=${payload.ref}`);
    console.log(`[GitHub Webhook] Commit: ${payload.head_commit?.id?.slice(0, 7)} — ${payload.head_commit?.message}`);

    return {
      success: true,
      event: "push",
      message: `Push event processed for ${owner}/${repo}`,
    };
  } finally {
    activePushes.delete(pushKey);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find our user by their GitHub account ID using Better Auth's account table.
 */
async function findUserByGitHubId(githubId: string) {
  const account = await repos.account.findByProviderAccountId("github", githubId);
  if (!account) return null;
  return { userId: account.userId, accountId: account.accountId };
}
