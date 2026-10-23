import { describe, expect, it } from "vitest";
import type { ExportSelection } from "@repo/core";
import {
  selectProjectTransfer,
  snapshotTransferReader,
  type TransferRowReader,
} from "./project-transfer";

const selection: ExportSelection = {
  scope: "projects",
  projectIds: ["project-a"],
  history: [],
  includeEnvironments: false,
  includeLinkedProjects: false,
  includeIntegrations: false,
};

function reader(databaseProjectId: string): TransferRowReader {
  const tables: Record<string, Record<string, unknown>[]> = {
    project: [{ id: "project-a", groupId: "group-a", organizationId: "org-a" }],
    project_app: [{ id: "group-a", organizationId: "org-a" }],
    cluster_database: [{ id: "database-a", projectId: databaseProjectId }],
  };
  return async (table, column, values) =>
    (tables[table] ?? []).filter((row) => values.includes(row[column]));
}

describe("project transfer runtime ownership", () => {
  it("does not transfer automatic security consent or replay source refresh attempts", async () => {
    const rows: Record<string, Record<string, unknown>[]> = {
      project: [{ id: "project-a", groupId: "group-a", organizationId: "org-a" }],
      project_app: [{ id: "group-a", organizationId: "org-a" }],
      project_security: [{ projectId: "project-a", autoRefresh: true, approvedBy: "source-user" }],
      security_refresh_attempt: [{ id: "source-attempt", projectId: "project-a", status: "queued" }],
    };
    const read: TransferRowReader = async (table, column, values) =>
      (rows[table] ?? []).filter((row) => values.includes(row[column]));
    const result = await selectProjectTransfer(read, selection);
    expect(result.tables.project).toHaveLength(1);
    expect(result.tables.project_security).toBeUndefined();
    expect(result.tables.security_refresh_attempt).toBeUndefined();
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("consent are reset"),
      expect.stringContaining("not replayed"),
    ]));
  });
  it("rejects exporting a managed preview without its source and cleanup ownership", async () => {
    const rows: Record<string, Record<string, unknown>[]> = {
      project: [{ id: "project-a", groupId: "group-a", organizationId: "org-a" }],
      pull_request_preview: [{ id: "preview", projectId: "project-a", sourceProjectId: "source" }],
    };
    const read: TransferRowReader = async (table, column, values) =>
      (rows[table] ?? []).filter(row => values.includes(row[column]));
    await expect(selectProjectTransfer(read, selection, ["pull_request_preview"]))
      .rejects.toMatchObject({ code: "CLUSTER_TRANSFER_UNSUPPORTED" });
  });

  it("follows the server identity without collecting unrelated hosts through composite owner keys", async () => {
    const project = {
      id: "project-a",
      groupId: "group-a",
      organizationId: "org-a",
      serverId: "server-a",
    };
    const server = { id: "server-a", organizationId: "org-a", sshHost: "203.0.113.10" };
    const tables: Record<string, Record<string, unknown>[]> = {
      project: [project],
      project_app: [{ id: "group-a", organizationId: "org-a" }],
      servers: [
        server,
        {
          id: "server-b",
          organizationId: "org-a",
          sshHost: "203.0.113.20",
          sshPrivateKey: "unrelated-key",
        },
      ],
    };
    const read: TransferRowReader = async (table, column, values) =>
      (tables[table] ?? []).filter((row) => values.includes(row[column]));

    const result = await selectProjectTransfer(read, selection);

    expect(result.serverIds).toEqual(["server-a"]);
    expect(result.tables.servers).toEqual([server]);
    expect(result.tables.project).toEqual([project]);
  });

  it.each([{ excluded: [] }, { excluded: ["cluster_database"] }])(
    "refuses to drop cluster database ownership with exclusions $excluded",
    async ({ excluded }) => {
      await expect(
        selectProjectTransfer(reader("project-a"), selection, excluded),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "CLUSTER_TRANSFER_UNSUPPORTED",
        message: expect.stringContaining("whole-instance export"),
      });
    },
  );

  it("does not block an unrelated project because another project owns a database", async () => {
    const result = await selectProjectTransfer(reader("project-b"), selection);
    expect(result.tables.project).toHaveLength(1);
    expect(result.tables.project?.[0]?.id).toBe("project-a");
    expect(result.tables.cluster_database).toBeUndefined();
  });
});

describe("project transfer indirect ingress ownership", () => {
  const read = (ownerProject: string): TransferRowReader => {
    const tables: Record<string, Record<string, unknown>[]> = {
      project: [{ id: "project-a", groupId: "group-a", organizationId: "org-a" }],
      project_app: [{ id: "group-a", organizationId: "org-a" }],
      domain: [{ id: "domain-a", projectId: ownerProject }],
      ingress_hostname: [{ id: "host-a", domainId: "domain-a", connectionId: "connection-a" }],
    };
    return async (table, column, values) =>
      (tables[table] ?? []).filter((row) => values.includes(row[column]));
  };
  it.each([
    { excluded: [] },
    { excluded: ["ingress_hostname"] },
    { excluded: ["ingress_hostname", "domain"] },
  ])("preserves cleanup ownership despite excluded tables $excluded", async ({ excluded }) => {
    await expect(
      selectProjectTransfer(read("project-a"), selection, excluded),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Disconnect managed Cloudflare hostnames"),
    });
  });
  it("allows a project unrelated to a managed hostname", async () => {
    const result = await selectProjectTransfer(read("project-b"), selection);
    expect(result.tables.project?.map((p) => p.id)).toEqual(["project-a"]);
    expect(result.tables.ingress_hostname).toBeUndefined();
  });
});

describe("project transfer domain proxy overrides", () => {
  it("preserves explicit, null, and legacy missing values without changing authoritative ownership", async () => {
    const domains = [
      {
        id: "explicit",
        projectId: "project-a",
        hostname: "explicit.test",
        proxy: { clientMaxBodySize: "2m" },
      },
      {
        id: "unlimited",
        projectId: "project-a",
        hostname: "unlimited.test",
        proxy: { clientMaxBodySize: "0" },
      },
      { id: "inherited", projectId: "project-a", hostname: "inherited.test", proxy: null },
      { id: "legacy", projectId: "project-a", hostname: "legacy.test" },
    ];
    const rows = {
      project: [
        {
          id: "project-a",
          groupId: "group-a",
          organizationId: "org-a",
          routingConfig: { proxy: { clientMaxBodySize: "10m" } },
        },
      ],
      project_app: [{ id: "group-a", organizationId: "org-a" }],
      domain: [
        ...domains,
        {
          id: "foreign",
          projectId: "project-b",
          hostname: "foreign.test",
          proxy: { clientMaxBodySize: "1m" },
        },
      ],
    };
    const result = await selectProjectTransfer(snapshotTransferReader(rows), selection);
    expect(result.tables.domain).toEqual(domains);
    expect(result.tables.domain!.find((row) => row.id === "legacy")).not.toHaveProperty("proxy");
    (result.tables.domain![0]!.proxy as { clientMaxBodySize: string }).clientMaxBodySize = "1m";
    expect(domains[0]!.proxy).toEqual({ clientMaxBodySize: "2m" });
  });
});
