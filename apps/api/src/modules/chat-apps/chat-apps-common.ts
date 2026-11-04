import { createHash, randomBytes } from "node:crypto";
import { AppError } from "@repo/core";
import { repos, type ChatAppConnection } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const nonce = () => randomBytes(24).toString("base64url");
export const fail = (message: string, status = 409) =>
  new AppError(message, status, "CHAT_APPS_ERROR");
export function session(ctx: RequestContext, admin = false) {
  if (ctx.principalKind || ctx.tokenScope || ctx.sessionKind === "bearer")
    throw fail("Use your OpenShip session to manage chat connections.", 403);
  if (admin && ctx.role !== "owner" && ctx.role !== "admin")
    throw fail("Only workspace admins can configure chat apps.", 403);
}
export async function owned(ctx: RequestContext, id: string, admin = false) {
  session(ctx, admin);
  const row = await repos.chatApps.get(id);
  if (!row || row.organizationId !== ctx.organizationId)
    throw fail("Chat connection not found.", 404);
  return row;
}
export interface ChatSender {
  workspaceId: string;
  userId: string;
  channelId: string;
  threadId?: string;
}
export const senderKey = (s: ChatSender) =>
  fingerprint([s.workspaceId, s.userId, s.channelId, s.threadId ?? ""]);
export async function challenge(connectionId: string, kind: string, payload: unknown, minutes = 5) {
  const token = nonce();
  await repos.chatApps.challenge({
    id: fingerprint(token),
    connectionId,
    kind,
    payload: encrypt(JSON.stringify(payload)),
    expiresAt: new Date(Date.now() + minutes * 60000),
  });
  return token;
}
export async function readChallenge<T>(token: string, kind: string, consume = false) {
  const row = await repos.chatApps.readChallenge(fingerprint(token), consume);
  if (!row || row.kind !== kind)
    throw fail("This request expired or has already been used. Start again.", 400);
  return { connectionId: row.connectionId, value: JSON.parse(decrypt(row.payload)) as T };
}
export async function enabled(id: string, revision?: number): Promise<ChatAppConnection> {
  const c = await repos.chatApps.get(id);
  if (!c?.enabled || !c.nativeId || (revision !== undefined && c.revision !== revision))
    throw fail("This chat connection is disabled or changed.", 403);
  return c;
}
