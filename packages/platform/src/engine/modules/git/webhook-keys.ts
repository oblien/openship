import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_GIT_PROVIDER, type GitRepositoryRef } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";

type HookOwner = { organizationId: string; webhookSecret: string | null };
const prefix = "openship-hook-v1:";

export function webhookScope(org: string, ref: GitRepositoryRef) {
  return createHash("sha256")
    .update(
      JSON.stringify([org, ref.provider, ref.namespace.toLowerCase(), ref.name.toLowerCase()]),
    )
    .digest("hex");
}

export function legacyWebhookSecret(secret: string) {
  return secret.startsWith(prefix) ? null : secret;
}

export async function newRepositoryHookKey(scope: string) {
  const { encrypt } = await import("../../lib/encryption");
  const key = randomBytes(32).toString("base64");
  return { key, sealed: encrypt(prefix + scope + ":" + key) };
}

export async function repositoryHookKey(row: HookOwner, ref: GitRepositoryRef) {
  if (!row.webhookSecret) return null;
  const { decrypt } = await import("../../lib/encryption");
  try {
    const value = decrypt(row.webhookSecret);
    const marker = prefix + webhookScope(row.organizationId, ref) + ":";
    if (value.startsWith(marker)) return value.slice(marker.length);
    return ref.provider === DEFAULT_GIT_PROVIDER ? legacyWebhookSecret(value) : null;
  } catch (error) {
    reportCaughtError(error, "platform/engine/modules/git/webhook-keys");
    return null;
  }
}

/** Include transferred cloud bindings and retain configured, unreadable keys so verification fails closed. */
export async function repositorySigningKeys(ref: GitRepositoryRef) {
  const [projects, bindings] = await Promise.all([
    repos.project.findByGitRepo(ref),
    repos.cloudWebhookBinding.findByRepo(ref),
  ]);
  return Promise.all(
    [...projects, ...bindings]
      .filter((row) => row.webhookSecret)
      .map(async (row) => ({
        organizationId: row.organizationId,
        secret: await repositoryHookKey(row, ref),
      })),
  );
}
