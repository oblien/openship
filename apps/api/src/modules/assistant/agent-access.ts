import { capabilityAction, isCapability, scopeIsSubset } from "@repo/core";
import { permitsAction } from "@repo/platform";
import { repos, type AssistantAgentRow, type AssistantOwner } from "@repo/db";
import { ASSISTANT_AGENT_RESOURCE_TYPES, type AssistantAgentConfig } from "@repo/contracts";
import { resolveExecutionAuthority } from "@repo/platform/engine/lib/execution-authority";
import { validateGrants } from "@repo/platform/engine/modules/tokens/token.service";
import type { RequestContext } from "../../lib/request-context";
import { assistantCredential, assistantError } from "./assistant-access";

export async function approvedAssistantContext(owner: AssistantOwner) {
  const access = await assistantCredential(owner);
  const ctx = await resolveExecutionAuthority(
    {
      version: 1,
      userId: owner.userId,
      organizationId: owner.organizationId,
      token: { id: access.identity.tokenId, kind: "oauth", scoped: access.identity.scoped },
      restrictions: {
        organizationId: owner.organizationId,
        readOnly: access.identity.readOnly,
        expiresAt: null,
      },
    },
    "assistant-agent",
  );
  return { access, ctx };
}

export async function validateAgentGrants(
  ctx: RequestContext,
  input: Pick<AssistantAgentConfig, "grants" | "readOnly">,
) {
  if (
    !input.grants.length ||
    input.grants.some(
      (g) =>
        !(ASSISTANT_AGENT_RESOURCE_TYPES as readonly string[]).includes(g.resourceType) ||
        !g.resourceId ||
        g.resourceId === "*" ||
        !g.permissions.length ||
        g.permissions.includes("create"),
    )
  )
    throw assistantError("Choose named resources and task permissions for this agent.", 400);
  const approved = await approvedAssistantContext(ctx);
  for (const principal of [ctx, approved.ctx]) {
    if (
      (!input.readOnly && principal.credential?.readOnly) ||
      (await validateGrants(principal, input.grants))
    )
      throw assistantError(
        "These permissions exceed your current workspace or assistant access.",
        403,
      );
  }
  return approved.access;
}

export async function ownedAgent(owner: AssistantOwner, id: string, revision?: number) {
  const row = await repos.assistantAgents.find(owner, id);
  if (!row) throw assistantError("Agent not found.", 404);
  const access = await assistantCredential(owner);
  if (
    row.archived ||
    row.clientId !== access.connection.clientId ||
    row.serverId !== access.connection.serverId ||
    (revision !== undefined && row.revision !== revision)
  )
    throw assistantError(
      "This agent changed or is unavailable. Review its settings before starting another task.",
      409,
    );
  const authority = await resolveExecutionAuthority(row.authority, `agent:${row.id}`);
  await validateAgentGrants(authority, row);
  return row;
}

/** The same coarse permissions, capabilities and repository path rules as normal access grants. */
export function agentContainsGrants(
  agent: Pick<AssistantAgentRow, "grants" | "readOnly">,
  grants: AssistantAgentConfig["grants"],
  write = false,
) {
  return (
    !(write && agent.readOnly) &&
    grants.every((g) => {
      const own = agent.grants.find(
        (a) => a.resourceType === g.resourceType && a.resourceId === g.resourceId,
      );
      if (
        !own ||
        !g.permissions.every(
          (p) =>
            own.permissions.includes(p) ||
            permitsAction(own.permissions, isCapability(p) ? capabilityAction(p) : p),
        )
      )
        return false;
      return (
        !g.scope ||
        (scopeIsSubset(g.scope.read?.paths ?? [], own.scope?.read?.paths ?? []) &&
          scopeIsSubset(g.scope.write?.paths ?? [], own.scope?.write?.paths ?? []))
      );
    })
  );
}
