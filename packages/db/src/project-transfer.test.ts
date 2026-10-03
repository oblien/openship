import { describe, expect, it } from "vitest";
import type { ExportSelection } from "@repo/core";
import { selectProjectTransfer, type TransferRowReader } from "./project-transfer";

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
