import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  project: {} as Record<string, unknown>,
  rows: [] as unknown[],
  updates: [] as unknown[],
  services: [] as Array<Record<string, unknown>>,
  serviceUpdates: [] as unknown[],
  updateError: false,
}));
vi.mock("../../src/lib/ship-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/lib/ship-client")>();
  const ship = {
    projects: {
      getInfo: async () => ({
        project: {
          ...h.project,
          projectType: h.project.projectType ?? "app",
          options: {
            hasServer: h.project.hasServer ?? true,
            workloadType: h.project.workloadType ?? "web",
            productionPort: String(h.project.port ?? ""),
          },
        },
      }),
      create: async (input: Record<string, unknown>) => {
        h.project = { ...input, id: "created" };
        return h.project;
      },
      update: async (id: string, input: unknown) => {
        if (h.updateError) throw new Error("update unavailable");
        h.updates.push({ id, input });
      },
    },
    services: {
      list: async () => h.services,
      get: async (_project: string, id: string) => {
        const service = h.services.find(service => service.id === id);
        if (!service) throw new Error("Service not found in project");
        return service;
      },
      update: async (project: string, id: string, input: unknown) => {
        if (h.updateError) throw new Error("update unavailable");
        h.serviceUpdates.push({ project, id, input });
      },
    },
    domains: {
      verify: async () => {
        throw new Error("verification unavailable");
      },
      create: async (_id: string, input: Record<string, unknown>) => {
        const domain = { id: "domain-1", ...input };
        h.rows.push(domain);
        return { domain };
      },
    },
  };
  return { ...original, getShipClient: () => ship, getRemoteClient: () => ship };
});

import { domainCommand } from "../../src/commands/domain";
import { edgeCommand } from "../../src/commands/edge";
import { runCommand } from "../helpers/harness";

beforeEach(() => {
  h.project = {
    id: "project-1",
    port: 3000,
    hasServer: true,
    workloadType: "web",
    publicEndpoints: [],
  };
  h.rows = [];
  h.updates = [];
  h.updateError = false;
  h.services = [];
  h.serviceUpdates = [];
});
afterEach(() => vi.restoreAllMocks());

const add = () => runCommand(domainCommand, ["add", "app.example.com", "--project", "project-1"]);

