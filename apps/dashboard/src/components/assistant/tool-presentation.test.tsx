import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantToolResources } from "./AssistantToolResources";
import { AssistantToolActivity } from "./AssistantToolActivity";
import { AssistantAccessRequest, permissionRequest } from "./AssistantAccessRequest";
import {
  assistantToolState,
  describeAssistantTool,
  presentToolResult,
  type AssistantTool,
} from "./tool-presentation";
import { decodeSlug } from "@/utils/repoSlug";
import { chatAppSetup } from "@repo/contracts";

const tool = (name: string, data: unknown): AssistantTool => ({
  id: "call",
  name,
  input: {},
  output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(data) }] }),
});
const repo = {
  full_name: "openship/web",
  name: "web",
  owner: "openship",
  private: true,
  language: "TypeScript",
  default_branch: "main",
  html_url: "https://untrusted.test",
  avatar_url: "https://untrusted.test/tracker",
};

describe("OpenShip tool result presentation", () => {
  it("shows native actions once while keeping every deployment result visible", () => {
    const deploy = (id: string): AssistantTool => ({
      ...tool("post_deployments_build_access", { success: true, deployment_id: id }),
      id,
      action: { kind: "mcp", mcp: { server: "openship", tool: "post_deployments_build_access" } },
    });
    const html = renderToStaticMarkup(
      <AssistantToolActivity
        active={false}
        parts={[
          { type: "tool", tool: { ...tool("exec", []), input: "text(ALL_TOOLS);" } },
          { type: "tool", tool: { ...tool("exec", []), input: "await tools.deploy();" } },
          { type: "tool", tool: deploy("deploy-a") },
          { type: "tool", tool: deploy("deploy-b") },
        ]}
      />,
    );
    expect(html).toContain("Discover available tools · Completed");
    expect(html).toContain("Deploy app · Completed · 2 calls");
    expect(html).not.toContain("Run tool workflow");
    expect(html).toContain('href="/build/deploy-a"');
    expect(html).toContain('href="/build/deploy-b"');
  });
  it("renders paginated MCP app results and never infers live health from deployment existence", () => {
    const view = presentToolResult(
      tool("mcp__openship__get_projects", {
        data: [{ id: "app-1", name: "Web", activeDeploymentId: "release-1", framework: "nextjs" }],
        page: 1,
        total: 8,
      }),
    );
    expect(view?.total).toBe(8);
    expect(view?.items[0]).toMatchObject({ href: "/projects/app-1", title: "Web" });
    expect(view?.items[0].status).toBeUndefined();
  });
  it("uses native MCP identity across agent adapters, never a model-supplied title", () => {
    const call = tool("mcp_tool_call", { data: [repo], total: 1 });
    call.action = {
      kind: "mcp",
      title: "Do anything",
      mcp: { server: "openship", tool: "get_github_repos" },
    };
    expect(describeAssistantTool(call).title).toBe("Find repositories");
    expect(presentToolResult(call)?.items).toHaveLength(1);
    call.action.mcp!.server = "other-server";
    expect(presentToolResult(call)).toBeNull();
    expect(
      presentToolResult(tool("other_tool", { ...repo, action: "get_github_repos" })),
    ).toBeNull();
  });
  it("offers only the existing import wizard and ignores result-supplied actions and remote assets", () => {
    const call = tool("get_github_repos", {
      data: [{ ...repo, action: { command: "deploy now" }, href: "javascript:alert(1)" }],
      total: 1,
    });
    const view = presentToolResult(call)!;
    expect(decodeSlug(view.items[0].href!.slice("/deploy/".length))).toEqual({
      kind: "repo",
      owner: "openship",
      repo: "web",
    });
    const html = renderToStaticMarkup(<AssistantToolResources view={view} />);
    expect(html).toContain("Import");
    expect(html).not.toContain("untrusted.test");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("deploy now");
  });
  it("does not make navigation from malformed identifiers or non-resource output", () => {
    for (const id of [
      "..",
      "../settings",
      "%2e%2e",
      "//evil.test",
      "x?admin=true",
      "<script>",
      "x\\y",
    ])
      expect(presentToolResult(tool("get_projects", { data: [{ id, name: "Fake" }] }))).toBeNull();
    for (const full_name of [
      "../..",
      "owner/../repo",
      "owner/repo?key=x",
      "https://evil.test/repo",
    ])
      expect(
        presentToolResult(tool("get_github_repos", { data: [{ ...repo, full_name }] })),
      ).toBeNull();
    expect(presentToolResult(tool("get_projects", { error: "unknown" }))).toBeNull();
  });
  it("preserves failed, stopped and running states and cannot render success cards for them", () => {
    const call = tool("get_projects", { data: [{ id: "a", name: "App" }] });
    expect(assistantToolState({ ...call, output: undefined }, true)).toBe("running");
    expect(assistantToolState({ ...call, output: undefined }, false)).toBe("stopped");
    for (const status of ["cancelled", "incomplete", "failed"]) {
      const terminal = { ...call, status };
      expect(presentToolResult(terminal)).toBeNull();
    }
    const failed = tool("get_projects", {
      isError: true,
      structuredContent: { data: [{ id: "a", name: "App" }] },
    });
    expect(assistantToolState(failed, false)).toBe("failed");
    expect(presentToolResult(failed)).toBeNull();
  });
  it("links accepted deployments to live progress without claiming success", () => {
    const view = presentToolResult(
      tool("post_deployments", { data: { deployment_id: "d1", project_id: "p1" } }),
    );
    expect(view?.items[0]).toMatchObject({ href: "/build/d1", status: "Pending" });
    expect(
      presentToolResult(
        tool("post_deployments", {
          data: { awaiting_actions: true, project_id: "p1", action_request_id: "a1" },
        }),
      ),
    ).toMatchObject({ items: [{ href: "/actions", status: "Waiting for approval" }] });
  });
  it("uses the actual build, redeploy, restart and rollback tool results", () => {
    for (const name of ["post_deployments_build_access", "post_deployments_by_id_redeploy"])
      expect(
        presentToolResult(tool(name, { success: true, deployment_id: "d1", project_id: "p1" }))
          ?.items[0],
      ).toMatchObject({ href: "/build/d1", status: "Pending" });
    const restarted = presentToolResult(
      tool("post_deployments_by_id_restart", {
        data: { id: "d1", projectId: "p1", status: "ready" },
      }),
    );
    expect(restarted?.items[0]).toMatchObject({ href: "/build/d1", status: "Restarted" });
    expect(restarted?.note).toContain("confirm recovery");
    expect(
      presentToolResult(
        tool("post_deployments_by_id_rollback", { data: { id: "d1", status: "ready" } }),
      )?.items[0].status,
    ).toBe("Ready");
  });
  it("offers only validated chat setup results, ignoring output-supplied navigation or commands", () => {
    const result = {
      ...chatAppSetup("slack", "commands"),
      organizationId: "workspace",
      setupPath: "javascript:alert(1)",
      guideUrl: "https://untrusted.test",
    };
    const view = presentToolResult(tool("get_chat_apps_setup", { data: result }));
    expect(view?.items[0]).toMatchObject({
      title: "Slack",
      status: "Ready to configure",
      setup: {
        provider: "slack",
        purpose: "commands",
        transport: "outbound",
        organizationId: "workspace",
      },
    });
    const html = renderToStaticMarkup(<AssistantToolResources view={view!} />);
    expect(html).toContain("Connect Slack");
    expect(html).not.toMatch(/javascript:|untrusted.test/);
    for (const patch of [
      { created: true },
      { provider: "untrusted" },
      { purpose: "admin" },
      { organizationId: "" },
      { provider: "teams", transport: "outbound" },
    ])
      expect(
        presentToolResult(tool("get_chat_apps_setup", { data: { ...result, ...patch } })),
      ).toBeNull();
    expect(presentToolResult(tool("exec", { data: result }))).toBeNull();
    expect(
      presentToolResult({ ...tool("get_chat_apps_setup", { data: result }), isError: true }),
    ).toBeNull();
  });
  it("renders chat connection observations without inferring account or assistant readiness", () => {
    const view = presentToolResult(
      tool("get_chat_apps", {
        data: {
          connections: [
            {
              id: "slack-1",
              name: "Team Slack",
              provider: "slack",
              enabled: true,
              linked: false,
              receiver: { state: "connected" },
            },
          ],
        },
      }),
    );
    expect(view?.items[0]).toMatchObject({
      status: "Connected",
      description: "slack · Account not linked",
      href: "/settings?tab=chat-apps",
    });
    expect(
      describeAssistantTool({ id: "discover", name: "exec", input: "text(ALL_TOOLS);" }).title,
    ).toBe("Discover available tools");
  });
  it("shows connection observations separately from service health", () => {
    const view = presentToolResult(
      tool("get_system_servers", {
        data: [{ id: "s1", name: "Production", projectCount: 4, hostChannel: { ok: true } }],
      }),
    );
    expect(view?.items[0]).toMatchObject({
      href: "/servers/s1",
      status: "Connected",
      description: "4 apps",
    });
    expect(JSON.stringify(view)).not.toMatch(/healthy/i);
  });
  it("keeps errors and arbitrary tool output inspectable without promoting them to inline actions", () => {
    const html = renderToStaticMarkup(
      <AssistantToolActivity
        parts={[
          {
            type: "tool",
            tool: tool("get_system_diagnostics", {
              success: false,
              error: "Workspace access cannot grant instance administration",
              code: "INSTANCE_SCOPE_REQUIRED",
            }),
          },
        ]}
        active={false}
      />,
    );
    expect(html).toContain("Check instance health · Failed");
    expect(html).not.toContain("Review permissions");
    expect(html).not.toContain("View app");
  });
  it("shows access changes without claiming the requested grant was approved", () => {
    const request = {
      kind: "permission_request" as const,
      granted: false as const,
      clientId: "agent",
      organizationId: "org",
      reason: "Investigate an app",
      access: "Read access",
      reviewPath: "/settings?tab=mcp" as const,
    };
    const html = renderToStaticMarkup(
      <AssistantAccessRequest
        request={request}
        accessChanged
        onReview={() => {
          throw new Error("No grant on render");
        }}
      />,
    );
    expect(html).toContain("Access has changed");
    expect(html).not.toContain("Review permissions");
    expect(html).not.toContain("Nothing changes until you save");
    expect(html).not.toContain("approved");
    const foreign = tool("get_permissions_access_request", { data: request });
    foreign.action = {
      kind: "mcp",
      mcp: { server: "other", tool: "get_permissions_access_request" },
    };
    expect(permissionRequest({ type: "tool", tool: foreign }, "agent")).toBeNull();
  });
});

it("presents real agent/task results with local links and does not accept returned navigation", () => {
  const agent = presentToolResult(
    tool("post_assistant_agents", {
      data: {
        id: "agent-a",
        name: "Logs investigator",
        purpose: "Trace failures",
        readOnly: true,
        href: "https://untrusted.test",
      },
    }),
  )!;
  expect(agent.items[0]).toMatchObject({ href: "/assistant/agents/agent-a", status: "Read-only" });
  const task = presentToolResult(
    tool("post_assistant_agents_by_id_tasks", {
      data: {
        conversation: { id: "chat-a", title: "Investigate the failure" },
        activity: { state: "running" },
        path: "javascript:alert(1)",
      },
    }),
  )!;
  expect(task.items[0]).toMatchObject({ href: "/assistant?chat=chat-a", status: "Running" });
  const html = renderToStaticMarkup(<AssistantToolResources view={task} />);
  expect(html).toContain("Open conversation");
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("Completed");
  expect(
    presentToolResult(
      tool("post_assistant_agents_by_id_tasks", { conversation: { id: "../settings" } }),
    ),
  ).toBeNull();
});
