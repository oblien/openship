import {
  CHAT_APP_PROVIDERS,
  CHAT_APP_PURPOSES,
  CHAT_APP_PROVIDER_NAMES,
  ASSISTANT_AGENT_ICONS,
  type AssistantAgentIcon,
  type ChatAppSetup,
  type AssistantPart,
} from "@repo/contracts";
import { readAutomationFlow, type AutomationFlowSummary } from "./automation-flow";
import type { IconName } from "@repo/ui/icons";
import { encodeRepoSlug } from "@/utils/repoSlug";
import { openshipToolName, outputLabel, outputRecord, parseToolOutput } from "./tool-output";

export type AssistantTool = NonNullable<AssistantPart["tool"]>;
export type ToolState = "running" | "completed" | "failed" | "stopped";
export type ResultTone = "neutral" | "info" | "danger";
export interface ToolResource {
  id: string;
  title: string;
  description?: string;
  status?: string;
  tone?: ResultTone;
  href?: string;
  action?: string;
  agentIcon?: AssistantAgentIcon;
  automation?: AutomationFlowSummary;
  setup?: Pick<ChatAppSetup, "provider" | "purpose" | "transport" | "organizationId">;
}
export interface ToolResultView {
  kind?: "automations";
  title: string;
  icon: IconName;
  items: ToolResource[];
  total: number;
  empty: string;
  note?: string;
}

const definitions: Record<string, { title: string; icon: IconName }> = {
  get_assistant_agents: { title: "Find specialists", icon: "assistant" },
  get_assistant_agents_by_id: { title: "Inspect agent", icon: "assistant" },
  post_assistant_agents: { title: "Create specialist", icon: "assistant" },
  put_assistant_agents_by_id: { title: "Update agent", icon: "assistant" },
  post_assistant_agents_by_id_tasks: { title: "Assign task", icon: "assistant" },
  get_assistant_agents_by_id_tasks_by_chatId: { title: "Inspect task", icon: "message" },
  post_assistant_agents_by_id_tasks_by_chatId_messages: { title: "Continue task", icon: "message" },
  get_assistant_automations: { title: "Find automations", icon: "workflow" },
  post_assistant_automations: { title: "Create automation", icon: "workflow" },
  put_assistant_automations_by_id: { title: "Update automation", icon: "workflow" },
  get_projects: { title: "Find apps", icon: "folder" },
  get_projects_by_id: { title: "View app", icon: "folder" },
  post_projects: { title: "Create app", icon: "folder-plus" },
  post_projects_ensure: { title: "Prepare app", icon: "folder-plus" },
  get_system_servers: { title: "Find servers", icon: "server" },
  get_system_servers_by_id: { title: "View server", icon: "server" },
  get_deployments: { title: "Check deployments", icon: "rocket" },
  get_deployments_by_id: { title: "View deployment", icon: "rocket" },
  post_deployments: { title: "Deploy app", icon: "rocket" },
  get_github_home: { title: "Browse GitHub", icon: "github" },
  get_github_repos: { title: "Find repositories", icon: "github" },
  get_github_orgs_by_org_repos: { title: "Find repositories", icon: "github" },
  get_github_repos_by_owner_by_repo: { title: "View repository", icon: "github" },
  get_projects_by_id_services: { title: "Check services", icon: "layers" },
  get_system_diagnostics: { title: "Check instance health", icon: "activity" },
  get_permissions_workspaces: { title: "Find workspaces", icon: "folder-tree" },
  get_mcp_guide: { title: "Read platform guide", icon: "book" },
  get_chat_apps: { title: "Check chat connections", icon: "message" },
  get_chat_apps_setup: { title: "Prepare chat connection", icon: "message" },
  post_deployments_build_access: { title: "Deploy app", icon: "rocket" },
  post_deployments_by_id_redeploy: { title: "Redeploy app", icon: "rocket" },
  post_deployments_by_id_restart: { title: "Restart app", icon: "refresh" },
  post_deployments_by_id_rollback: { title: "Roll back deployment", icon: "history" },
};

