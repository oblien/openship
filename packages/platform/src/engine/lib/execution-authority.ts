import { AppError, UnauthorizedError, type ExecutionAuthority } from "@repo/core";
import { repos } from "@repo/db";
import { freezeContext, type ExecutionContext } from "../../context";
import { authorization } from "./authorization";

const invalid = () => new UnauthorizedError("The saved action's authorization is no longer valid");

/** Only an already-authorized application operation may capture a delegation. */
export async function captureExecutionAuthority(ctx: ExecutionContext): Promise<ExecutionAuthority> {
  let tokenId = ctx.tokenScope?.tokenId;
  if (!tokenId && ctx.principalKind === "pat" && ctx.sessionId.startsWith("pat:")) tokenId = ctx.sessionId.slice(4);
  if (!tokenId && ctx.principalKind === "oauth" && ctx.sessionId.startsWith("oauth:"))
    tokenId = (await repos.personalAccessToken.findOAuthBinding(ctx.userId, ctx.sessionId.slice(6)))?.id;
  if (ctx.principalKind && !tokenId) throw invalid();
  const authority: ExecutionAuthority = {
    version: 1,
    userId: ctx.userId,
    organizationId: ctx.organizationId,
    token: tokenId ? { id: tokenId, kind: ctx.principalKind === "oauth" ? "oauth" : "pat", scoped: !!ctx.tokenScope } : null,
    restrictions: ctx.credential ? {
      organizationId: ctx.credential.organizationId,
      readOnly: ctx.credential.readOnly,
      expiresAt: ctx.credential.expiresAt ?? null,
    } : null,
  };
  await resolveExecutionAuthority(authority, "capture");
  return authority;
}

/**
 * Resolve the original actor and current grants. Never substitute an org owner.
 * Session login delegates to the saved user's current membership. Token-created
 * actions additionally depend on the same live token/binding and its limits.
 */
export async function resolveExecutionAuthority(value: ExecutionAuthority | null | undefined, label: string): Promise<ExecutionContext> {
  if (!value) throw new AppError("Reauthorize this saved action before running it", 409, "ACTION_REAUTHORIZATION_REQUIRED");
  if (value.version !== 1 || typeof value.userId !== "string" || !value.userId || typeof value.organizationId !== "string" || !value.organizationId)
    throw invalid();
  const user = await repos.user.findById(value.userId);
  if (!user) throw invalid();
  const original = value.restrictions;
  if (original && (typeof original.readOnly !== "boolean" ||
    (original.organizationId !== null && original.organizationId !== value.organizationId) ||
    (original.expiresAt !== null && (!Number.isFinite(original.expiresAt) || original.expiresAt <= Date.now())))) throw invalid();
  let credential = original;
  let tokenScope: { tokenId: string } | null = null;
  if (value.token) {
    const token = value.token;
    if (typeof token.id !== "string" || !["pat", "oauth"].includes(token.kind) || typeof token.scoped !== "boolean") throw invalid();
    const row = await repos.personalAccessToken.findById(token.id);
    if (!row || row.userId !== value.userId || row.revokedAt ||
      (!!row.oauthClientId !== (token.kind === "oauth")) ||
      (row.expiresAt && row.expiresAt.getTime() <= Date.now()) ||
      (row.organizationId && row.organizationId !== value.organizationId)) throw invalid();
    const expiresAt = Math.min(original?.expiresAt ?? Infinity, row.expiresAt?.getTime() ?? Infinity);
    credential = {
      organizationId: original?.organizationId ?? row.organizationId,
      readOnly: !!original?.readOnly || row.readOnly,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    };
    if (token.scoped || row.scoped) {
      if (!row.organizationId) throw invalid();
      tokenScope = { tokenId: row.id };
    }
  }
  const context = await authorization.resolveScope({
    user: { id: user.id, email: user.email, name: user.name },
    sessionId: `delegated:${label}`,
    sessionKind: "native",
    principalKind: value.token?.kind ?? null,
    tokenScope,
    credential,
  }, value.organizationId);
  return freezeContext({ ...context, source: "system", userAgent: `openship-action:${label}` });
}