describe("CLI custom domain routing", () => {
  it("attaches a server endpoint after the row, preserving endpoint order and redirects", async () => {
    const existing = [
      { domainType: "free", domain: "old", port: 8080 },
      {
        domainType: "custom",
        customDomain: "www.old.example.com",
        port: 8080,
        redirectTo: "old.opsh.io",
        redirectStatus: 308,
      },
    ];
    h.project.publicEndpoints = existing.map((endpoint, index) => ({
      ...endpoint,
      id: `endpoint-${index}`,
      hostname: "display-only",
      isPrimary: index === 0,
    }));
    const result = await add();
    expect(result.code).toBe(0);
    expect(h.rows).toHaveLength(1);
    expect(h.updates).toEqual([
      {
        id: "project-1",
        input: {
          publicEndpoints: [
            ...existing,
            { domainType: "custom", customDomain: "app.example.com", port: 3000 },
          ],
        },
      },
    ]);
    expect(result.err).toContain("routed on the next deploy");
  });

  it("attaches a static endpoint to the release root", async () => {
    h.project = { ...h.project, hasServer: false, workloadType: "static", port: null };
    await add();
    expect(h.updates).toEqual([
      {
        id: "project-1",
        input: {
          publicEndpoints: [
            { domainType: "custom", customDomain: "app.example.com", targetPath: "/" },
          ],
        },
      },
    ]);
  });

  it("does not update an already attached hostname, ignoring case", async () => {
    h.project.publicEndpoints = [
      { domainType: "custom", customDomain: "APP.EXAMPLE.COM", port: 3000 },
    ];
    await add();
    expect(h.updates).toEqual([]);
  });

  it("refuses a portless worker before claiming a domain", async () => {
    h.project = { ...h.project, hasServer: false, workloadType: "worker", port: null };
    const result = await add();
    expect(result.code).toBe(1);
    expect(h.rows).toEqual([]);
    expect(h.updates).toEqual([]);
    expect(result.err).toContain("worker has no public route");
  });

  it.each(["services", "monorepo"])("requires an explicit target before claiming a domain for %s", async projectType => {
    h.project = { ...h.project, projectType };
    const result = await add();
    expect(result.code).toBe(1);
    expect(h.rows).toEqual([]);
    expect(result.err).toContain("--service");
  });

  it.each(["web", "svc_web"])("attaches to the project-scoped service selected by %s", async ref => {
    h.project.projectType = "services";
    const existing = [{ domainType: "free", domain: "existing", port: 8080 }];
    h.services = [{ id: "svc_web", name: "web", ports: ["8080:3000"], publicEndpoints: existing }];
    const result = await runCommand(domainCommand, ["add", "app.example.com", "-p", "project-1", "--service", ref, "--port", "3000"]);
    expect(result.code, result.err).toBe(0);
    expect(h.updates).toEqual([]);
    expect(h.serviceUpdates).toEqual([{ project: "project-1", id: "svc_web", input: { exposed: true, publicEndpoints: [...existing, { domainType: "custom", customDomain: "app.example.com", port: 3000 }] } }]);
  });

  it.each(["unknown", "svc_foreign"])("rejects an unknown or foreign service %s before claiming the hostname", async ref => {
    h.project.projectType = "services";
    const result = await runCommand(domainCommand, ["add", "app.example.com", "-p", "project-1", "--service", ref, "--port", "3000"]);
    expect(result.code).toBe(1);
    expect(h.rows).toEqual([]);
    expect(h.serviceUpdates).toEqual([]);
  });

  it("requires a port when the selected service has several possible targets", async () => {
    h.project.projectType = "services";
    h.services = [{ id: "svc_web", name: "web", ports: ["3000", "3001"] }];
    const result = await runCommand(domainCommand, ["add", "app.example.com", "-p", "project-1", "--service", "web"]);
    expect(result.code).toBe(1);
    expect(h.rows).toEqual([]);
    expect(result.err).toContain("--port");
  });

  it.each(["domain", "edge"])(
    "%s keeps the row and explains how to retry after an attach failure",
    async (command) => {
      h.updateError = true;
      const result =
        command === "domain"
          ? await add()
          : await runCommand(edgeCommand, [
              "domains",
              "add",
              "app.example.com",
              "--project",
              "project-1",
              "--no-verify",
            ]);
      expect(result.code).toBe(1);
      expect(h.rows).toHaveLength(1);
      expect(result.err).toMatch(/row.*still exists/i);
      expect(result.err).toContain("update unavailable");
      expect(result.err).toMatch(/retry.*dashboard.*Domains/i);
    },
  );

  it("does not announce routing before edge registration finishes", async () => {
    const result = await runCommand(edgeCommand, [
      "domains",
      "add",
      "app.example.com",
      "--project",
      "project-1",
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("verification unavailable");
    expect(result.err).not.toContain("routed on the next deploy");
  });

  it.each([
    ["--project", "project-1", "project-1", 3000],
    ["--port", "8080", "created", 8080],
  ])("edge domains add attaches through %s", async (flag, value, id, port) => {
    const result = await runCommand(edgeCommand, [
      "domains",
      "add",
      "app.example.com",
      flag as string,
      value as string,
      "--no-verify",
    ]);
    expect(result.code).toBe(0);
    expect(h.updates).toEqual([
      {
        id,
        input: {
          publicEndpoints: [{ domainType: "custom", customDomain: "app.example.com", port }],
        },
      },
    ]);
    expect(result.err).toContain("routed on the next deploy");
  });
});
