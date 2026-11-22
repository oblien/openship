import { AppError, ConflictError } from "@repo/core";
import { readLocalGlabToken } from "@repo/adapters";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { env, runtimeTarget } from "../../config/env";
import { instanceAuthorization } from "../../lib/instance-authorization";
import { nativeHostExecutionEnabled } from "../../native/execution-policy";
import { sanitizeCredential, writeCredentialSecrets } from "../credentials/credential.service";
import { gitlabRequest, verifyGitLabToken } from "./client";

function hostCliEnabled() {
  return runtimeTarget.selfHosted && !env.CLOUD_MODE && nativeHostExecutionEnabled();
}

export async function canLinkGlab(ctx: ExecutionContext) {
  return (
    hostCliEnabled() &&
    (ctx.sessionKind === "cookie" || ctx.sessionKind === "zero-auth") &&
    (ctx.role === "admin" || ctx.role === "owner") &&
    (await instanceAuthorization.allows(ctx))
  );
}

async function glabIdentity() {
  if (!hostCliEnabled()) throw new AppError("Host CLI access is disabled", 403);
  const token = await readLocalGlabToken();
  const user = await gitlabRequest<{ id: number; username: string }>("user", token);
  if (!Number.isSafeInteger(user.id) || user.id <= 0 || !user.username)
    throw new AppError("GitLab could not identify the CLI account", 409);
  return { id: String(user.id), username: user.username, token };
}

export async function connectGlab(ctx: ExecutionContext, name: string) {
  if (!(await canLinkGlab(ctx)))
    throw new AppError("Link the host CLI as an instance administrator", 403);
  name = name.trim();
  if (!name) throw new AppError("A connection name is required", 400);
  if (await repos.credential.nameTaken(ctx.organizationId, "gitlab", null, name))
    throw new ConflictError("A connection with this name already exists");
  const account = await glabIdentity();
  await verifyGitLabToken(account.token);
  return sanitizeCredential(
    await repos.credential.create({
      organizationId: ctx.organizationId,
      provider: "gitlab",
      name,
      selector: null,
      publicFields: { authorization: "host-cli", username: account.username },
      // A redacted instance export cannot reactivate a controller-local login.
      secretsEnc: writeCredentialSecrets({ glabUserId: account.id }),
      status: "active",
      lastVerifiedAt: new Date(),
    }),
  );
}

export async function resolveGlabToken(expectedId?: string) {
  if (!expectedId)
    throw new AppError(
      "Reconnect the GitLab CLI to this workspace",
      409,
      "CONNECTION_RECONNECT_REQUIRED",
    );
  const account = await glabIdentity();
  if (account.id !== expectedId)
    throw new AppError(
      "The GitLab CLI account changed. Reconnect it in Settings.",
      409,
      "CONNECTION_RECONNECT_REQUIRED",
    );
  return account.token;
}
