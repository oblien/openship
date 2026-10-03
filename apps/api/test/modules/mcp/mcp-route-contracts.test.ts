import "../../../src/modules/system/server-resource.routes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { readFileSync } from "node:fs";

const forwarding = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../src/app", () => ({ app: forwarding }));

import "../../../src/modules/projects/project.routes";
import "../../../src/modules/deployments/deployment.routes";
import "../../../src/modules/system/server-management.routes";
import "../../../src/modules/backups/backup.routes";
import "../../../src/modules/backup-destinations/destination.routes";
import "../../../src/modules/github/github.routes";
import "../../../src/modules/billing/billing.routes";
import "../../../src/modules/billing/billing-local.routes";
import "../../../src/modules/analytics/analytics.routes";
import "../../../src/modules/migration/migration.routes";
import "../../../src/modules/mail/mail.routes";
import "../../../src/modules/permissions/permissions.routes";
import "../../../src/modules/domains/domain.routes";
import "../../../src/modules/apps/app.routes";
import "../../../src/modules/issues/issues.routes";
import "../../../src/modules/jobs/job.routes";
import "../../../src/modules/notifications/notifications.routes";
import "../../../src/modules/updates/updates.routes";
import { env } from "@repo/platform/engine/config/index";
import { getMcpTools, filterToolsForPrincipal } from "../../../src/modules/mcp/mcp-tools";
import { dispatchTool } from "../../../src/modules/mcp/mcp-dispatch";
import { listPrompts, getPrompt } from "../../../src/modules/mcp/mcp-prompts";

const origin = { principalId: "pat:contract-test", clientIp: null, userAgent: "MCP contract test" };
function tool(name: string) {
  const found = getMcpTools().find((tool) => tool.name === name);
  expect(found, name).toBeDefined();
  return found!;
}
afterEach(() => {
  vi.restoreAllMocks();
  forwarding.fetch.mockReset();
});

