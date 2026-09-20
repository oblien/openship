/**
 * GitHub webhook installation events — installation.created / deleted /
 * suspend / unsuspend.
 */

import { repos } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import {
  getGitHubAuthMode,
  invalidateOrgGitHubCache,
  invalidateUserGitHubCache,
} from "@repo/platform/engine/modules/github/github.auth";
import type { WebhookHandlerResult } from "@repo/platform/engine/modules/webhooks/webhook.types";
import type { GitHubInstallationPayload } from "@repo/contracts";
import { listGitHubSourcesForWebhook } from "@repo/platform/engine/modules/github/github-source.service";

interface InstallationWebhookScope {
  sourceIds: Set<string>;
  includeLegacy: boolean;
}

async function resolveInstallationScope(
  payload: GitHubInstallationPayload,
): Promise<InstallationWebhookScope> {
  const sources = await listGitHubSourcesForWebhook({
    installationId: payload.installation.id,
    appId: payload.installation.app_id,
  }).catch(() => []);
  const sourceIds = new Set(sources.map((source) => source.id));
  const configuredAppId = Number(env.GITHUB_APP_ID ?? 0);
  const legacyMode = env.CLOUD_MODE || getGitHubAuthMode() === "app";
  return {
    sourceIds,
    includeLegacy:
      legacyMode &&
      (sourceIds.size === 0 ||
        configuredAppId <= 0 ||
        configuredAppId === payload.installation.app_id),
  };
}

function rowsInScope<T extends { sourceId?: string | null }>(
  rows: T[],
  scope: InstallationWebhookScope,
): T[] {
  return rows.filter((row) =>
    row.sourceId ? scope.sourceIds.has(row.sourceId) : scope.includeLegacy,
  );
}

// ─── Installation events ─────────────────────────────────────────────────────

