/**
 * Authenticated GitHub App setup callback for an operator-owned self-hosted App.
 *
 * GitHub documents `installation_id` on the Setup URL as attacker-controlled.
 * The claim therefore requires all three independent bindings:
 *   1. a one-shot state minted for this Openship user + workspace;
 *   2. the user's GitHub App authorization can see the installation;
 *   3. the configured App JWT can read that same installation.
 */

import { repos } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { env, localGitHubAppConfiguration } from "@repo/platform/engine/config/env";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import {
  consumeInstallState,
  invalidateOrgGitHubCache,
  invalidateUserGitHubCache,
  resolveGitHubAuthMode,
} from "@repo/platform/engine/modules/github/github.auth";
import { verifyGitHubInstallationForUser } from "@repo/platform/engine/modules/github/github.installation-verification";
import { verifyGitHubInstallationForSource } from "@repo/platform/engine/modules/github/github.installation-verification";

export type LocalInstallationClaimResult =
  | { kind: "ok"; installation: { id: number; login: string; type: string } }
  | { kind: "pending-approval" }
  | { kind: "invalid"; message: string }
  | { kind: "forbidden"; message: string }
  | { kind: "failed"; message: string };

export async function claimLocalGitHubInstallation(
  ctx: RequestContext,
  input: {
    state?: string;
    installationId?: string | number;
    setupAction?: string;
  },
): Promise<LocalInstallationClaimResult> {
  const state = typeof input.state === "string" ? input.state.trim() : "";
  const installationId = Number(input.installationId);
  if (!state || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return { kind: "invalid", message: "Missing or invalid GitHub setup parameters." };
  }

  // Peek before upstream calls so an invalid caller cannot burn the legitimate
  // user's state. The atomic consume below closes the concurrent replay window.
  const binding = await repos.githubInstallState.find(state).catch(() => null);
  if (
    !binding ||
    binding.userId !== ctx.userId ||
    binding.organizationId !== ctx.organizationId ||
    binding.flow !== "install"
  ) {
    return {
      kind: "forbidden",
      message: "This install link is expired, already used, or belongs to another workspace.",
    };
  }

  const customSource = binding.sourceId
    ? await repos.gitSource.findActiveById(ctx.organizationId, binding.sourceId)
    : undefined;
  if (binding.sourceId && !customSource) {
    return {
      kind: "forbidden",
      message: "This GitHub source no longer exists or is not active.",
    };
  }
  if (
    !customSource &&
    (env.CLOUD_MODE ||
      !localGitHubAppConfiguration.configured ||
      (await resolveGitHubAuthMode(ctx)) !== "app")
  ) {
    return {
      kind: "forbidden",
      message: "This instance is not using an operator-owned GitHub App.",
    };
  }

  if (input.setupAction === "request") {
    const consumed = await consumeInstallState(state, ctx.userId, ctx.organizationId);
    return consumed
      ? { kind: "pending-approval" }
      : { kind: "forbidden", message: "This install link was already used." };
  }

  try {
    const verification = customSource
      ? await verifyGitHubInstallationForSource(customSource, installationId)
      : await verifyGitHubInstallationForUser(ctx.userId, installationId);
    if (verification.kind === "forbidden") {
      return { kind: "forbidden", message: verification.message };
    }

    const account = verification.installation.account;
    const claimed = await repos.gitInstallation.claimWithState(state, {
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      sourceId: customSource?.id ?? null,
      provider: "github",
      installationId,
      owner: account.login.toLowerCase(),
      ownerType: account.type,
      // The installation account id is the owner (org/user), not necessarily
      // the human installer. Do not mislabel it as providerUserId; installation
      // webhooks can fill the sender id later without affecting authorization.
      providerUserId: undefined,
      providerOwnerId: String(account.id),
      isOrg: account.type === "Organization",
    });
    if (!claimed) {
      return { kind: "forbidden", message: "This install link was already used." };
    }
    await Promise.all([
      invalidateUserGitHubCache(ctx.userId),
      invalidateOrgGitHubCache(ctx.organizationId),
    ]).catch((error) => {
      // The durable claim already committed. Cache eviction is an optimization;
      // never report the installation as failed (and strand its consumed nonce)
      // merely because Redis was briefly unavailable.
      console.warn(`[GitHub] installation cache invalidation failed: ${safeErrorMessage(error)}`);
    });

    await repos.auditEvent
      .create({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        eventType: "github.install",
        resourceType: "github",
        resourceId: String(installationId),
        source: "dashboard",
        before: null,
        after: {
          installationId,
          owner: account.login,
          ownerType: account.type,
          authMode: "self-hosted-app",
          sourceId: customSource?.id ?? null,
        },
      })
      .catch(() => {});

    return {
      kind: "ok",
      installation: { id: installationId, login: account.login, type: account.type },
    };
  } catch (error) {
    return { kind: "failed", message: safeErrorMessage(error) };
  }
}
