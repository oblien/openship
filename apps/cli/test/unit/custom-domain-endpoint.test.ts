import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  project: {} as Record<string, unknown>,
  rows: [] as unknown[],
  updates: [] as unknown[],
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

  it("warns without attaching a portless worker or failing the command", async () => {
    h.project = { ...h.project, hasServer: false, workloadType: "worker", port: null };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await add();
    expect(result.code).toBe(0);
    expect(h.rows).toHaveLength(1);
    expect(h.updates).toEqual([]);
    expect(warning.mock.calls.flat().join(" ")).toMatch(/worker.*no public route/i);
    expect(result.err).not.toContain("routed on the next deploy");
  });

  it.each(["services", "monorepo"])("warns without attaching a %s project", async (projectType) => {
    h.project = { ...h.project, name: "My project", projectType };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await add();
    expect(result.code).toBe(0);
    expect(h.rows).toHaveLength(1);
    expect(h.updates).toEqual([]);
    expect(warning).toHaveBeenCalledWith(
      "Domain app.example.com was added, but My project is a multi-service project, so routes belong to a service. Attach it to a service in the dashboard.",
    );
    expect(result.err).not.toContain("routed on the next deploy");
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
