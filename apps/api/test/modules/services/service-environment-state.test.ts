import { repos, seedOwner, installFakeRunner } from "../jobs/_harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ENV_MASK } from "@repo/core";
import { DockerRuntime } from "@repo/adapters";
import { OpenshipClient } from "@repo/sdk/client";
import { decrypt, encrypt } from "@repo/platform/engine/lib/encryption";
import * as deploymentRuntime from "@repo/platform/engine/lib/deployment-runtime";
import * as edgeTarget from "@repo/platform/engine/lib/edge-target";
import * as serverTarget from "@repo/platform/engine/lib/server-target";
import { serviceRoutes } from "../../../src/modules/services/service.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import {
  seedDeployment,
  seedProject,
  seedService,
  seedServiceDeployment,
  setActive,
} from "../../helpers/seed";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects/:id/services", serviceRoutes);

describe("effective service environment through HTTP, SDK and real storage", () => {
  let owner: Awaited<ReturnType<typeof seedOwner>>;
  let client: OpenshipClient;
  let project: Awaited<ReturnType<typeof seedProject>>;
  let service: Awaited<ReturnType<typeof seedService>>;
  beforeEach(async () => {
    owner = await seedOwner();
    project = await seedProject(owner.orgId, {
      framework: "docker-compose",
      runtimeMode: "docker",
    });
    service = await seedService(project.id, {
      name: "api",
      environment: {
        INLINE: "compose-default",
        DATABASE_URL: "postgres://${DB_PASSWORD}@db/app",
        SHARED: "compose-wins",
      },
      advanced: { environmentTemplateKeys: ["DATABASE_URL"] },
    });
    const deployment = await seedDeployment(project);
    await setActive(project.id, deployment.id);
    await repos.project.bulkSetEnvVars(
      project.id,
      "production",
      [
        { key: "DB_PASSWORD", value: encrypt("project-secret"), isSecret: true },
        { key: "SHARED", value: encrypt("project-default") },
        { key: "PROJECT_ONLY", value: encrypt("shared") },
      ],
      null,
    );
    client = new OpenshipClient({
      baseUrl: "http://openship.test",
      token: owner.token,
      organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    });
    vi.spyOn(deploymentRuntime, "resolveDeploymentRuntimeForRead").mockRejectedValue(
      new Error("Cannot reach the deployment server over SSH"),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("shows Compose and shared variables with zero overrides, without contacting Docker or leaking secrets", async () => {
    const state = await client.services.getEnvironment(project.id, service.id);
    expect(state.status).toBe("unchecked");
    expect(state.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "INLINE", value: ENV_MASK, source: "compose" }),
        expect.objectContaining({ key: "DATABASE_URL", value: ENV_MASK, source: "compose" }),
        expect.objectContaining({ key: "PROJECT_ONLY", value: "shared", source: "project" }),
      ]),
    );
    expect(JSON.stringify(state)).not.toContain("project-secret");
    expect(deploymentRuntime.resolveDeploymentRuntimeForRead).not.toHaveBeenCalled();
    expect(await repos.project.listEnvVars(project.id, "production", service.id)).toEqual([]);
    expect(
      await client.services.revealEnv(project.id, service.id, {
        keys: ["DATABASE_URL"],
        source: "effective",
        environment: "production",
      }),
    ).toEqual({ DATABASE_URL: "postgres://project-secret@db/app" });
  });

  it("keeps saved variables visible when the remote daemon is unavailable", async () => {
    const saved = await client.services.getEnvironment(project.id, service.id);
    const state = await client.services.getEnvironment(project.id, service.id, {
      inspectRuntime: true,
    });
    expect(state.variables).toEqual(saved.variables);
    expect(state).toMatchObject({
      status: "unavailable",
      changedKeys: [],
      message: "Cannot reach the deployment server over SSH",
    });
  });

  it.each(["docker", "cloud"])(
    "resolves port-only public URLs on the %s deployment target",
    async (target) => {
      const managed = target === "cloud"
        ? await repos.cloudWorkspace.create({ organizationId: owner.orgId, name: "Managed server" })
        : null;
      const server = managed ? await repos.server.findByWorkspace(managed.id, owner.orgId) : null;
      const stack = await seedProject(owner.orgId, {
        serverId: server?.id,
        framework: "docker-compose",
        runtimeMode: "docker",
      });
      const api = await seedService(stack.id, {
        name: "api",
        environment: { BACKEND_ORIGIN: "{{publicUrl:backend:8080}}" },
      });
      await seedService(stack.id, { name: "backend", exposed: false, ports: ["8080:8080"] });
      const deployment = await seedDeployment(stack, {
        meta: server ? { deployTarget: "cloud", serverId: server.id, managedWorkspaceId: managed!.id,
          managedServer: { projectId: stack.id, workspaceId: "provider-vm", ownerWorkspaceId: managed!.id } } : {},
      });
      await setActive(stack.id, deployment.id);
      await seedServiceDeployment(deployment.id, api, { containerId: "current-api" });
      const runtime = await DockerRuntime.create({
        dockerSocketPath: "/tmp/openship-test-absent.sock",
      });
      vi.spyOn(runtime, "supports").mockReturnValue(false);
      vi.spyOn(runtime, "dispose").mockResolvedValue(undefined);
      vi.spyOn(runtime, "inspectContainer").mockResolvedValue({
        id: "current-api",
        name: "api",
        image: "test-image",
        imageId: "sha256:test-image",
        state: "running",
        env: ["BACKEND_ORIGIN=http://203.0.113.5:8080"],
        labels: { "openship.project": stack.id, "openship.service": "api" },
        networks: [],
        mounts: [],
        ports: [],
      });
      vi.spyOn(runtime, "inspectImageEnv").mockResolvedValue([]);
      vi.mocked(deploymentRuntime.resolveDeploymentRuntimeForRead).mockResolvedValue({
        runtime,
        serverId: server?.id ?? null,
        hostPortTarget: null,
      });
      vi.spyOn(serverTarget, "resolveServerHost").mockResolvedValue(null);
      const edge = vi
        .spyOn(edgeTarget, "resolveEdgeTargetHost")
        .mockResolvedValue({ host: "203.0.113.5" });

      const state = await client.services.getEnvironment(stack.id, api.id, {
        inspectRuntime: true,
      });
      expect(state.variables).toEqual([
        expect.objectContaining({ key: "BACKEND_ORIGIN", value: ENV_MASK, source: "compose" }),
      ]);
      if (target === "cloud") {
        // The control server's reachable port is not a Cloud workspace's public URL.
        expect(state).toMatchObject({
          status: "unavailable",
          message: "Public URLs are missing for environment variables: BACKEND_ORIGIN",
        });
        expect(edge).not.toHaveBeenCalled();
      } else {
        expect(state).toMatchObject({ status: "synced", changedKeys: [] });
      }
    },
  );

  it("saves only deliberate edits, retaining ciphertext, row identity and other scopes", async () => {
    await client.services.setEnvVars(project.id, service.id, {
      environment: "production",
      vars: [
        { key: "TOKEN", value: "keep-this-secret", isSecret: true },
        { key: "FLAG", value: "old" },
      ],
    });
    const before = await repos.project.listEnvVars(project.id, "production", service.id);
    const token = before.find((row) => row.key === "TOKEN")!;
    const flag = before.find((row) => row.key === "FLAG")!;
    await client.services.mergeEnvVars(project.id, service.id, {
      environment: "production",
      deletes: [],
      upserts: [
        { sourceId: flag.id, key: "FLAG", value: "new" },
        { sourceId: null, key: "INLINE", value: "my-override" },
      ],
    });
    const after = await repos.project.listEnvVars(project.id, "production", service.id);
    expect(after.find((row) => row.key === "TOKEN")).toEqual(token);
    expect(after.map((row) => row.key).sort()).toEqual(["FLAG", "INLINE", "TOKEN"]);
    expect(after.find((row) => row.key === "INLINE")?.value).not.toBe("my-override");
    expect((await repos.service.findById(service.id))?.environment?.INLINE).toBe("compose-default");
    expect((await repos.project.listEnvVars(project.id, "production", null)).length).toBe(3);
  });

  it("keeps saved configuration editable for the control-plane service", async () => {
    const self = await seedProject(owner.orgId, { isControlPlane: true });
    const api = await seedService(self.id, { name: "api" });
    await client.services.mergeEnvVars(self.id, api.id, {
      environment: "production",
      deletes: [],
      upserts: [{ sourceId: null, key: "SETTING", value: "saved" }],
    });
    expect(
      await client.services.revealEnv(self.id, api.id, { source: "effective", keys: ["SETTING"] }),
    ).toEqual({ SETTING: "saved" });
  });

  it("keeps concurrent edits to different variables and rejects stale writes and deletes", async () => {
    await client.services.setEnvVars(project.id, service.id, {
      environment: "production",
      vars: [
        { key: "A", value: "a" },
        { key: "B", value: "b" },
      ],
    });
    const rows = await repos.project.listEnvVars(project.id, "production", service.id);
    const a = rows.find((row) => row.key === "A")!;
    const b = rows.find((row) => row.key === "B")!;
    await Promise.all([
      client.services.mergeEnvVars(project.id, service.id, {
        environment: "production",
        deletes: [],
        upserts: [{ key: "A", sourceId: a.id, value: "new-a" }],
      }),
      client.services.mergeEnvVars(project.id, service.id, {
        environment: "production",
        deletes: [],
        upserts: [{ key: "B", sourceId: b.id, value: "new-b" }],
      }),
    ]);
    await expect(
      client.services.mergeEnvVars(project.id, service.id, {
        environment: "production",
        deletes: [{ key: "A", sourceId: a.id }],
        upserts: [],
      }),
    ).rejects.toMatchObject({ code: "ENVIRONMENT_CHANGED" });
    await expect(
      client.services.mergeEnvVars(project.id, service.id, {
        environment: "production",
        deletes: [],
        upserts: [{ key: "B", sourceId: b.id, value: "stale" }],
      }),
    ).rejects.toMatchObject({ code: "ENVIRONMENT_CHANGED" });
    await expect(
      client.services.mergeEnvVars(project.id, service.id, {
        environment: "production",
        deletes: [],
        upserts: [{ key: "B", sourceId: null, value: "stale" }],
      }),
    ).rejects.toMatchObject({ code: "ENVIRONMENT_CHANGED" });
    expect(
      await client.services.revealEnv(project.id, service.id, {
        keys: ["A", "B"],
        source: "effective",
      }),
    ).toEqual({ A: "new-a", B: "new-b" });
  });

  it("preserves sensitivity when explicitly saving a masked inherited value", async () => {
    await client.services.mergeEnvVars(project.id, service.id, {
      environment: "production",
      deletes: [],
      upserts: [{ key: "DATABASE_URL", sourceId: null, value: ENV_MASK }],
    });
    const row = (await repos.project.listEnvVars(project.id, "production", service.id))[0]!;
    expect(row.isSecret).toBe(true);
    expect(decrypt(row.value)).toBe("postgres://project-secret@db/app");
    expect(
      (await client.services.getEnvironment(project.id, service.id)).variables.find(
        (row) => row.key === "DATABASE_URL",
      ),
    ).toMatchObject({ source: "service", value: ENV_MASK, isSecret: true });
  });

  it("renames a masked secret without revealing or re-encrypting it, then restores inheritance when its override is removed", async () => {
    await client.services.mergeEnvVars(project.id, service.id, {
      environment: "production",
      deletes: [],
      upserts: [{ key: "INLINE", sourceId: null, value: "private", isSecret: true }],
    });
    const original = (await repos.project.listEnvVars(project.id, "production", service.id))[0]!;
    await client.services.mergeEnvVars(project.id, service.id, {
      environment: "production",
      deletes: [],
      upserts: [{ key: "RENAMED", sourceId: original.id, value: ENV_MASK, isSecret: true }],
    });
    const renamed = (await repos.project.listEnvVars(project.id, "production", service.id))[0]!;
    expect(renamed).toMatchObject({ key: "RENAMED", value: original.value });
    expect(decrypt(renamed.value)).toBe("private");
    expect(
      await client.services.revealEnv(project.id, service.id, {
        keys: ["INLINE"],
        source: "effective",
      }),
    ).toEqual({ INLINE: "compose-default" });
    await client.services.mergeEnvVars(project.id, service.id, {
      environment: "production",
      deletes: [{ key: "RENAMED", sourceId: renamed.id }],
      upserts: [],
    });
    expect(
      (await client.services.getEnvironment(project.id, service.id)).variables.some(
        (row) => row.key === "RENAMED",
      ),
    ).toBe(false);
  });

  it("resolves missing interpolation from saved overrides and never wipes an explicit empty value", async () => {
    await repos.service.update(service.id, {
      environment: { REQUIRED: "${REQUIRED:?set it}", EMPTY: "compose" },
      advanced: { environmentTemplateKeys: ["REQUIRED"] },
    });
    const missing = await client.services.getEnvironment(project.id, service.id);
    expect(missing.missingRequired).toEqual(["REQUIRED"]);
    expect(missing.variables.find((row) => row.key === "REQUIRED")).toMatchObject({
      value: "",
      missing: true,
    });
    await client.services.mergeEnvVars(project.id, service.id, {
      environment: "production",
      deletes: [],
      upserts: [
        { key: "REQUIRED", sourceId: null, value: "saved" },
        { key: "EMPTY", sourceId: null, value: "" },
      ],
    });
    const saved = await client.services.getEnvironment(project.id, service.id);
    expect(saved.missingRequired).toEqual([]);
    expect(saved.variables.find((row) => row.key === "REQUIRED")).toMatchObject({
      source: "service",
      value: ENV_MASK,
    });
    expect(
      await client.services.revealEnv(project.id, service.id, {
        keys: ["EMPTY", "REQUIRED"],
        source: "effective",
      }),
    ).toEqual({ EMPTY: "", REQUIRED: "saved" });
  });

  it("uses the active deployment's scope and keeps production and preview edits separate", async () => {
    const preview = await seedDeployment(project, { environment: "preview" });
    await setActive(project.id, preview.id);
    await client.services.mergeEnvVars(project.id, service.id, {
      environment: "preview",
      deletes: [],
      upserts: [{ key: "PREVIEW_ONLY", value: "preview", sourceId: null }],
    });
    const state = await client.services.getEnvironment(project.id, service.id);
    expect(state.environment).toBe("preview");
    expect(state.variables.some((row) => row.key === "PREVIEW_ONLY")).toBe(true);
    expect(state.variables.some((row) => row.key === "PROJECT_ONLY")).toBe(false);
    const production = await client.services.getEnvironment(project.id, service.id, {
      environment: "production",
      inspectRuntime: true,
    });
    expect(production.status).toBe("not-deployed");
    expect(production.variables.some((row) => row.key === "PREVIEW_ONLY")).toBe(false);
  });

  it("rejects cross-service IDs and malformed input without changing stored values", async () => {
    const other = await seedService(project.id, { name: "worker" });
    await client.services.setEnvVars(project.id, other.id, {
      environment: "production",
      vars: [{ key: "TOKEN", value: "worker-secret", isSecret: true }],
    });
    const row = (await repos.project.listEnvVars(project.id, "production", other.id))[0]!;
    await expect(
      client.services.mergeEnvVars(project.id, service.id, {
        environment: "production",
        deletes: [],
        upserts: [{ key: "TOKEN", sourceId: row.id, value: ENV_MASK }],
      }),
    ).rejects.toMatchObject({ code: "ENVIRONMENT_CHANGED" });
    const response = await app.request(
      `/api/projects/${project.id}/services/${service.id}/environment?inspectRuntime=nonsense`,
      { headers: owner.auth },
    );
    expect(response.status).toBe(400);
    const outsider = await seedOwner();
    const denied = await app.request(
      `/api/projects/${project.id}/services/${service.id}/environment`,
      { headers: outsider.auth },
    );
    expect([403, 404]).toContain(denied.status);
    expect(await repos.project.listEnvVars(project.id, "production", service.id)).toEqual([]);
  });
});