export async function handleInstallation(
  payload: GitHubInstallationPayload,
): Promise<WebhookHandlerResult> {
  const scope = await resolveInstallationScope(payload);
  // SaaS-only contract: the GitHub App is owned by openship.io, so
  // installation events ONLY have authoritative meaning on the SaaS
  // (env.CLOUD_MODE=true). On a self-hosted instance the App's webhook
  // is configured to point at api.openship.io — an installation event
  // arriving here means a misconfiguration. The local DB MUST NOT
  // become a parallel source of truth for installations: cloud-app mode
  // reads installations strictly from SaaS, and a stale local row would
  // lie for up to 50min after the user uninstalls or moves the App.
  // Acknowledge with 200 (so GitHub doesn't retry forever) and refuse to
  // touch local state.
  //
  // The exception is effective local App mode (explicit or auto-detected),
  // where the operator owns the App and its webhook legitimately points here.
  if (!scope.includeLegacy && scope.sourceIds.size === 0) {
    console.log(
      `[GitHub Webhook] Ignoring installation.${payload.action} on self-hosted instance — SaaS (api.openship.io) is the authoritative source for GitHub App installations.`,
    );
    return {
      success: true,
      event: "installation",
      message: "Ignored on self-hosted — SaaS is the source of truth",
    };
  }

  switch (payload.action) {
    case "created":
      return handleInstallationCreated(payload, scope);
    case "deleted":
      return handleInstallationDeleted(payload, scope);
    case "suspend":
      return handleInstallationSuspended(payload, scope);
    case "unsuspend":
      return handleInstallationCreated(payload, scope); // Re-upsert to restore
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
  scope: InstallationWebhookScope,
): Promise<WebhookHandlerResult> {
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();
  const accountType = payload.installation.account.type;

  // Installation webhooks carry no Openship workspace binding and can arrive
  // before or after the browser setup redirect. They may refresh a row that the
  // verified claim callback already owns, but must never invent one by guessing
  // from sender membership order.
  const existing = rowsInScope(
    await repos.gitInstallation.findByInstallationIdForProvider(installationId).catch(() => []),
    scope,
  );
  if (existing.length === 0) {
    console.log(
      `[GitHub Webhook] installation.created for ${accountLogin} is awaiting the state-bound setup callback; no workspace row was guessed.`,
    );
    return {
      success: true,
      event: "installation",
      message: "Awaiting authenticated setup callback",
    };
  }

  await Promise.all(
    existing.map((row) =>
      repos.gitInstallation.upsert({
        userId: row.userId,
        organizationId: row.organizationId,
        sourceId: row.sourceId ?? null,
        provider: "github",
        installationId,
        owner: accountLogin,
        ownerType: accountType,
        providerUserId: String(payload.sender.id),
        providerOwnerId: String(payload.installation.account.id),
        isOrg: accountType === "Organization",
      }),
    ),
  );
  await Promise.all(
    [...new Set(existing.map((row) => row.userId))].map((userId) =>
      invalidateUserGitHubCache(userId),
    ),
  );
  await Promise.all(
    [...new Set(existing.map((row) => row.organizationId))].map((organizationId) =>
      invalidateOrgGitHubCache(organizationId),
    ),
  );

  console.log(
    `[GitHub Webhook] installation.${payload.action} refreshed ${existing.length} workspace binding(s) for ${accountLogin}`,
  );
  return {
    success: true,
    event: "installation",
    message: `Installation created for ${accountLogin}`,
  };
}

async function handleInstallationDeleted(
  payload: GitHubInstallationPayload,
  scope: InstallationWebhookScope,
): Promise<WebhookHandlerResult> {
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();

  const existing = rowsInScope(
    await repos.gitInstallation.findByInstallationIdForProvider(installationId).catch(() => []),
    scope,
  );
  const sourceIds = new Set(existing.map((row) => row.sourceId ?? null));
  await Promise.all(
    [...sourceIds].map((sourceId) =>
      repos.gitInstallation.removeByInstallationIdForProvider(installationId, sourceId),
    ),
  );
  await Promise.all(
    [...new Set(existing.map((row) => row.userId))].map((userId) =>
      invalidateUserGitHubCache(userId),
    ),
  );
  await Promise.all(
    [...new Set(existing.map((row) => row.organizationId))].map((organizationId) =>
      invalidateOrgGitHubCache(organizationId),
    ),
  );
  await Promise.all(
    [...new Set(existing.map((row) => row.organizationId))].map(async (organizationId) => {
      // Grants are owner-scoped, not source-scoped. Keep them when another
      // active App still covers this owner in the workspace.
      const replacement = await repos.gitInstallation
        .findByOrgAndOwner(organizationId, accountLogin)
        .catch(() => undefined);
      if (!replacement) {
        await repos.resourceGrant
          .deleteGitHubGrantsForOwner(organizationId, accountLogin)
          .catch(() => 0);
      }
    }),
  );

  return { success: true, event: "installation", message: "Installation removed" };
}

async function handleInstallationSuspended(
  payload: GitHubInstallationPayload,
  scope: InstallationWebhookScope,
): Promise<WebhookHandlerResult> {
  const installationId = payload.installation.id;
  const accountLogin = payload.installation.account.login.toLowerCase();

  // Suspension is reversible. Preserve the workspace binding and grants so an
  // unsuspend event becomes usable again without an impossible second setup
  // callback; GitHub will refuse token minting while it is suspended.
  const existing = rowsInScope(
    await repos.gitInstallation.findByInstallationIdForProvider(installationId).catch(() => []),
    scope,
  );
  const sourceIds = new Set(existing.map((row) => row.sourceId ?? null));
  await Promise.all(
    [...sourceIds].map((sourceId) =>
      repos.gitInstallation.suspendByInstallationIdForProvider(installationId, sourceId),
    ),
  );
  await Promise.all(
    [...new Set(existing.map((row) => row.userId))].map((userId) =>
      invalidateUserGitHubCache(userId),
    ),
  );
  await Promise.all(
    [...new Set(existing.map((row) => row.organizationId))].map((organizationId) =>
      invalidateOrgGitHubCache(organizationId),
    ),
  );
  console.log(
    `[GitHub Webhook] Installation suspended for ${accountLogin}; workspace bindings retained`,
  );

  return {
    success: true,
    event: "installation",
    message: `Installation suspended for ${accountLogin}`,
  };
}
