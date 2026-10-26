import { repos, seedOwner, installFakeRunner } from "../jobs/_harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ENV_MASK } from "@repo/core";
import { OpenshipClient } from "@repo/sdk/client";
import { encrypt, decrypt } from "@repo/platform/engine/lib/encryption";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { seedProject, seedService } from "../../helpers/seed";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes);

describe("project environment merge through HTTP, SDK and real storage", () => {
  let owner: Awaited<ReturnType<typeof seedOwner>>;
  let project: Awaited<ReturnType<typeof seedProject>>;
  let client: OpenshipClient;
  const rows = () => repos.project.listEnvVars(project.id, "production", null);
  beforeEach(async () => {
    owner = await seedOwner();
    project = await seedProject(owner.orgId);
    await repos.project.bulkSetEnvVars(project.id, "production", [
      { key: "API_KEY", value: encrypt("real-secret"), isSecret: true },
      { key: "KEEP", value: encrypt("keep-me"), isSecret: false },
    ]);
    client = new OpenshipClient({
      baseUrl: "http://openship.test",
      token: owner.token,
      organizationId: owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps a stored secret secret when an upsert omits isSecret", async () => {
    await client.projects.mergeEnvVars(project.id, {
      environment: "production",
      upserts: [{ key: "API_KEY", value: "rotated" }],
      deletes: [],
    });
    const row = (await rows()).find((row) => row.key === "API_KEY")!;
    expect(row.isSecret).toBe(true);
    expect(decrypt(row.value)).toBe("rotated");
    const listed = await client.projects.listEnvVars(project.id);
    expect(listed.find((row) => row.key === "API_KEY")!.value).toBe(ENV_MASK);
    expect(JSON.stringify(listed)).not.toContain("rotated");
  });

  it("still lets an explicit isSecret false unmark a secret", async () => {
    await client.projects.mergeEnvVars(project.id, {
      environment: "production",
      upserts: [{ key: "API_KEY", value: "now-public", isSecret: false }],
      deletes: [],
    });
    const listed = await client.projects.listEnvVars(project.id);
    expect(listed.find((row) => row.key === "API_KEY")).toMatchObject({
      isSecret: false,
      value: "now-public",
    });
  });

  it("keeps the stored ciphertext when the list mask is sent back", async () => {
    const before = (await rows()).find((row) => row.key === "API_KEY")!.value;
    await client.projects.mergeEnvVars(project.id, {
      environment: "production",
      upserts: [{ key: "API_KEY", value: ENV_MASK }],
      deletes: [],
    });
    expect((await rows()).find((row) => row.key === "API_KEY")!.value).toBe(before);
  });

  it("refuses an unknown mask without partially applying other edits", async () => {
    await expect(
      client.projects.mergeEnvVars(project.id, {
        environment: "production",
        upserts: [
          { key: "NEW", value: "must-not-save" },
          { key: "UNKNOWN", value: ENV_MASK },
        ],
        deletes: ["KEEP"],
      }),
    ).rejects.toThrow(/No saved value exists/);
    expect((await rows()).map((row) => row.key).sort()).toEqual(["API_KEY", "KEEP"]);
  });

  it.each(["MY VAR=1", "1ST", "A-B"])("refuses invalid key %s before writing", async (key) => {
    await expect(
      client.projects.mergeEnvVars(project.id, {
        environment: "production",
        upserts: [{ key, value: "x" }],
        deletes: [],
      }),
    ).rejects.toThrow(/Invalid environment variable name/);
    expect((await rows()).map((row) => row.key).sort()).toEqual(["API_KEY", "KEEP"]);
  });

  it("rejects NUL values before writing", async () => {
    await expect(
      client.projects.mergeEnvVars(project.id, {
        environment: "production",
        upserts: [{ key: "API_KEY", value: "x\0y" }],
        deletes: [],
      }),
    ).rejects.toThrow(/NUL/);
    expect(decrypt((await rows()).find((row) => row.key === "API_KEY")!.value)).toBe("real-secret");
  });

  it("infers secret-looking new keys without changing other scopes", async () => {
    const service = await seedService(project.id, { name: "worker" });
    await repos.project.bulkSetEnvVars(project.id, "preview", [
      { key: "API_KEY", value: encrypt("preview"), isSecret: true },
    ]);
    await repos.project.bulkSetEnvVars(
      project.id,
      "production",
      [{ key: "API_KEY", value: encrypt("service"), isSecret: true }],
      service.id,
    );
    await client.projects.mergeEnvVars(project.id, {
      environment: "production",
      upserts: [
        { key: "DATABASE_PASSWORD", value: "pw" },
        { key: "PUBLIC_URL", value: "https://example.com" },
      ],
      deletes: [],
    });
    const saved = await rows();
    expect(saved.find((row) => row.key === "DATABASE_PASSWORD")!.isSecret).toBe(true);
    expect(saved.find((row) => row.key === "PUBLIC_URL")!.isSecret).toBe(false);
    expect(decrypt((await repos.project.listEnvVars(project.id, "preview", null))[0]!.value)).toBe(
      "preview",
    );
    expect(
      decrypt((await repos.project.listEnvVars(project.id, "production", service.id))[0]!.value),
    ).toBe("service");
  });

  // Commit a second writer after the service's read but before its write lock.
  // Only the interleaving is injected: both writes and the transaction are real.
  function rotateAfterRead(value: string, isSecret: boolean) {
    const read = repos.project.listEnvVars.bind(repos.project);
    vi.spyOn(repos.project, "listEnvVars").mockImplementationOnce(async (...args) => {
      const before = await read(...args);
      await repos.project.mergeEnvVars(
        project.id,
        "production",
        [{ key: "API_KEY", value: encrypt(value), isSecret }],
        [],
      );
      return before;
    });
  }

  it("does not restore an old secret after a concurrent rotation or partially apply the request", async () => {
    rotateAfterRead("concurrent-secret", true);
    await expect(
      client.projects.mergeEnvVars(project.id, {
        environment: "production",
        upserts: [
          { key: "API_KEY", value: ENV_MASK },
          { key: "NEW", value: "must-not-save" },
        ],
        deletes: ["KEEP"],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const saved = await rows();
    expect(saved.map((row) => row.key).sort()).toEqual(["API_KEY", "KEEP"]);
    expect(decrypt(saved.find((row) => row.key === "API_KEY")!.value)).toBe("concurrent-secret");
  });

  it("does not restore an old secrecy flag after another writer changes it", async () => {
    rotateAfterRead("now-public", false);
    await expect(
      client.projects.mergeEnvVars(project.id, {
        environment: "production",
        upserts: [{ key: "API_KEY", value: "next" }],
        deletes: [],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const saved = (await rows()).find((row) => row.key === "API_KEY")!;
    expect(saved.isSecret).toBe(false);
    expect(decrypt(saved.value)).toBe("now-public");
  });

  it("allows unrelated concurrent edits", async () => {
    rotateAfterRead("concurrent-secret", true);
    await client.projects.mergeEnvVars(project.id, {
      environment: "production",
      upserts: [{ key: "KEEP", value: "changed" }],
      deletes: [],
    });
    const saved = await rows();
    expect(decrypt(saved.find((row) => row.key === "API_KEY")!.value)).toBe("concurrent-secret");
    expect(decrypt(saved.find((row) => row.key === "KEEP")!.value)).toBe("changed");
  });

  it("refuses writes from another organization", async () => {
    const outsider = await seedOwner();
    const response = await app.request(`/api/projects/${project.id}/env`, {
      method: "PATCH",
      headers: { ...outsider.auth, "content-type": "application/json" },
      body: JSON.stringify({
        environment: "production",
        upserts: [{ key: "API_KEY", value: "intruder" }],
        deletes: [],
      }),
    });
    expect([403, 404]).toContain(response.status);
    expect(decrypt((await rows()).find((row) => row.key === "API_KEY")!.value)).toBe("real-secret");
  });
});
