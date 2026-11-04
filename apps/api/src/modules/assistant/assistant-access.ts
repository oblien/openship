import {
  mcpOAuthRequest,
  prepareMcpConsent,
  mcpClientToken,
} from "../mcp/mcp-client-authorization";
import { createHash, randomBytes } from "node:crypto";
import { repos, type AssistantOwner } from "@repo/db";
import { AppError } from "@repo/core";
import type { AssistantAuthorization } from "@repo/contracts";
import { env } from "@repo/platform/engine/config/env";
import { resolveDashboardPublicUrl } from "@repo/platform/engine/lib/public-url";
import type { RequestContext } from "../../lib/request-context";
import { resolveBearerIdentity } from "../../middleware/auth";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";
import {
  resolveAssistantTarget,
  revalidateAssistantTarget,
} from "@repo/platform/engine/modules/assistant/target-access";

export const assistantAvailable = () =>
  env.CLOUD_MODE || ["darwin", "linux"].includes(process.platform);
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const assistantError = (message: string, status = 409, code = "ASSISTANT_UNAVAILABLE") =>
  new AppError(message, status, code);

/** Assistant controls are a user-session surface, never tools an agent can call to grant itself access. */
export const isAssistantUserSession = (ctx: RequestContext) =>
  !ctx.principalKind && !ctx.tokenScope && ctx.sessionKind !== "bearer";

export function requireAssistantSession(ctx: RequestContext) {
  if (!assistantAvailable())
    throw assistantError(
      "This host does not support native assistants. Use a macOS or Linux host.",
      404,
    );
  if (!isAssistantUserSession(ctx))
    throw assistantError(
      "Use your OpenShip session to manage the assistant.",
      403,
      "ASSISTANT_SESSION_REQUIRED",
    );
}

type Pending = AssistantOwner & {
  origin: string;
  clientId: string;
  verifier: string;
  serverId: string | null;
};
export async function withAssistantLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  return createProvisionLock(`assistant:${key}`).run(work);
}
export const ownerKey = (owner: AssistantOwner) =>
  JSON.stringify([owner.userId, owner.organizationId]);

export async function beginAssistantAuthorization(
  ctx: RequestContext,
  origin: string,
  targetId?: string,
): Promise<AssistantAuthorization> {
  requireAssistantSession(ctx);
  const target = await resolveAssistantTarget(ctx, targetId);
  if (target && new URL(origin).protocol !== "https:")
    throw assistantError(
      "Remote assistants require your OpenShip API to be reachable over HTTPS.",
      400,
    );
  return withAssistantLock(`connection:${ownerKey(ctx)}`, async () => {
    const redirectUri = `${origin}/api/assistant/callback`;
    const state = randomBytes(32).toString("base64url");
    const prepared = await prepareMcpConsent(ctx, {
      origin,
      name: "OpenShip Assistant",
      redirectUri,
      state,
    });
    const { verifier, clientId, consentCode } = prepared;
    const entry: Pending = {
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      origin,
      clientId,
      verifier,
      serverId: target?.id ?? null,
    };
    await repos.assistant.saveAuthorization({
      id: digest(state),
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      kind: "mcp",
      payload: encrypt(JSON.stringify(entry)),
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
    return {
      clientId,
      consentCode,
      state,
      organizationId: ctx.organizationId,
    };
  });
}

export async function finishAssistantAuthorization(state: string, code?: string, error?: string) {
  if (!assistantAvailable()) throw assistantError("Assistant is unavailable.", 404);
  // Better Auth's denied-consent redirect omits state. This fixed redirect cannot enable access.
  if (!state && !code && error)
    return `${resolveDashboardPublicUrl()}/assistant?authorization=cancelled`;
  const pending = await repos.assistant.authorization(digest(state));
  if (!pending || pending.kind !== "mcp")
    throw assistantError(
      "This authorization expired. Enable the assistant again.",
      400,
      "ASSISTANT_AUTHORIZATION_EXPIRED",
    );
  const entry = JSON.parse(decrypt(pending.payload)) as Pending;
  return withAssistantLock(`connection:${ownerKey(entry)}`, async () => {
    if (!(await repos.assistant.authorization(digest(state), true)))
      throw assistantError("This authorization is no longer valid.", 400);
    if (!code) return `${resolveDashboardPublicUrl()}/assistant?authorization=cancelled`;
    await revalidateAssistantTarget(entry, entry.serverId);
    const result = await mcpOAuthRequest(
      entry.origin,
      "mcp/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: entry.verifier,
        redirect_uri: `${entry.origin}/api/assistant/callback`,
        client_id: entry.clientId,
        resource: `${entry.origin}/api/mcp`,
      }),
    );
    const token = typeof result.access_token === "string" ? result.access_token : "";
    const identity = token
      ? await resolveBearerIdentity(token, new Headers({ authorization: `Bearer ${token}` }))
      : null;
    if (
      !identity ||
      identity.userId !== entry.userId ||
      identity.organizationId !== entry.organizationId ||
      !(await repos.member.find(entry.organizationId, entry.userId))
    ) {
      await repos.oauth.disconnectMcpClient(identity?.userId ?? entry.userId, entry.clientId);
      throw assistantError(
        "Authorize the assistant with the same account and workspace where you enabled it.",
        403,
        "ASSISTANT_AUTHORIZATION_SCOPE",
      );
    }
    const previous = await repos.assistant.connection(entry);
    await repos.assistant.connect({
      userId: entry.userId,
      organizationId: entry.organizationId,
      clientId: entry.clientId,
      origin: entry.origin,
      serverId: entry.serverId,
    });
    if (previous && previous.clientId !== entry.clientId)
      await repos.oauth.disconnectMcpClient(entry.userId, previous.clientId);
    return `${resolveDashboardPublicUrl()}/assistant`;
  });
}

