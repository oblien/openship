/**
 * Canonical verifier for a GitHub App Setup URL's `installation_id`.
 *
 * GitHub treats that query parameter as untrusted. A valid claim must prove
 * both that the initiating GitHub user can see the installation and that the
 * installation belongs to the App configured by this Openship control plane.
 * Cloud and operator-owned self-hosted Apps deliberately share this function.
 */

import { ghFetch } from "./github.http";
import { appFetch, getUserToken } from "./github.auth";
import type { GitSource } from "@repo/db";
import { githubAppFetch } from "./github.app-client";
import { sourceClientCredentials } from "./github-source.service";
import type { GitHubInstallation } from "@repo/contracts";

export type GitHubInstallationVerificationResult =
  | { kind: "ok"; installation: GitHubInstallation }
  | {
      kind: "forbidden";
      reason: "missing-user-token" | "not-user-accessible" | "app-mismatch";
      message: string;
    };

async function findUserInstallation(
  token: string,
  installationId: number,
): Promise<GitHubInstallation | null> {
  const perPage = 100;
  for (let page = 1; ; page++) {
    const data = await ghFetch<{
      total_count: number;
      installations?: GitHubInstallation[];
    }>(token, {
      url: "https://api.github.com/user/installations",
      params: { per_page: perPage, page },
    });
    if (!Number.isSafeInteger(data.total_count) || data.total_count < 0) {
      throw new Error("GitHub returned an invalid installation count.");
    }
    const batch = data.installations ?? [];
    const match = batch.find((installation) => installation.id === installationId);
    if (match) return match;
    if (batch.length < perPage || page * perPage >= data.total_count) {
      return null;
    }
  }
}

export async function verifyGitHubInstallationForUser(
  userId: string,
  installationId: number,
): Promise<GitHubInstallationVerificationResult> {
  const userToken = await getUserToken(userId);
  if (!userToken) {
    return {
      kind: "forbidden",
      reason: "missing-user-token",
      message: "GitHub authorization is missing. Start the install again from Settings.",
    };
  }

  // User-token lookup binds the untrusted id to the human who initiated the
  // Openship flow. An App JWT alone can see every tenant installation.
  const userInstallation = await findUserInstallation(userToken, installationId);
  if (!userInstallation) {
    return {
      kind: "forbidden",
      reason: "not-user-accessible",
      message: "GitHub did not confirm that this installation belongs to your account.",
    };
  }

  // App-JWT lookup independently proves that the same installation belongs to
  // THIS configured App and provides canonical owner metadata.
  const appInstallation = await appFetch<GitHubInstallation>(
    `https://api.github.com/app/installations/${installationId}`,
  );
  if (
    appInstallation.id !== installationId ||
    appInstallation.account.id !== userInstallation.account.id ||
    appInstallation.app_id !== userInstallation.app_id
  ) {
    return {
      kind: "forbidden",
      reason: "app-mismatch",
      message: "GitHub installation verification failed.",
    };
  }

  return { kind: "ok", installation: appInstallation };
}

/**
 * Verify an installation for a workspace-owned custom App. The initiating
 * Openship user is already an authenticated workspace owner and the one-time
 * state binds the browser round-trip; the source's App JWT independently proves
 * that the untrusted installation_id belongs to this exact App.
 */
export async function verifyGitHubInstallationForSource(
  source: GitSource,
  installationId: number,
): Promise<GitHubInstallationVerificationResult> {
  const installation = await githubAppFetch<GitHubInstallation>(
    sourceClientCredentials(source),
    `/app/installations/${installationId}`,
  );
  if (installation.id !== installationId || installation.app_id !== source.appId) {
    return {
      kind: "forbidden",
      reason: "app-mismatch",
      message: "GitHub installation verification failed.",
    };
  }
  return { kind: "ok", installation };
}
