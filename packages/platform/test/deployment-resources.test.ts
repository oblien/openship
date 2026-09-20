import { describe, expect, it, vi } from "vitest";
import { createAuthorization, createPlatform, type DeploymentResourceDependencies } from "../src";
import { alice, authorizationFixture, storedDeployment } from "./fixtures";

async function setup() {
  const state = authorizationFixture();
  for (const suffix of ["a", "b"]) {
    state.members.set(`org-${suffix}:alice`, { id: `member-${suffix}`, role: "owner" });
    state.projects.set(`project-${suffix}`, { organizationId: `org-${suffix}` });
    state.deployments.set(`dep-project-${suffix}`, { projectId: `project-${suffix}` });
  }
  const rows = [storedDeployment(), storedDeployment("project-b", "org-b")];
  const authorization = createAuthorization(state);
  const audit = vi.fn();
  let writer: ((event: string, data: string) => boolean) | undefined;
  const unsubscribe = vi.fn();
  const resources: DeploymentResourceDependencies = {
    get: vi.fn(async (id, org) => {
      const row = rows.find((row) => row.id === id && row.organizationId === org);
      if (!row) throw new Error("not found");
      return row;
    }),
    list: vi.fn(async (org) => ({ rows: rows.filter((row) => row.organizationId === org), total: 1, page: 1, perPage: 50 })),
    logs: vi.fn(async () => [{ timestamp: "now", message: "output", level: "info" }]),
    buildStatus: vi.fn(async () => ({ success: true, deployment_id: rows[0]!.id, project_id: "project-a", status: "ready", deploymentStatus: "partial_failure", is_active: false, cancellationPending: false, decisionPending: true, pendingPrompt: null })),
    reconcile: vi.fn(),
    restorePlan: vi.fn(async () => ({ mode: "instant", needsRepository: false, rebuildServices: [], untouchedServices: [] })),
    assertRepositoryAccess: vi.fn(async () => {}),
    rollback: vi.fn(async () => rows[0]!),
    cancel: vi.fn(async () => ({ success: false, pending: true, status: "cancelling", message: "Still stopping" })),
    respond: vi.fn(async () => true),
    redeploy: vi.fn(async () => ({ deployment_id: "new-deployment", project_id: "project-a" })),
    pin: vi.fn(async () => rows[0]!), keep: vi.fn(async () => ({ success: true, deployment: rows[0]! })),
    reject: vi.fn(async () => ({ success: true, restoredDeploymentId: null })),
    remove: vi.fn(async () => {}), restart: vi.fn(async () => rows[0]!), skipPortCheck: vi.fn(async () => ({ success: true })),
    subscribe: vi.fn((_id, callback) => { writer = callback; return { success: true, unsubscribe }; }),
  };
  const platform = createPlatform({ authorization, resources, recordAudit: audit,
    trigger: async () => ({ deployment: rows[0]! }), present: (row) => JSON.parse(JSON.stringify(row)),
  });
  const ctx = await authorization.resolveScope(alice, "org-a");
  return { platform, ctx, state, resources, rows, audit, unsubscribe, send: (event: string, data: string) => writer?.(event, data) };
}

