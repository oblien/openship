import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";
import type { McpToolDef } from "../../../src/modules/mcp/mcp-tools";

const fetch = vi.hoisted(() => vi.fn());
vi.mock("../../../src/app", () => ({ app: { fetch } }));

import { dispatchTool } from "../../../src/modules/mcp/mcp-dispatch";

const readTool: McpToolDef = {
  name: "get_projects",
  description: "List projects",
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false },
  method: "GET",
  path: "/api/projects",
  pathParams: [],
  hasBody: false,
  perm: {
    root: "project",
    leaf: "project",
    action: "list",
    wildcard: true,
    grantRoot: "project",
    projectCreate: false,
  },
};

const origin = {
  principalId: "oauth:test-client",
  clientIp: "203.0.113.10",
  userAgent: "test-client/1.0",
};

beforeEach(() => {
  fetch.mockReset();
});

describe("MCP read-only response sanitization", () => {
  it("omits credential fields and encrypted env snapshots before serialization", async () => {
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "project-a",
              webhookSecret: "reusable-value",
              cloneTokenEncrypted: "encrypted-clone-value",
              deployment: {
                envVars: { PUBLIC_URL: "ciphertext", ORDINARY_NAME: "ciphertext" },
                meta: {
                  composeServices: [
                    {
                      name: "web",
                      environment: { ORDINARY_NAME: "plaintext-value" },
                      buildArgs: { RELEASE_NAME: "plaintext-build-value" },
                    },
                  ],
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await dispatchTool(readTool, {}, "test-bearer", origin);
    expect(result.data).toEqual({
      data: [
        {
          id: "project-a",
          deployment: {
            meta: {
              composeServices: [
                {
                  name: "web",
                  environment: { ORDINARY_NAME: ENV_MASK },
                  buildArgs: { RELEASE_NAME: ENV_MASK },
                },
              ],
            },
          },
        },
      ],
    });
    const serialized = JSON.stringify(result.data);
    for (const forbidden of [
      "webhookSecret",
      "cloneTokenEncrypted",
      "envVars",
      "reusable-value",
      "ciphertext",
      "plaintext-value",
      "plaintext-build-value",
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it("sanitizes GET responses even when authorization marks the tool as writable", async () => {
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: "backup-policy-a",
            webhookSecret: "reusable-value",
            envVars: { ORDINARY_NAME: "ciphertext" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await dispatchTool(
      {
        ...readTool,
        name: "get_backup_policy",
        path: "/api/projects/:projectId/backup-policies",
        pathParams: ["projectId"],
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      { projectId: "project-a" },
      "test-bearer",
      origin,
    );

    expect(result.data).toEqual({ data: { id: "backup-policy-a" } });
    expect(JSON.stringify(result.data)).not.toContain("reusable-value");
    expect(JSON.stringify(result.data)).not.toContain("ciphertext");
  });

  it("does not rewrite mutating tool responses", async () => {
    fetch.mockResolvedValue(
      new Response(JSON.stringify({ token: "write-result" }), { status: 200 }),
    );
    const result = await dispatchTool(
      {
        ...readTool,
        name: "post_project",
        method: "POST",
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      {},
      "test-bearer",
      origin,
    );
    expect(result.data).toEqual({ token: "write-result" });
  });
});
