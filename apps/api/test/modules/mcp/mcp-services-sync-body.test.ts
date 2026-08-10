import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import "../../../src/modules/services/service.routes";
import { getMcpTools } from "../../../src/modules/mcp/mcp-tools";
import { SyncServicesBody } from "../../../src/modules/services/service.schema";

/**
 * `spec.body` on the sync route drives BOTH the auto-wired request validator
 * and the MCP tool's `body` parameter, so these cover the two sides together:
 * the tool advertises the parameter, and the payloads the CLI and dashboard
 * actually send still validate.
 */

const syncTool = () => getMcpTools().find((t) => t.name === "post_projects_by_id_services_sync");

/** The shape `openship service sync` builds from `docker compose config` (apps/cli mapComposeService). */
const cliPayload = {
  services: [
    {
      name: "web",
      build: "./web",
      dockerfile: "Dockerfile.prod",
      ports: ["8080:80", "9000:9000/udp"],
      dependsOn: ["db"],
      environment: { NODE_ENV: "production", EMPTY: "" },
      volumes: ["./static:/srv/static:ro"],
      command: "node server.js",
      restart: "on-failure:3",
    },
    { name: "db", image: "postgres:16", volumes: ["pgdata:/var/lib/postgresql/data"] },
  ],
};

/** The shape `servicesApi.sync` posts (apps/dashboard ServiceInput). */
const dashboardPayload = {
  services: [
    {
      name: "api",
      kind: "compose",
      image: "ghcr.io/acme/api:latest",
      ports: ["3000:3000"],
      environment: { PORT: "3000" },
      command: "bun start",
      restart: "unless-stopped",
      advanced: {
        healthcheck: { test: ["CMD", "curl", "-f", "http://localhost:3000"], retries: 3 },
      },
      exposed: true,
      exposedPort: "3000",
      domain: "api.example.com",
      domainType: "free",
      publicEndpoints: [{ port: 3000, domain: "api.example.com", domainType: "free" }],
      enabled: true,
      sortOrder: 0,
    },
  ],
};

describe("POST /projects/:id/services/sync body schema", () => {
  it("advertises a body parameter on the MCP tool", () => {
    const tool = syncTool();
    expect(tool).toBeDefined();
    expect(tool!.hasBody).toBe(true);

    const props = (tool!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props.body).toBeDefined();
    expect((props.body as { required?: string[] }).required).toEqual(["services"]);
  });

  it("accepts the payload the CLI builds from a compose file", () => {
    expect(Value.Check(SyncServicesBody, cliPayload)).toBe(true);
  });

  it("accepts the payload the dashboard posts", () => {
    expect(Value.Check(SyncServicesBody, dashboardPayload)).toBe(true);
  });

  it("accepts compose restart policies outside the four-value enum", () => {
    expect(
      Value.Check(SyncServicesBody, { services: [{ name: "web", restart: "on-failure:3" }] }),
    ).toBe(true);
    expect(Value.Check(SyncServicesBody, { services: [{ name: "web", restart: "no" }] })).toBe(
      true,
    );
  });

  it("keeps `advanced` open as ComposeAdvanced grows", () => {
    expect(
      Value.Check(SyncServicesBody, {
        services: [{ name: "web", advanced: { files: [{ path: "/etc/kong.yml", content: "x" }] } }],
      }),
    ).toBe(true);
  });

  it("passes unknown per-service keys through", () => {
    expect(Value.Check(SyncServicesBody, { services: [{ name: "web", labels: { a: "b" } }] })).toBe(
      true,
    );
  });

  it("leaves the empty-list rejection to the handler", () => {
    expect(Value.Check(SyncServicesBody, { services: [] })).toBe(true);
  });

  it("requires compose scalars to be strings", () => {
    const entry = (patch: Record<string, unknown>) => ({ services: [{ name: "web", ...patch }] });
    expect(Value.Check(SyncServicesBody, entry({ environment: { PORT: 3000 } }))).toBe(false);
    expect(Value.Check(SyncServicesBody, entry({ ports: [8080] }))).toBe(false);
    expect(Value.Check(SyncServicesBody, entry({ command: ["node", "server.js"] }))).toBe(false);
    expect(Value.Check(SyncServicesBody, entry({ exposed: "true" }))).toBe(false);
    expect(Value.Check(SyncServicesBody, entry({ exposedPort: 3000 }))).toBe(false);
    expect(Value.Check(SyncServicesBody, entry({ image: null }))).toBe(false);
    expect(Value.Check(SyncServicesBody, { services: [{ name: "" }] })).toBe(false);
  });

  it("rejects a missing services array and unnamed entries", () => {
    expect(Value.Check(SyncServicesBody, {})).toBe(false);
    expect(Value.Check(SyncServicesBody, { services: {} })).toBe(false);
    expect(Value.Check(SyncServicesBody, { services: [{ image: "nginx:1.27" }] })).toBe(false);
  });
});
