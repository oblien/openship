import { repos, type AssistantRow, type AssistantOwner } from "@repo/db";
import { decrypt, encrypt } from "@repo/platform/engine/lib/encryption";
import { resolveExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import {
  createExecutionToken,
  validateGrants,
} from "@repo/platform/engine/modules/tokens/token.service";
import type { RequestContext } from "../../lib/request-context";
import { assistantCredential, assistantError } from "./assistant-access";
import { ownedAgent, validateAgentGrants } from "./agent-access";
import { automationGrants } from "./automation-access";

/** A continued investigation remains read-only and scoped to its original app. */
export async function taskScope(owner: AssistantOwner, row: AssistantRow) {
  const access = await assistantCredential(owner, row);
  const authority = row.authority
    ? await resolveExecutionAuthority(row.authority, `assistant-task:${row.id}`)
    : null;
  if (row.agentId) {
    const agent = await ownedAgent(owner, row.agentId, row.agentRevision ?? undefined);
    if (!authority) throw assistantError("This task has no execution authority.", 403);
    await validateAgentGrants(authority, agent);
    if (!row.automationRunId)
      return { access, authority, grants: agent.grants, readOnly: agent.readOnly };
  }
  if (row.automationRunId) {
    const run = await repos.assistantAutomations.run(owner, row.automationRunId);
    const rule = run && (await repos.assistantAutomations.find(owner, run.automationId));
    if (
      !run ||
      !rule ||
      run.conversationId !== row.id ||
      !["reported", "succeeded", "failed", "skipped", "cancelled"].includes(run.state)
    )
      throw assistantError("Wait for this automation to finish before starting a follow-up.", 409);
    const ctx =
      authority ?? (await resolveExecutionAuthority(rule.authority, `automation-chat:${row.id}`));
    const grants = await automationGrants(ctx, run.projectId, [], rule.readRepository, row.agentId);
    return { access, authority: ctx, grants, readOnly: true };
  }
  throw assistantError("This conversation is not a scoped task.", 400);
}

export async function prepareTaskAccess(ctx: RequestContext, row: AssistantRow) {
  const scope = await taskScope(ctx, row);
  if ((!scope.readOnly && ctx.credential?.readOnly) || (await validateGrants(ctx, scope.grants)))
    throw assistantError("This task exceeds the initiating connection's access.", 403);
  const token = await createExecutionToken(scope.authority, {
    name: `Assistant task: ${row.id}`,
    readOnly: scope.readOnly,
    grants: scope.grants,
  });
  const previous = row.executionTokenId;
  const saved = await repos.assistant.executionToken(ctx, row.id, {
    executionTokenId: token.id,
    executionToken: encrypt(token.token),
  });
  if (!saved) {
    await repos.personalAccessToken.revoke(token.id, ctx.userId);
    throw assistantError(
      "This task changed before access was issued. Start a new task with the current agent.",
      409,
    );
  }
  if (previous) await repos.personalAccessToken.revoke(previous, ctx.userId);
  return saved;
}

export async function taskCredential(owner: AssistantOwner, row: AssistantRow) {
  const scope = await taskScope(owner, row);
  const current = await repos.assistant.find(owner, row.id);
  const token =
    current?.executionTokenId &&
    (await repos.personalAccessToken.findById(current.executionTokenId));
  if (
    !token ||
    !current?.executionToken ||
    !token.scoped ||
    token.revokedAt ||
    token.userId !== owner.userId ||
    token.organizationId !== owner.organizationId ||
    !token.expiresAt ||
    token.expiresAt.getTime() <= Date.now() ||
    (scope.readOnly && !token.readOnly)
  )
    throw assistantError("This task's access expired. Send a new message to continue.", 403);
  return { ...scope.access, token: decrypt(current.executionToken) };
}

/** Compare-and-clear prevents a late completion from revoking a later turn's token. */
export async function releaseTaskAccess(owner: AssistantOwner, row: AssistantRow) {
  if (!row.executionTokenId) return;
  const cleared = await repos.assistant.clearExecutionToken(owner, row.id, row.executionTokenId);
  if (cleared) await repos.personalAccessToken.revoke(row.executionTokenId, owner.userId);
}
