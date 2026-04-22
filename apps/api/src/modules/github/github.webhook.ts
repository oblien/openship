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
import { triggerDeployment } from "../deployments/build.service";
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

// ─── Push deduplication (prevents duplicate delivery reprocessing) ───────────

const activePushes = new Set<string>();

// ─── GitHub Webhook Provider ─────────────────────────────────────────────────

export const githubWebhookProvider: WebhookProvider = {
  name: "github",

  verify(payload: string | Buffer, headers: Record<string, string>): WebhookVerifyResult {
    const secret = env.GITHUB_WEBHOOK_SECRET;
    const signature = headers["x-hub-signature-256"];

    // No secret configured — accept unsigned webhooks (self-hosted without secret)
    if (!secret) {
      return { valid: true };
    }

    // Secret configured but no signature in request — reject
    if (!signature) {
      return { valid: false, error: "Missing x-hub-signature-256 header" };
    }

    const valid = verifyHmacSha256(payload, secret, signature);
    return valid ? { valid: true } : { valid: false, error: "Invalid signature" };
  },

  async handle(payload: unknown, headers: Record<string, string>): Promise<WebhookHandlerResult> {
    const event = headers["x-github-event"];
    if (!event) {
      return { success: true, event: "unknown", message: "Missing x-github-event header" };
    }

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
    case "suspend":
      return handleInstallationSuspended(payload);
    case "unsuspend":
      return handleInstallationCreated(payload); // Re-upsert to restore
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
    // Return success so GitHub doesn't retry — user may install before signing up
    console.log(`[GitHub Webhook] Installation created by unknown GitHub user ${senderId} (${accountLogin}) — skipping`);
    return { success: true, event: "installation", message: "No linked Openship user — ignored" };
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
    // Not an Openship user — nothing to clean up
    return { success: true, event: "installation", message: "No linked user — ignored" };
  }

  await repos.gitInstallation.removeByInstallationId(account.userId, installationId);

  return { success: true, event: "installation", message: "Installation removed" };
}

async function handleInstallationSuspended(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const senderId = String(payload.sender.id);
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();

  const account = await findUserByGitHubId(senderId);
  if (!account) {
    return { success: true, event: "installation", message: "No linked user — ignored" };
  }

  // Suspended installations can't issue tokens — remove so token resolution
  // falls back to the user's OAuth token, and linkRepo will prompt re-install.
  await repos.gitInstallation.removeByInstallationId(account.userId, installationId);
  console.log(`[GitHub Webhook] Installation suspended for ${accountLogin} — removed from DB`);

  return { success: true, event: "installation", message: `Installation suspended for ${accountLogin}` };
}

// ─── Push events ─────────────────────────────────────────────────────────────

async function handlePush(payload: GitHubPushPayload): Promise<WebhookHandlerResult> {
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const ref = payload.ref;
  const commitSha = payload.head_commit?.id;

  if (!owner || !repo) {
    return { success: false, event: "push", error: "Missing repository info in payload" };
  }

  const pushKey = `${owner}/${repo}#${ref ?? "unknown"}@${commitSha ?? "unknown"}`.toLowerCase();

  /* Deduplicate: skip if we're already processing a push for this repo */
  if (activePushes.has(pushKey)) {
    return { success: true, event: "push", message: "Already processing a push for this repo" };
  }

  activePushes.add(pushKey);

  try {
    /* Only handle branch pushes — ignore tag pushes (refs/tags/...) */
    if (!ref?.startsWith("refs/heads/")) {
      return { success: true, event: "push", message: `Ignoring non-branch ref: ${ref ?? "unknown"}` };
    }

    const branch = ref.replace("refs/heads/", "");
    const commitMessage = payload.head_commit?.message;

    /* Find all projects linked to this repo that have auto-deploy enabled */
    const projects = await repos.project.findByGitRepo(owner, repo);
    const autoDeployProjects = projects.filter(
      (p) => p.autoDeploy && (p.gitBranch ?? "main") === branch,
    );

    if (autoDeployProjects.length === 0) {
      console.log(`[GitHub Webhook] Push to ${owner}/${repo}#${branch} — no matching auto-deploy projects`);
      return { success: true, event: "push", message: "No auto-deploy projects matched" };
    }

    /* Trigger deployment for each matching project */
    const results = await Promise.allSettled(
      autoDeployProjects.map((p) =>
        triggerDeployment(p.userId, {
          projectId: p.id,
          branch,
          commitSha,
          commitMessage,
          trigger: "webhook",
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    if (failed > 0) {
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => String(r.reason));
      console.error(`[GitHub Webhook] Push deploy failures for ${owner}/${repo}:`, errors);
    }

    return {
      success: true,
      event: "push",
      message: `Triggered ${succeeded} deployment(s) for ${owner}/${repo}#${branch}${failed ? `, ${failed} failed` : ""}`,
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
