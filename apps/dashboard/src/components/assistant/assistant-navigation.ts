import type { AssistantAutomationConfig } from "@repo/contracts";

type AgentView = {
  kind: "agent";
  id?: string;
  editing: boolean;
  template?: string;
  project?: string;
};
type AutomationView = {
  kind: "automation";
  id?: string;
  trigger: AssistantAutomationConfig["trigger"];
  agentId?: string;
};
export type AssistantDrawerView = AgentView | AutomationView;

const agentParams = ["agents", "agent-template", "agent-project"];
const automationParams = ["automation-editor", "automation-trigger", "automation-agent"];

/** Shareable editor URLs open in place without replacing a chat or flow draft. */
export function assistantDrawerHref(href: string, pathname = "/assistant", search = "") {
  const agent = /^\/assistant\/agents(?:\/([^/?#]+)(\/edit)?)?(?:\?([^#]*))?$/.exec(href);
  const automation = /^\/assistant\/automations\/(new|[^/?#]+\/edit)(?:\?([^#]*))?$/.exec(href);
  if (!agent && !automation) return href;
  const params = new URLSearchParams(search);
  for (const key of agentParams) params.delete(key);
  if (agent) {
    const options = new URLSearchParams(agent[3]);
    params.set("agents", agent[1] ? `${agent[1]}${agent[2] ?? ""}` : "all");
    for (const key of ["template", "project"]) {
      const value = options.get(key);
      if (value) params.set(`agent-${key}`, value);
    }
  } else if (automation) {
    // Starting a flow from agent details replaces that view. Opening an agent
    // from a flow keeps the flow underneath, including its unfinished form.
    for (const key of automationParams) params.delete(key);
    const options = new URLSearchParams(automation[2]);
    params.set("automation-editor", automation[1]);
    for (const key of ["trigger", "agent"]) {
      const value = options.get(key);
      if (value) params.set(`automation-${key}`, value);
    }
  }
  return `${pathname}?${params}`;
}

/** Dismiss only the active view; an agent opened from a flow returns to its draft. */
export function closeAssistantDrawerHref(pathname: string, search: string) {
  const params = new URLSearchParams(search);
  for (const key of params.has("agents") ? agentParams : automationParams) params.delete(key);
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

export function assistantDrawerViews(search: string): AssistantDrawerView[] {
  const params = new URLSearchParams(search);
  const views: AssistantDrawerView[] = [];
  const automation = params.get("automation-editor");
  if (automation && (automation === "new" || /^[^/]+\/edit$/.test(automation))) {
    views.push({
      kind: "automation",
      id: automation === "new" ? undefined : automation.split("/")[0],
      trigger:
        params.get("automation-trigger") === "service.unhealthy"
          ? "service.unhealthy"
          : "deployment.failed",
      agentId: params.get("automation-agent") ?? undefined,
    });
  }
  const agent = params.get("agents");
  if (agent) {
    const [id, action] = agent.split("/");
    views.push({
      kind: "agent",
      id: id === "all" || id === "new" ? undefined : id,
      editing: id === "new" || action === "edit",
      template: params.get("agent-template") ?? undefined,
      project: params.get("agent-project") ?? undefined,
    });
  }
  return views;
}