describe("MCP route input and transport contracts", () => {
  it.each([
    ["delete_system_compute_clusters_by_id_runtime", { id: "cluster-a", body: { sequence: 7 } }],
    [
      "delete_projects_by_id_cluster_databases",
      {
        id: "project-a",
        body: { databaseId: "db-a", expectedSequence: 9, name: "orders", deleteData: false },
      },
    ],
    [
      "delete_github_repos_by_owner_by_repo_webhooks",
      { owner: "acme", repo: "web", body: { hookId: 123 } },
    ],
  ])("forwards the complete guarded DELETE body for %s", async (name, args) => {
    forwarding.fetch.mockResolvedValueOnce(new Response('{"removed":true}', { status: 200 }));
    const result = await dispatchTool(
      tool(name),
      { ...args, organizationId: "org-a" },
      "test-token",
      origin,
    );
    expect(result.ok).toBe(true);
    const request = forwarding.fetch.mock.lastCall![0] as Request;
    expect(request.method).toBe("DELETE");
    expect(await request.json()).toEqual(args.body);
    expect(request.headers.get("x-organization-id")).toBe("org-a");
    expect(request.headers.get("x-openship-scope")).toBe("fixed");
  });

  it.each([
    { owner: ".", repo: "acme" },
    { owner: "..", repo: "acme" },
    { owner: "acme", repo: "." },
    { owner: "acme", repo: ".." },
  ])(
    "rejects URL dot segments before a webhook delete can reach another route: %j",
    async (path) => {
      forwarding.fetch.mockClear();
      forwarding.fetch.mockResolvedValueOnce(new Response("{}"));
      expect(
        await dispatchTool(
          tool("delete_github_repos_by_owner_by_repo_webhooks"),
          { ...path, body: { hookId: 123 } },
          "test-token",
          origin,
        ),
      ).toMatchObject({
        ok: false,
        status: 400,
        data: { code: "INVALID_TOOL_ARGUMENTS" },
      });
      expect(forwarding.fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves dots and encoded characters inside a resource name", async () => {
    for (const repo of [".github", "app.v2", "release%2Fbranch", "%2e%2e"]) {
      forwarding.fetch.mockResolvedValueOnce(new Response("{}"));
      expect(
        (
          await dispatchTool(
            tool("delete_github_repos_by_owner_by_repo_webhooks"),
            { owner: "acme", repo, body: { hookId: 123 } },
            "test-token",
            origin,
          )
        ).ok,
      ).toBe(true);
      const request = forwarding.fetch.mock.lastCall![0] as Request;
      expect(new URL(request.url).pathname).toBe(
        `/api/github/repos/acme/${encodeURIComponent(repo)}/webhooks`,
      );
    }
  });

  it("advertises and enforces required path, query and concurrency guards before dispatch", async () => {
    forwarding.fetch.mockClear();
    for (const [name, args] of [
      ["get_analytics", {}],
      ["get_analytics", { query: { projectId: "" } }],
      ["delete_system_compute_clusters_by_id_runtime", { id: "cluster-a" }],
      ["post_projects_by_id_cluster_scale", { id: "project-a", body: { replicas: 3 } }],
      [
        "post_projects_by_id_cluster_scale",
        {
          id: "project-a",
          body: { replicas: 0, expectedDeploymentId: "dep-a", expectedUpdatedAt: "now" },
        },
      ],
    ] as const) {
      expect(await dispatchTool(tool(name), args, "test-token", origin)).toMatchObject({
        ok: false,
        status: 400,
        data: { code: "INVALID_TOOL_ARGUMENTS" },
      });
    }
    expect(forwarding.fetch).not.toHaveBeenCalled();
    expect(tool("get_analytics").inputSchema.required).toContain("query");
    expect(tool("post_projects_by_id_cluster_scale").inputSchema.required).toContain("body");
  });

  it("sends an empty JSON object for an omitted all-optional input", async () => {
    forwarding.fetch.mockResolvedValueOnce(new Response("{}"));
    await dispatchTool(
      tool("post_backup_policies_by_policyId_run"),
      { policyId: "policy-a" },
      "test-token",
      origin,
    );
    expect(await (forwarding.fetch.mock.lastCall![0] as Request).json()).toEqual({});
  });

  it("closes an unexpected live stream instead of leaving a tool call waiting for EOF", async () => {
    const cancel = vi.fn();
    forwarding.fetch.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }),
    );
    expect(
      await dispatchTool(
        tool("get_projects_by_id_cluster"),
        { id: "project-a" },
        "test-token",
        origin,
      ),
    ).toMatchObject({
      ok: false,
      data: { code: "MCP_STREAM_NOT_SUPPORTED" },
    });
    expect(cancel).toHaveBeenCalledOnce();
  }, 1_000);

  it.each([
    [
      "get_apps_catalog_by_id_host_fit",
      { id: "postgres", query: { deployTarget: "self", serverId: "server-a" } },
    ],
    ["get_issues", { query: { status: "resolved" } }],
    ["get_jobs_by_key_runs", { key: "health-watch", query: { limit: 5 } }],
    ["get_notifications_deliveries", { query: { unseen: true, limit: 5 } }],
    ["get_updates", { query: { behind: true } }],
    ["delete_system_servers_by_id", { id: "server-a", query: { destroyOnSource: true } }],
    ["post_domains_by_id_verify", { id: "domain-a", query: { force: true } }],
    ["get_domains_by_id_records", { id: "domain-a", query: { serverId: "server-a" } }],
    ["get_domains_by_id_dns_plan", { id: "domain-a", query: { serverId: "server-a" } }],
    ["post_domains_by_id_dns_apply", { id: "domain-a", query: { serverId: "server-a" } }],
    [
      "get_projects_by_id_webhook_deliveries",
      { id: "project-a", query: { limit: 5, cursor: "page-two" } },
    ],
    [
      "get_projects_by_id_incoming_webhooks_by_hookId_deliveries",
      { id: "project-a", hookId: "hook-a", query: { limit: 5, cursor: "page-two" } },
    ],
  ])("advertises and forwards the declared HTTP query for %s", async (name, args) => {
    const schema = tool(name).inputSchema as TSchema;
    for (const key of Object.keys(args.query)) {
      expect(schema.properties.query.properties).toHaveProperty(key);
    }
    forwarding.fetch.mockResolvedValueOnce(new Response("{}"));
    expect((await dispatchTool(tool(name), args, "test-token", origin)).ok).toBe(true);
    const request = forwarding.fetch.mock.lastCall![0] as Request;
    expect(await request.text()).toBe("");
    const url = new URL(request.url);
    expect(Object.fromEntries(url.searchParams)).toEqual(
      Object.fromEntries(Object.entries(args.query).map(([key, value]) => [key, String(value)])),
    );
  });

  it("forwards bulk domain verification options and accepts existing mail retention values", async () => {
    forwarding.fetch.mockResolvedValueOnce(new Response("{}"));
    await dispatchTool(
      tool("post_domains_verify_pending"),
      {
        body: { minAgeMinutes: 0, limit: 5 },
      },
      "test-token",
      origin,
    );
    expect(await (forwarding.fetch.mock.lastCall![0] as Request).json()).toEqual({
      minAgeMinutes: 0,
      limit: 5,
    });
    for (const retention of [0, 5, null]) {
      expect(
        Value.Check(tool("post_mail_admin_by_serverId_backup_policy").inputSchema as TSchema, {
          serverId: "server-a",
          body: { destinationId: "destination-a", retainCount: retention, retainDays: retention },
        }),
      ).toBe(true);
    }
  });

  it("encodes typed query arguments and never echoes bad values in validation errors", async () => {
    forwarding.fetch.mockResolvedValueOnce(new Response("{}"));
    await dispatchTool(
      tool("get_projects_by_projectId_backup_runs"),
      {
        projectId: "project-a",
        query: { active: false, limit: 20, before: "cursor+with/slash" },
      },
      "test-token",
      origin,
    );
    const url = new URL((forwarding.fetch.mock.lastCall![0] as Request).url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      active: "false",
      limit: "20",
      before: "cursor+with/slash",
    });
    const invalid = await dispatchTool(
      tool("post_mail_admin_by_serverId_mailboxes"),
      {
        serverId: "server-a",
        body: {
          localPart: "person",
          domain: "example.test",
          password: { secret: "never-echo-this-password" },
        },
      },
      "test-token",
      origin,
    );
    expect(invalid).toMatchObject({ ok: false, data: { code: "INVALID_TOOL_ARGUMENTS" } });
    expect(JSON.stringify(invalid)).not.toContain("never-echo-this-password");
  });

  it("lists each billing endpoint once and uses behavior rather than permission level for read hints", () => {
    const billing = getMcpTools().filter((tool) => tool.path === "/api/billing/state");
    expect(billing.map((tool) => tool.name)).toEqual(["get_billing_state"]);
    expect(tool("get_projects_by_projectId_backup_runs").annotations.readOnlyHint).toBe(true);
    expect(tool("delete_projects_by_id_cluster_databases").annotations.destructiveHint).toBe(true);
    expect(getMcpTools().some((tool) => tool.path.endsWith("/stream"))).toBe(false);
    expect(getMcpTools().some((tool) => tool.path.startsWith("/api/system/clusters"))).toBe(false);
  });

  it("preserves per-repository tools while requiring wildcard fleet access for network operations", () => {
    const tools = getMcpTools();
    const principal = {
      role: "restricted" as const,
      readOnly: false,
      canCreateProjects: false,
      grantedRootTypes: new Set(["github_repository", "server", "project"]),
      wildcardGrants: new Map(),
    };
    const names = filterToolsForPrincipal(tools, principal).map((tool) => tool.name);
    expect(names).toContain("get_github_repos_by_owner_by_repo");
    expect(names).not.toContain("get_analytics");
    expect(names).not.toContain("get_system_networks_operations_by_operationId");
    expect(names).not.toContain("post_system_compute_clusters");
  });

  it("matches wildcard gates for catalog reads and mail collections without hiding resource reads", () => {
    const principal = {
      role: "restricted" as const,
      readOnly: false,
      canCreateProjects: false,
      grantedRootTypes: new Set(["project", "mail_server"]),
      wildcardGrants: new Map(),
    };
    const names = filterToolsForPrincipal(getMcpTools(), principal).map((tool) => tool.name);
    expect(names).toContain("get_mail_admin_by_serverId_mailboxes_by_email");
    expect(names).toContain("get_domains");
    expect(names).not.toContain("get_mail_admin_by_serverId_mailboxes");
    expect(names).not.toContain("get_mail_status");
    expect(names).not.toContain("get_apps_catalog_by_id");
    expect(names).not.toContain("post_domains_preview");
    principal.wildcardGrants.set("mail_server", ["read"]);
    const withMailReads = filterToolsForPrincipal(getMcpTools(), principal).map(
      (tool) => tool.name,
    );
    expect(withMailReads).toContain("get_mail_admin_by_serverId_mailboxes");
    expect(withMailReads).toContain("get_mail_status");
    expect(withMailReads).not.toContain("post_mail_scan");
  });

  it("all workflow references resolve to real tools and unavailable cluster flows stay off Cloud", () => {
    for (const name of [
      "cluster-and-scale",
      "cluster-database",
      "backup-and-restore",
      "migrate-docker-project",
    ]) {
      const text = (getPrompt(name, {})!.messages[0] as { content: { text: string } }).content.text;
      expect(text, name).not.toMatch(/(?:GET|POST|PATCH|PUT|DELETE) \/api\//);
      expect(text).toContain("organizationId");
      expect(text).toContain("Remove tokens, passwords");
    }
    const original = env.CLOUD_MODE;
    try {
      env.CLOUD_MODE = true;
      expect(listPrompts().map((prompt) => prompt.name)).not.toContain("cluster-and-scale");
      expect(getPrompt("cluster-and-scale", {})).toBeNull();
    } finally {
      env.CLOUD_MODE = original;
    }
  });

  it("accepts migration routes keyed by scan container ID and preserves explicit service values", () => {
    const input = {
      body: {
        sourceServerId: "server-a",
        projectName: "Orders",
        serviceNames: ["web"],
        serviceContainerIds: ["docker-id"],
        serviceEnv: { "docker-id": { DATABASE_URL: "postgres://production" } },
        routesByServiceName: {
          "docker-id": [
            {
              domainType: "custom",
              customDomain: "orders.example.test",
              exposedPort: "3000",
              targetPath: "/",
            },
          ],
        },
      },
    };
    expect(Value.Check(tool("post_migration_migrate").inputSchema as TSchema, input)).toBe(true);
  });

  it("keeps every published cluster/scaling example valid against the real tool schemas", () => {
    const guide = readFileSync(
      new URL("../../../../web/content/docs/guides/mcp-clusters-and-scaling.mdx", import.meta.url),
      "utf8",
    );
    const examples = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)];
    expect(examples.length).toBeGreaterThan(0);
    for (const [, json] of examples) {
      const call = JSON.parse(json);
      expect(call.method).toBe("tools/call");
      const schema = tool(call.params.name).inputSchema as TSchema;
      expect(
        [...Value.Errors(schema, call.params.arguments)].map(({ path, message }) => ({
          path,
          message,
        })),
        call.params.name,
      ).toEqual([]);
    }
  });
});
