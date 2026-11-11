import { repos, type AssistantOwner, type AssistantRow } from "@repo/db";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { ownedAgent } from "./agent-access";
import { taskCredential } from "./task-access";
import { assistantCredential, assistantError } from "./assistant-access";
import { validateChatConversation } from "../chat-apps/chat-assistant-access";

/** All entry points share Assistant authorization. Chat also rechecks its sender binding;
 * automation investigations substitute an expiring, read-only scoped PAT. */
export async function assistantExecutionCredential(
  owner: AssistantOwner,
  row: AssistantRow,
  refresh = true,
) {
  if (row.agentId) await ownedAgent(owner, row.agentId, row.agentRevision ?? undefined);
  const access = row.chatThreadId
    ? (await validateChatConversation(owner, row, refresh)).access
    : await assistantCredential(owner, row, refresh);
  if (!row.automationRunId) return row.agentId ? taskCredential(owner, row) : access;
  const run = await repos.assistantAutomations.run(owner, row.automationRunId);
  if (run && ["reported", "succeeded", "failed", "skipped", "cancelled"].includes(run.state))
    return taskCredential(owner, row);
  const rule = run && (await repos.assistantAutomations.find(owner, run.automationId));
  const settings = await repos.assistantAutomations.settings(owner);
  const pat = run?.tokenId && (await repos.personalAccessToken.findById(run.tokenId));
  if (
    !run ||
    !rule?.enabled ||
    rule.accessFingerprint !== access.fingerprint ||
    settings?.paused ||
    rule.revision !== run.revision ||
    run.state !== "investigating" ||
    run.conversationId !== row.id ||
    !run.token ||
    !run.expiresAt ||
    run.expiresAt.getTime() <= Date.now() ||
    !pat ||
    !pat.scoped ||
    !pat.readOnly ||
    pat.userId !== owner.userId ||
    pat.organizationId !== owner.organizationId ||
    pat.revokedAt ||
    !pat.expiresAt ||
    pat.expiresAt.getTime() <= Date.now()
  )
    throw assistantError("This automation is paused, expired, or no longer authorized.", 403);
  return { ...access, token: decrypt(run.token) };
}