describe("shared deployment lifecycle", () => {
  it("passes history filters and complete project options through the shared contract", async () => {
    const s = await setup();
    vi.mocked(s.resources.list).mockResolvedValue({ rows: s.rows.slice(0, 1), total: 41, page: 3, perPage: 20,
      projects: [{ id: "project-a", name: "Project A" }] });
    const result = await s.platform.deployments.list(s.ctx, { page: 3, perPage: 20, status: "failed", search: "earlier commit" });
    expect(s.resources.list).toHaveBeenCalledWith("org-a", { page: 3, perPage: 20, status: "failed", search: "earlier commit" });
    expect(result.data).toMatchObject({ total: 41, page: 3, perPage: 20, projects: [{ id: "project-a", name: "Project A" }] });
  });
  it("confines reads and mutations to the fixed tenant before reaching the engine", async () => {
    const s = await setup();
    await expect(s.platform.deployments.get(s.ctx, "dep-project-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(s.platform.deployments.cancel(s.ctx, "dep-project-b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s.resources.get).not.toHaveBeenCalled();
    expect(s.resources.cancel).not.toHaveBeenCalled();
    expect(s.audit).not.toHaveBeenCalled();
  });

  it("keeps cancellation's pending outcome and records the mutation once", async () => {
    const s = await setup();
    const result = await s.platform.deployments.cancel(s.ctx, "dep-project-a");
    expect(result.data).toMatchObject({ success: false, pending: true, status: "cancelling" });
    expect(s.resources.get).toHaveBeenCalledWith("dep-project-a", "org-a");
    expect(s.resources.cancel).toHaveBeenCalledWith("dep-project-a");
    expect(s.audit).toHaveBeenCalledOnce();
  });

  it("preserves the stricter cancellation/rollback authority of the HTTP controller", async () => {
    const s = await setup();
    s.state.members.set("org-a:alice", { id: "member-a", role: "restricted" });
    s.state.grants.set("org-a:alice:project:project-a", { permissions: ["write"] });
    await s.platform.deployments.respond(s.ctx, "dep-project-a", { action: "free_port" });
    await expect(s.platform.deployments.cancel(s.ctx, "dep-project-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(s.platform.deployments.rollback(s.ctx, "dep-project-a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s.resources.cancel).not.toHaveBeenCalled();
    expect(s.resources.rollback).not.toHaveBeenCalled();
  });

  it("requires repository access only when rollback needs to rebuild from source", async () => {
    const s = await setup();
    await s.platform.deployments.rollback(s.ctx, "dep-project-a");
    expect(s.resources.assertRepositoryAccess).not.toHaveBeenCalled();
    vi.mocked(s.resources.restorePlan).mockResolvedValue({ mode: "rebuild", needsRepository: true, rebuildServices: ["web"], untouchedServices: [] });
    vi.mocked(s.resources.assertRepositoryAccess).mockRejectedValue(new Error("Source denied"));
    await expect(s.platform.deployments.rollback(s.ctx, "dep-project-a")).rejects.toThrow("Source denied");
    expect(s.resources.rollback).toHaveBeenCalledOnce();
    expect(s.audit).toHaveBeenCalledOnce();
  });

  it("detaches log results so native callers cannot mutate the session's log buffer", async () => {
    const s = await setup();
    const logs = [{ timestamp: "now", message: "original", level: "info" as const }];
    vi.mocked(s.resources.logs).mockResolvedValue(logs);
    const result = await s.platform.deployments.logs(s.ctx, "dep-project-a");
    result.data[0]!.message = "changed";
    expect(logs[0]!.message).toBe("original");
  });

  it("observes revocation during streaming and releases the subscriber", async () => {
    const s = await setup();
    const iterator = s.platform.deployments.events(s.ctx, "dep-project-a");
    const first = iterator.next();
    await vi.waitFor(() => expect(s.resources.subscribe).toHaveBeenCalledOnce());
    s.send("log", JSON.stringify({ data: "aGk=", eventId: 12 }));
    await expect(first).resolves.toMatchObject({ value: { event: "log", id: "12" } });
    s.state.members.delete("org-a:alice");
    const next = iterator.next();
    s.send("ping", "{}");
    await expect(next).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(s.unsubscribe).toHaveBeenCalledOnce();
  });

  it("validates options and rejects private redeploy fields before invoking the engine", async () => {
    const s = await setup();
    await expect(s.platform.deployments.logs(s.ctx, "dep-project-a", { tail: -1 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await s.platform.deployments.redeploy(s.ctx, "dep-project-a", { useExistingCommit: true, trigger: "webhook" } as never);
    expect(s.resources.redeploy).toHaveBeenCalledWith(expect.anything(), "dep-project-a", { useExistingCommit: true });
  });
});