/** Only MCP tool identity selects a renderer; prose and action titles are never instructions. */
export function assistantToolName(tool: AssistantTool): string {
  const mcp = tool.action?.kind === "mcp" ? tool.action.mcp : undefined;
  if (mcp?.server && mcp.server !== "openship")
    return `${mcp.server}.${mcp.tool ?? tool.name ?? ""}`;
  return openshipToolName(
    mcp?.tool && (!mcp.server || mcp.server === "openship") ? mcp.tool : (tool.name ?? ""),
  );
}
export function describeAssistantTool(tool: AssistantTool): { title: string; icon: IconName } {
  const name = assistantToolName(tool);
  if (name === "exec")
    return {
      title:
        typeof tool.input === "string" && tool.input.includes("ALL_TOOLS")
          ? "Discover available tools"
          : "Run tool workflow",
      icon: "search",
    };
  if (name === "wait") return { title: "Wait for tool results", icon: "clock" };
  return (
    definitions[name] ?? {
      title: outputLabel(name.replace(/_by_[^_]+/g, "")) || "OpenShip tool",
      icon: name.includes("logs") ? "terminal" : name.includes("permission") ? "shield" : "code",
    }
  );
}
export function assistantToolState(tool: AssistantTool, active: boolean): ToolState {
  // Newer native daemons include a terminal outcome. Older SDK transcripts omit it.
  const status = outputRecord(tool)?.status;
  if (tool.isError || status === "failed" || parseToolOutput(tool.output).isError) return "failed";
  if (status === "cancelled" || status === "incomplete") return "stopped";
  if (tool.output !== undefined) return "completed";
  return active ? "running" : "stopped";
}
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
const segment = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value) ? value : undefined;
const join = (...values: unknown[]) => values.map(text).filter(Boolean).join(" · ") || undefined;
const records = (value: unknown, key = "data"): Record<string, unknown>[] | null => {
  const items = Array.isArray(value) ? value : outputRecord(value)?.[key];
  return Array.isArray(items) ? items.map(outputRecord).filter((v) => !!v) : null;
};
const single = (value: unknown) => {
  const item = outputRecord(value);
  return item ? [item] : null;
};
const statusTone = (status: unknown): ResultTone =>
  typeof status !== "string"
    ? "neutral"
    : /^(failed|unhealthy|error|partial_failure)$/.test(status)
      ? "danger"
      : /^(building|deploying|pending|running|reconciling|action_required)$/.test(status)
        ? "info"
        : "neutral";

/** Presentation only. All links are constructed here from known result identities.
 * Opening an import resumes the normal wizard; no output can supply a command or executable action. */
