import {
  repos,
  type AssistantOwner,
  type AssistantRow,
  type ChatAppConnection,
  type ChatAppIdentity,
} from "@repo/db";
import { resolveExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import { mcpClientToken } from "../mcp/mcp-client-authorization";
import { assistantCredential } from "../assistant/assistant-access";
import { enabled, fail } from "./chat-apps-common";

/** Chat verifies the sender; the person's separately approved Assistant grant controls tools.
 * No bot owner's model connection or credential is ever lent to another sender. */
export async function chatAssistantAccess(
  c: ChatAppConnection,
  identity: ChatAppIdentity,
  refresh = true,
  expected?: Pick<AssistantRow, "clientId" | "accessFingerprint">,
) {
  await enabled(c.id, c.revision);
  if (
    !c.assistantAllowed ||
    c.purpose === "commands" ||
    identity.connectionId !== c.id ||
    !identity.assistantProvider ||
    !identity.assistantAuthority
  )
    throw fail(
      "Enable your assistant for this connection in OpenShip → Settings → Chat apps.",
      403,
    );
  if (
    identity.assistantAuthority.userId !== identity.userId ||
    identity.assistantAuthority.organizationId !== c.organizationId
  )
    throw fail("Your assistant connection is no longer valid.", 403);
  await mcpClientToken(
    { ...identity, organizationId: c.organizationId, origin: c.origin },
    refresh,
  );
  const ctx = await resolveExecutionAuthority(
    identity.assistantAuthority,
    `chat-assistant:${identity.id}`,
  );
  const access = await assistantCredential(ctx, expected, refresh);
  if (identity.assistantFingerprint !== access.fingerprint)
    throw fail(
      "Assistant access changed. Review and reconnect your assistant in Settings → Chat apps.",
      403,
    );
  return { ctx, access };
}

/** Rechecked by the ordinary runtime before starting, before local MCP calls and by its watchdog. */
export async function validateChatConversation(
  owner: AssistantOwner,
  row: Pick<AssistantRow, "id" | "chatThreadId"> &
    Partial<Pick<AssistantRow, "clientId" | "accessFingerprint">>,
  refresh = true,
) {
  const thread = row.chatThreadId && (await repos.chatApps.thread(row.chatThreadId));
  const identity = thread && (await repos.chatApps.identityById(thread.identityId));
  const c = identity && (await repos.chatApps.get(identity.connectionId));
  if (
    !thread ||
    !identity ||
    !c ||
    thread.conversationId !== row.id ||
    identity.userId !== owner.userId ||
    c.organizationId !== owner.organizationId ||
    thread.connectionRevision !== c.revision ||
    thread.identityRevision !== identity.assistantRevision
  )
    throw fail(
      "This chat conversation changed or was disconnected. Start a new conversation from your chat app.",
      403,
    );
  const { access } = await chatAssistantAccess(
    c,
    identity,
    refresh,
    row.clientId && row.accessFingerprint
      ? { clientId: row.clientId, accessFingerprint: row.accessFingerprint }
      : undefined,
  );
  return { thread, identity, connection: c, access };
}