export async function disableAssistantAccess(ctx: RequestContext) {
  requireAssistantSession(ctx);
  return withAssistantLock(`connection:${ownerKey(ctx)}`, async () => {
    await repos.assistant.clearAuthorizations(ctx);
    const connection = await repos.assistant.connection(ctx);
    // Removing opt-in first shuts every bridge immediately, even if token revocation fails.
    await repos.assistant.disconnect(ctx);
    if (connection) await repos.oauth.disconnectMcpClient(ctx.userId, connection.clientId);
  });
}

export async function assistantCredential(
  owner: AssistantOwner,
  expected?: { clientId: string; accessFingerprint: string },
  refresh = true,
) {
  if (!assistantAvailable()) throw assistantError("Assistant is unavailable.", 404);
  const connection = await repos.assistant.connection(owner);
  if (!connection)
    throw assistantError(
      "Enable the assistant and approve its permissions first.",
      403,
      "ASSISTANT_DISABLED",
    );
  const token = await mcpClientToken(
    { ...owner, clientId: connection.clientId, origin: connection.origin },
    refresh,
  );
  const identity = await resolveBearerIdentity(
    token,
    new Headers({ authorization: `Bearer ${token}` }),
  );
  const binding = await repos.personalAccessToken.findOAuthBinding(
    owner.userId,
    connection.clientId,
  );
  const member = await repos.member.find(owner.organizationId, owner.userId);
  if (
    !identity ||
    identity.userId !== owner.userId ||
    identity.organizationId !== owner.organizationId ||
    !binding ||
    !member
  )
    throw assistantError(
      "Your assistant access changed. Review its permissions.",
      403,
      "ASSISTANT_ACCESS_CHANGED",
    );
  const grants = await repos.patGrant.listByToken(binding.id);
  await revalidateAssistantTarget(owner, connection.serverId);
  const memberGrants = await repos.resourceGrant.listByMember(owner.organizationId, owner.userId);
  const canonical = (
    items: Array<{
      resourceType: string;
      resourceId: string;
      permissions: string[];
      scope?: unknown;
    }>,
  ) =>
    items
      .map((g) => [g.resourceType, g.resourceId, [...g.permissions].sort(), g.scope])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const fingerprint = digest([
    connection.clientId,
    connection.serverId,
    member.id,
    member.role,
    binding.scoped,
    binding.readOnly,
    binding.expiresAt,
    canonical(grants),
    canonical(memberGrants),
  ]);
  if (
    expected &&
    (expected.clientId !== connection.clientId || expected.accessFingerprint !== fingerprint)
  )
    throw assistantError(
      "Access changed. Start a new conversation with your current permissions.",
      403,
      "ASSISTANT_ACCESS_CHANGED",
    );
  return { connection, token, fingerprint, identity };
}