export function presentToolResult(tool: AssistantTool): ToolResultView | null {
  const parsed = parseToolOutput(tool.output);
  if (assistantToolState(tool, false) !== "completed") return null;
  const value = parsed.value,
    record = outputRecord(value),
    name = assistantToolName(tool);
  let rows: Record<string, unknown>[] | null = null;
  let title = "",
    icon: IconName = "folder",
    empty = "No items returned.",
    note: string | undefined;
  let map: (row: Record<string, unknown>) => ToolResource | null;
  switch (name) {
    case "get_assistant_agents":
    case "get_assistant_agents_by_id":
    case "post_assistant_agents":
    case "put_assistant_agents_by_id":
      rows = name === "get_assistant_agents" ? records(value) : single(value);
      title = "Agents";
      icon = "bot";
      empty = "No specialists in this result.";
      map = (row) => {
        const id = segment(row.id),
          label = text(row.name);
        return id && label
          ? {
              id,
              title: label,
              agentIcon: ASSISTANT_AGENT_ICONS.find((item) => item.id === row.icon)?.id ?? "bot",
              description: text(row.purpose),
              status: row.archived ? "Archived" : row.readOnly ? "Read-only" : "Scoped actions",
              href: `/assistant/agents/${id}`,
              action: "View agent",
            }
          : null;
      };
      break;
    case "post_assistant_agents_by_id_tasks":
    case "get_assistant_agents_by_id_tasks_by_chatId": {
      const conversation = outputRecord(record?.conversation),
        activity = outputRecord(record?.activity);
      const id = segment(conversation?.id);
      if (!id) return null;
      return {
        title: "Agent task",
        icon: "assistant",
        empty,
        total: 1,
        items: [
          {
            id,
            title: text(conversation?.title) ?? "Task conversation",
            status: outputLabel(text(activity?.state) ?? "Unknown"),
            tone: statusTone(activity?.state),
            href: `/assistant?chat=${id}`,
            action: "Open conversation",
          },
        ],
        note: "Follow the work and send instructions in the same conversation.",
      };
    }
    case "get_assistant_automations":
    case "post_assistant_automations":
    case "put_assistant_automations_by_id":
      rows = name === "get_assistant_automations" ? records(value, "automations") : single(value);
      title = "Automations";
      icon = "workflow";
      empty = "No automations in this result.";
      map = (row) => {
        const id = segment(row.id);
        return id
          ? {
              id,
              title: text(row.name) ?? `Automation ${id.slice(0, 8)}`,
              automation: readAutomationFlow(row),
              description: text(row.projectName),
              status:
                row.enabled === true ? "Enabled" : row.enabled === false ? "Paused" : undefined,
              href: `/assistant/automations/${id}/edit`,
              action: "Review flow",
            }
          : null;
      };
      break;
    case "get_chat_apps_setup": {
      const provider = record?.provider as ChatAppSetup["provider"];
      const purpose = record?.purpose as ChatAppSetup["purpose"];
      const transport = record?.transport as ChatAppSetup["transport"];
      const organizationId = segment(record?.organizationId);
      if (
        record?.kind !== "chat-app-setup" ||
        record.created !== false ||
        !organizationId ||
        !CHAT_APP_PROVIDERS.includes(provider) ||
        !CHAT_APP_PURPOSES.includes(purpose) ||
        !["outbound", "webhook"].includes(transport) ||
        (provider === "teams" && transport !== "webhook")
      )
        return null;
      return {
        title: "Connect a chat app",
        icon: "message",
        empty,
        total: 1,
        items: [
          {
            id: provider,
            title: CHAT_APP_PROVIDER_NAMES[provider],
            description: `${purpose === "commands" ? "Deployment commands" : purpose === "assistant" ? "Assistant" : "Assistant & commands"} · ${transport === "outbound" ? "No public URL needed" : "Public HTTPS endpoint"}`,
            status: "Ready to configure",
            action: `Connect ${CHAT_APP_PROVIDER_NAMES[provider]}`,
            setup: { provider, purpose, transport, organizationId },
          },
        ],
        note: "Enter credentials in the connection form. New connections start paused.",
      };
    }
    case "get_chat_apps":
      title = "Chat connections";
      icon = "message";
      empty = "No chat apps connected in this workspace yet.";
      rows = records(value, "connections");
      map = (row) => {
        const id = segment(row.id),
          label = text(row.name);
        if (!id || !label || !CHAT_APP_PROVIDERS.includes(row.provider as ChatAppSetup["provider"]))
          return null;
        const receiver = outputRecord(row.receiver);
        return {
          id,
          title: label,
          description: join(
            row.provider,
            row.linked === true ? "Account linked" : "Account not linked",
          ),
          status:
            row.enabled === false ? "Paused" : outputLabel(text(receiver?.state) ?? "Unknown"),
          tone: receiver?.state === "error" ? "danger" : "neutral",
          href: "/settings?tab=chat-apps",
          action: "View connection",
        };
      };
      break;
    case "get_projects":
    case "get_projects_by_id":
    case "post_projects":
      rows = name === "get_projects" ? records(value) : single(value);
      title = "Apps";
      icon = "folder";
      empty = "No apps in this result.";
      map = (row) => {
        const id = segment(row.id),
          label = text(row.name);
        if (!id || !label) return null;
        return {
          id,
          title: label,
          description: join(row.framework, row.gitBranch, row.environmentName),
          ...(row.runtimeUnhealthy === true
            ? { status: "Incident reported", tone: "danger" as const }
            : {}),
          href: `/projects/${id}`,
          action: "View app",
        };
      };
      break;
    case "post_projects_ensure": {
      const id = segment(record?.project_id);
      if (!id) return null;
      return {
        title: "App ready",
        icon: "folder-plus",
        empty,
        total: 1,
        items: [
          {
            id,
            title: text(outputRecord(outputRecord(tool.input)?.body)?.name) ?? "Prepared app",
            href: `/projects/${id}`,
            action: "View app",
            status: record?.created === true ? "Created" : "Updated",
          },
        ],
      };
    }
    case "get_system_servers":
    case "get_system_servers_by_id":
      rows = name === "get_system_servers" ? records(value) : single(value);
      title = "Servers";
      icon = "server";
      empty = "No servers in this result.";
      map = (row) => {
        const id = segment(row.id);
        if (!id) return null;
        const channel = outputRecord(row.hostChannel);
        return {
          id,
          title: text(row.name) ?? (row.isLocal === true ? "This computer" : "Server"),
          description: join(
            row.connection,
            typeof row.projectCount === "number" ? `${row.projectCount} apps` : undefined,
          ),
          ...(typeof channel?.ok === "boolean"
            ? {
                status: channel.ok ? "Connected" : "Connection issue",
                tone: channel.ok ? ("neutral" as const) : ("danger" as const),
              }
            : {}),
          href: `/servers/${id}`,
          action: "View server",
        };
      };
      break;
    case "get_deployments":
    case "get_deployments_by_id":
    case "post_deployments":
    case "post_deployments_build_access":
    case "post_deployments_by_id_redeploy":
    case "post_deployments_by_id_rollback":
    case "post_deployments_by_id_restart":
      title = "Deployments";
      icon = "rocket";
      empty = "No deployments in this result.";
      if (name.startsWith("post_")) {
        if (record?.awaiting_actions === true) {
          const id = segment(record.action_request_id);
          if (!id) return null;
          return {
            title: "Deployment needs review",
            icon: "shield",
            empty,
            total: 1,
            items: [
              {
                id,
                title: "Review the deployment decision",
                status: "Waiting for approval",
                tone: "info",
                href: "/actions",
                action: "Review action",
              },
            ],
            note: "The deployment is waiting for your decision. No approval was given by this tool.",
          };
        }
        rows = single(
          record?.deployment ??
            (record?.deployment_id
              ? {
                  id: record.deployment_id,
                  projectId: record.project_id,
                  status: record.skipped ? "no_changes" : "pending",
                }
              : record),
        );
      } else rows = name === "get_deployments" ? records(value) : single(value);
      map = (row) => {
        const id = segment(row.id);
        if (!id) return null;
        return {
          id,
          title: text(row.projectName) ?? text(row.commitMessage) ?? "Deployment",
          description: join(row.branch, text(row.commitSha)?.slice(0, 7)),
          status:
            name === "post_deployments_by_id_restart"
              ? "Restarted"
              : text(row.status)
                ? outputLabel(row.status as string)
                : undefined,
          tone: statusTone(row.status),
          href: `/build/${id}`,
          action: "View deployment",
        };
      };
      note =
        name === "post_deployments_by_id_restart"
          ? "The restart command completed. Check the app’s health to confirm recovery."
          : "Status when the tool ran. Open a deployment for live progress.";
      break;
    case "get_github_home":
    case "get_github_repos":
    case "get_github_orgs_by_org_repos":
    case "get_github_repos_by_owner_by_repo":
      title = "Repositories";
      icon = "github";
      empty = "No repositories in this result.";
      rows =
        name === "get_github_repos_by_owner_by_repo"
          ? single(value)
          : records(value, name === "get_github_home" ? "repos" : "data");
      note = "Import opens the setup flow so you can review before deploying.";
      map = (row) => {
        const fullName = text(row.full_name),
          parts = fullName?.split("/");
        if (!parts || parts.length !== 2) return null;
        const [owner, repo] = parts as [string, string];
        if (
          !/^[a-zA-Z0-9-]{1,100}$/.test(owner) ||
          !/^[a-zA-Z0-9_.-]{1,100}$/.test(repo) ||
          repo === "." ||
          repo === ".."
        )
          return null;
        return {
          id: fullName!,
          title: fullName!,
          description: join(row.language, row.default_branch),
          status: row.private === true ? "Private" : row.private === false ? "Public" : undefined,
          href: `/deploy/${encodeRepoSlug(owner, repo)}`,
          action: "Import",
        };
      };
      break;
    case "get_projects_by_id_services":
      title = "Services";
      icon = "layers";
      empty = "No services in this result.";
      rows = records(value);
      map = (row) => {
        const id = segment(row.id),
          project = segment(row.projectId),
          label = text(row.name);
        if (!id || !label) return null;
        return {
          id,
          title: label,
          description: join(row.image, row.framework),
          ...(project ? { href: `/projects/${project}`, action: "View app" } : {}),
        };
      };
      break;
    default:
      return null;
  }
  if (!rows) return null;
  const items = rows.map(map).filter((item): item is ToolResource => item !== null);
  // A malformed response is not a valid empty list; keep it available in the raw inspector.
  if (items.length !== rows.length) return null;
  return {
    ...(title === "Automations" ? { kind: "automations" as const } : {}),
    title,
    icon,
    items,
    total:
      typeof record?.total === "number" &&
      Number.isSafeInteger(record.total) &&
      record.total >= items.length
        ? record.total
        : items.length,
    empty,
    note,
  };
}
