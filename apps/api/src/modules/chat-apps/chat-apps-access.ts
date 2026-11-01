import { encrypt } from "@repo/platform/engine/lib/encryption";
import { repos, type ChatAppConnection } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { resolveDashboardPublicUrl } from "@repo/platform/engine/lib/public-url";
import {
  mcpOAuthRequest,
  prepareMcpConsent,
  mcpClientToken,
} from "../mcp/mcp-client-authorization";
import { resolveBearerIdentity } from "../../middleware/auth";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";
import {
  fingerprint,
  challenge,
  readChallenge,
  enabled,
  owned,
  fail,
  nonce,
  senderKey,
  type ChatSender,
} from "./chat-apps-common";
interface Pair {
  sender: ChatSender;
  revision: number;
}
interface Authorization extends Pair {
  userId: string;
  organizationId: string;
  clientId: string;
  verifier: string;
  origin: string;
}
interface Verify extends Omit<Authorization, "verifier"> {}

export async function pairingLink(c: ChatAppConnection, sender: ChatSender) {
  const token = await challenge(c.id, "pair", { sender, revision: c.revision } satisfies Pair, 10);
  return `${resolveDashboardPublicUrl()}/settings?tab=chat-apps&link=${encodeURIComponent(token)}`;
}
export async function beginPairing(ctx: RequestContext, token: string) {
  const pair = await readChallenge<Pair>(token, "pair");
  const c = await owned(ctx, pair.connectionId);
  await enabled(c.id, pair.value.revision);
  const state = nonce(),
    redirectUri = `${c.origin}/api/chat-apps/callback`;
  const prepared = await prepareMcpConsent(ctx, {
    origin: c.origin,
    name: `OpenShip Chat · ${c.name}`,
    redirectUri,
    state,
  });
  // State is opaque. Verifier and actor binding remain encrypted on the server.
  await repos.chatApps.challenge({
    id: fingerprint(state),
    connectionId: c.id,
    kind: "oauth",
    payload: encrypt(
      JSON.stringify({
        ...pair.value,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
        clientId: prepared.clientId,
        verifier: prepared.verifier,
        origin: c.origin,
      } satisfies Authorization),
    ),
    expiresAt: new Date(Date.now() + 600000),
  });
  return {
    clientId: prepared.clientId,
    consentCode: prepared.consentCode,
    state,
    organizationId: c.organizationId,
    connectionName: c.name,
  };
}
export async function completePairing(ctx: RequestContext, state: string, code: string) {
  const pending = await readChallenge<Authorization>(state, "oauth");
  await owned(ctx, pending.connectionId);
  if (pending.value.userId !== ctx.userId || pending.value.organizationId !== ctx.organizationId)
    throw fail("Use the account that started this connection.", 403);
  await enabled(pending.connectionId, pending.value.revision);
  await readChallenge(state, "oauth", true);
  const p = pending.value;
  const result = await mcpOAuthRequest(
    p.origin,
    "mcp/token",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: p.verifier,
      redirect_uri: `${p.origin}/api/chat-apps/callback`,
      client_id: p.clientId,
      resource: `${p.origin}/api/mcp`,
    }),
  );
  const token = typeof result.access_token === "string" ? result.access_token : "";
  const identity = token
    ? await resolveBearerIdentity(token, new Headers({ authorization: `Bearer ${token}` }))
    : null;
  if (!identity || identity.userId !== p.userId || identity.organizationId !== p.organizationId) {
    await repos.oauth.disconnectMcpClient(identity?.userId ?? p.userId, p.clientId);
    throw fail("Authorize the same account and workspace.", 403);
  }
  const verification = await challenge(pending.connectionId, "verify", {
    sender: p.sender,
    revision: p.revision,
    userId: p.userId,
    organizationId: p.organizationId,
    clientId: p.clientId,
    origin: p.origin,
  } satisfies Verify);
  return { verification, connectionName: (await owned(ctx, pending.connectionId)).name };
}
export async function verifyPairing(c: ChatAppConnection, sender: ChatSender, token: string) {
  const pending = await readChallenge<Verify>(token, "verify");
  const p = pending.value;
  if (
    pending.connectionId !== c.id ||
    senderKey(p.sender) !== senderKey(sender) ||
    p.revision !== c.revision
  )
    throw fail("Verify from the same chat account and conversation that requested the link.", 403);
  return createProvisionLock(`chat-identity:${c.id}:${senderKey(sender)}`).run(async () => {
    await enabled(c.id, c.revision);
    await mcpClientToken(p);
    if (await repos.chatApps.identity(c.id, sender.workspaceId, sender.userId))
      throw fail("This chat account is already linked. Use /openship unlink before linking again.");
    await readChallenge(token, "verify", true);
    const linked = await repos.chatApps.link({
      id: nonce(),
      connectionId: c.id,
      externalWorkspace: sender.workspaceId,
      externalUser: sender.userId,
      userId: p.userId,
      clientId: p.clientId,
    });
    if (!linked) throw fail("This chat account is already linked.");
    return "Your OpenShip account is connected. Try /openship projects. Commands use only your approved permissions.";
  });
}
export async function chatCredential(c: ChatAppConnection, sender: ChatSender) {
  const identity = await repos.chatApps.identity(c.id, sender.workspaceId, sender.userId);
  if (!identity) throw fail("Link your own OpenShip account first: /openship link", 403);
  const token = await mcpClientToken({
    ...identity,
    organizationId: c.organizationId,
    origin: c.origin,
  });
  return { identity, token };
}
export async function unlinkIdentity(identityId: string, userId: string) {
  const removed = await repos.chatApps.unlink(identityId, userId);
  if (removed) await repos.oauth.disconnectMcpClient(userId, removed.clientId);
}
