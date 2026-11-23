import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext } from "@repo/platform";

/**
 * GH-1836 — the shared (project-level, serviceId IS NULL) environment store
 * needs its own reveal. The service-scoped `services/:serviceId/env-reveal`
 * answers only that service's rows, so pressing reveal on a saved shared
 * secret returned `{}` and the row stayed masked.
 *
 * These cases exercise the real operation chain —
 *   controls.revealEnv → project.service.revealEnvVars → repos.project.listEnvVars
 *   → decryptEnvMap → pickRevealed → audit —
 * with only the repo boundary mocked. The mock applies the same scope rules as
 * `envVarScope` in project.repo.ts so a service-scoped row that merely SHARES a
 * name can prove it is never read, not just never returned.
 */

const h = vi.hoisted(() => {
  const rows: Array<{
    id: string;
    projectId: string;
    environment: string;
    serviceId: string | null;
    key: string;
    value: string;
    isSecret: boolean;
  }> = [];
  const projects: Record<string, { id: string; organizationId: string } | undefined> = {};
  const listEnvVars = vi.fn(
    async (projectId: string, environment?: string, serviceId?: string | null) =>
      rows.filter(
        (row) =>
          row.projectId === projectId &&
          (environment === undefined || row.environment === environment) &&
          (serviceId === undefined
            ? true
            : serviceId === null
              ? row.serviceId === null
              : row.serviceId === serviceId),
      ),
  );
  return { rows, projects, listEnvVars };
});

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      project: {
        findById: vi.fn(async (id: string) => h.projects[id] ?? null),
        listEnvVars: h.listEnvVars,
      },
    },
  };
});

import { createProjectControls } from "@repo/platform/engine/modules/projects/project-controls.operations";
import { encrypt } from "@repo/platform/engine/lib/encryption";

const ctx = {
  organizationId: "org-a",
  userId: "alice",
  source: "api",
} as ExecutionContext;

const auditEvents: Array<{
  eventType: string;
  resourceType: string;
  resourceId: string;
  after: unknown;
}> = [];
const controls = createProjectControls((_c, event) => {
  auditEvents.push(event as never);
});

function seed() {
  h.projects.p1 = { id: "p1", organizationId: "org-a" };
  h.rows.push(
    // Shared (project-level) production secret — the row the bug could not reveal.
    {
      id: "e1",
      projectId: "p1",
      environment: "production",
      serviceId: null,
      key: "SHARED_TOKEN",
      value: encrypt("shared-secret-value"),
      isSecret: true,
    },
    // Shared preview row — wrong environment scope must not leak into a production reveal.
    {
      id: "e2",
      projectId: "p1",
      environment: "preview",
      serviceId: null,
      key: "SHARED_ONLY_PREVIEW",
      value: encrypt("preview-value"),
      isSecret: true,
    },
    // Service-scoped row — must never be reachable through the shared reveal.
    {
      id: "e3",
      projectId: "p1",
      environment: "production",
      serviceId: "svc1",
      key: "SVC_SECRET",
      value: encrypt("svc-value"),
      isSecret: true,
    },
    // Another project's shared row.
    {
      id: "e4",
      projectId: "p2",
      environment: "production",
      serviceId: null,
      key: "SHARED_TOKEN",
      value: encrypt("other-project"),
      isSecret: true,
    },
  );
}

describe("project-level env reveal (shared store)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.rows.length = 0;
    for (const key of Object.keys(h.projects)) delete h.projects[key];
    auditEvents.length = 0;
    seed();
  });

  it("reveals only the named shared secret, decrypted", async () => {
    const result = await controls.revealEnv(ctx, "p1", {
      keys: ["SHARED_TOKEN", "MISSING"],
      environment: "production",
    });
    expect(result).toEqual({ SHARED_TOKEN: "shared-secret-value" });
    expect(h.listEnvVars).toHaveBeenCalledWith("p1", "production", null);
  });

  it("never returns service-scoped or out-of-scope rows", async () => {
    await expect(
      controls.revealEnv(ctx, "p1", { keys: ["SVC_SECRET"], environment: "production" }),
    ).resolves.toEqual({});
    await expect(
      controls.revealEnv(ctx, "p1", { keys: ["SHARED_ONLY_PREVIEW"], environment: "production" }),
    ).resolves.toEqual({});
    await expect(
      controls.revealEnv(ctx, "p1", { keys: ["SHARED_ONLY_PREVIEW"], environment: "preview" }),
    ).resolves.toEqual({ SHARED_ONLY_PREVIEW: "preview-value" });
  });

  it("audits the reveal with the disclosed key names only", async () => {
    await controls.revealEnv(ctx, "p1", { keys: ["SHARED_TOKEN"], environment: "production" });
    expect(auditEvents).toHaveLength(1);
    const event = auditEvents[0]!;
    expect(event.eventType).toBe("project.updated");
    expect(event.resourceType).toBe("project");
    expect(event.resourceId).toBe("p1");
    expect(event.after).toMatchObject({
      action: "envVars.reveal",
      revealedEnvKeys: ["SHARED_TOKEN"],
    });
    expect(JSON.stringify(event.after)).not.toContain("shared-secret-value");
  });

  it("rejects a reveal against another organization's project", async () => {
    await expect(
      controls.revealEnv({ ...ctx, organizationId: "org-b" } as ExecutionContext, "p1", {
        keys: ["SHARED_TOKEN"],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(auditEvents).toHaveLength(0);
  });
});
