/** Hosted App attempts live in Cloud. Never copy their nonces or installation
 * rows into the self-hosted database; use the same Cloud operations as its UI. */
import { Value } from "@sinclair/typebox/value";
import { AppError } from "@repo/core";
import { GitHubCollectionSchemas, type GitHubOperations } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { cloudClient } from "../../lib/cloud/client";
import { assertCloudTenantScope } from "../../lib/cloud/scope";
import { readCloudJson } from "../../lib/cloud/transport";
import { REPOSITORY_OAUTH_STATE_PREFIX } from "./github-repository-authorization";

export const isHostedGitHubAttempt = (state: string) =>
  state.startsWith(REPOSITORY_OAUTH_STATE_PREFIX);
type Method = "connect" | "claimInstallation" | "pollConnect";

export async function cloudGitHubConnection<K extends Method>(
  ctx: ExecutionContext,
  method: K,
  input: Parameters<GitHubOperations[K]>[0],
): Promise<Awaited<ReturnType<GitHubOperations[K]>>> {
  await assertCloudTenantScope(ctx);
  const client = cloudClient({ organizationId: ctx.organizationId });
  const path =
    method === "pollConnect"
      ? `/api/github/connect/poll?${new URLSearchParams({ state: (input as { state: string }).state })}`
      : method === "claimInstallation"
        ? "/api/github/installations/claim"
        : "/api/github/connect";
  const response = await client.request(
    path,
    method === "pollConnect"
      ? { method: "GET" }
      : { method: "POST", body: JSON.stringify(input ?? {}) },
  );
  if (!response)
    throw new AppError(
      "Openship Cloud is unavailable. Reconnect your Cloud account and try again.",
      503,
      "CLOUD_CONNECTION_UNAVAILABLE",
    );
  const body = await readCloudJson<unknown>(response);
  if (!response.ok) {
    const failure = body as { error?: unknown; code?: unknown } | null;
    throw new AppError(
      typeof failure?.error === "string"
        ? failure.error
        : "Cloud could not complete the GitHub connection. Try again.",
      response.status,
      typeof failure?.code === "string" ? failure.code : "CLOUD_GITHUB_CONNECTION_FAILED",
    );
  }
  if (!Value.Check(GitHubCollectionSchemas[method].output, body))
    throw new AppError(
      "Cloud returned an invalid GitHub connection response. Update Openship Cloud and try again.",
      502,
      "CLOUD_GITHUB_INVALID_RESPONSE",
    );
  if (
    method === "connect" &&
    Value.Check(GitHubCollectionSchemas.connect.output, body) &&
    !body.connected &&
    body.flow === "redirect"
  ) {
    if (
      !body.state ||
      !isHostedGitHubAttempt(body.state) ||
      body.completion !== "attempt" ||
      !body.url ||
      !URL.canParse(body.url)
    )
      throw new AppError(
        "Cloud returned an incomplete GitHub connection attempt. Update Openship Cloud and try again.",
        502,
        "CLOUD_GITHUB_INVALID_RESPONSE",
      );
    if (new URL(body.url).pathname === "/api/github/connect/redirect") {
      // Cloud cannot depend on a SaaS browser cookie on a self-hosted popup.
      // Issue a one-shot bridge for THIS attempt, keeping the same actor + org.
      const bridge = await client.github.oauthHandoff(body.state);
      if (!bridge)
        throw new AppError(
          "Could not start GitHub authorization in Cloud. Try again.",
          503,
          "CLOUD_GITHUB_CONNECTION_FAILED",
        );
      return { ...body, url: bridge.url } as Awaited<ReturnType<GitHubOperations[K]>>;
    }
  }
  return body as Awaited<ReturnType<GitHubOperations[K]>>;
}
