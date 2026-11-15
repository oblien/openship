import { beforeEach, describe, expect, it } from "vitest";
import {
  RailwayProjectTransfer,
  matchesRailwayPatch,
  railwayMaintenancePatch,
  type RailwayTransferDriver,
  type RailwayTransferState,
} from "@repo/platform/engine/modules/migration/providers/railway-project-transfer";
import type { PrivateImportPlan } from "@repo/platform/engine/modules/migration/platform-import-plan";

function fixture() {
  const services = ["postgres", "unknown-store", "worker"];
  const config: Record<string, any> = Object.fromEntries(
    services.map((id) => [
      id,
      {
        source: { image: `example/${id}:1` },
        deploy: { startCommand: `run-${id}`, cronSchedule: null },
        variables: { SECRET: { value: "private" } },
        volumeMounts: id === "worker" ? {} : { [`${id}-volume`]: { mountPath: "/data" } },
      },
    ]),
  );
  const original = structuredClone(config);
  const deployments = new Map<string, any>(
    services.map((id) => [
      id + "-live",
      {
        id: id + "-live",
        serviceId: id,
        status: "SUCCESS",
        deploymentStopped: false,
        meta: {
          image: `example/${id}:1`,
          imageDigest: id,
          serviceManifest: { deploy: { startCommand: `run-${id}` } },
        },
      },
    ]),
  );
  const events: string[] = [];
  let saved: RailwayTransferState | undefined;
  let pending = false;
  let staged = 0;
  let loseDeployResponse = false;
  let loseResumeResponse = false;
  const merge = (target: any, patch: any) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value && typeof value === "object" && !Array.isArray(value))
        merge((target[key] ??= {}), value);
      else target[key] = value;
    }
  };
  const driver: RailwayTransferDriver = {
    log: (message) => events.push(message),
    sleep: async () => {},
    save: async (state, needsCleanup) => {
      saved = structuredClone(state);
      pending = needsCleanup;
      events.push("save");
    },
    query: async <T>(query: string, v: Record<string, any>): Promise<T> => {
      if (query.includes("environment(id:"))
        return {
          environment: {
            config: structuredClone({ services: config }),
            // Current Railway responses can omit this computed count even
            // though environmentStagedChanges returns the actual staged patch.
            unmergedChangesCount: null,
            serviceInstances: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: services.map((id) => ({
                node: {
                  serviceId: id,
                  activeDeployments: [...deployments.values()].filter((d) => d.serviceId === id),
                },
              })),
            },
          },
          environmentStagedChanges: { patch: staged ? { services: {} } : {} },
        } as T;
      if (query.includes("deployment(id:"))
        return { deployment: structuredClone(deployments.get(v.id)) } as T;
      if (query.includes("deploymentStop")) {
        expect(saved).toBeDefined();
        events.push(`stop:${v.id}`);
        deployments.get(v.id).deploymentStopped = true;
        return { deploymentStop: true } as T;
      }
      if (query.includes("deploymentCancel")) {
        events.push(`cancel:${v.id}`);
        Object.assign(deployments.get(v.id), { status: "REMOVED", deploymentStopped: true });
        return { deploymentCancel: true } as T;
      }
      if (query.includes("environmentPatchCommit")) {
        expect(query).toContain("skipDeploys: true");
        expect(saved?.patchRequested).toBe(true);
        expect([...deployments.values()].every((d) => d.deploymentStopped)).toBe(true);
        events.push("patch");
        for (const [id, patch] of Object.entries(v.patch.services)) merge(config[id], patch);
        return { environmentPatchCommit: "workflow" } as T;
      }
      if (query.includes("serviceInstanceDeployV2")) {
        const id = v.service + "-export";
        events.push(`export:${v.service}`);
        deployments.set(id, {
          id,
          serviceId: v.service,
          status: "SUCCESS",
          deploymentStopped: false,
          meta: { serviceManifest: { deploy: structuredClone(config[v.service].deploy) } },
        });
        if (loseDeployResponse) throw new Error("response lost");
        return { serviceInstanceDeployV2: id } as T;
      }
      if (query.includes("deploymentRedeploy")) {
        expect(query).toContain("usePreviousImageTag: true");
        const previous = deployments.get(v.id),
          id = previous.id + "-resume";
        deployments.set(id, {
          ...structuredClone(previous),
          id,
          deploymentStopped: false,
          meta: { ...structuredClone(previous.meta), reason: "redeploy" },
        });
        events.push(`resume:${previous.serviceId}`);
        if (loseResumeResponse) {
          loseResumeResponse = false;
          throw new Error("resume response lost");
        }
        return { deploymentRedeploy: { id } } as T;
      }
      throw new Error("Unexpected query");
    },
  };
  const plan = {
    inventory: { source: { projectId: "project", environmentId: "environment" } },
    services: services.map((id) => ({
      source: {
        id,
        name: id,
        deploymentIds: [id + "-live"],
        volumes: id === "worker" ? [] : [{ id: id + "-volume", mountPath: "/data" }],
      },
      data: "copy",
    })),
  } as PrivateImportPlan;
  return {
    controller: new RailwayProjectTransfer(driver),
    plan,
    events,
    config,
    deployments,
    original,
    state: () => saved!,
    pending: () => pending,
    stage: () => {
      staged = 1;
    },
    loseResponse: () => {
      loseDeployResponse = true;
    },
    loseResumeResponse: () => {
      loseResumeResponse = true;
    },
  };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});

describe("generic Railway project lifecycle", () => {
  it("stops every writer before starting export-only containers, without engine-specific commands or moving mounts", async () => {
    const state = await f.controller.prepare("run", f.plan, new AbortController().signal);
    expect(f.events.filter((e) => e.startsWith("stop:"))).toEqual([
      "stop:postgres-live",
      "stop:unknown-store-live",
      "stop:worker-live",
    ]);
    expect(f.events.indexOf("patch")).toBeGreaterThan(f.events.indexOf("stop:worker-live"));
    expect(f.events).toContain("export:unknown-store");
    expect(f.events).not.toContain("export:worker");
    for (const id of Object.keys(f.config)) {
      expect(f.config[id].volumeMounts).toEqual(f.original[id].volumeMounts);
      expect(f.config[id].variables).toEqual(f.original[id].variables);
    }
    await f.controller.restore(state, false);
    for (const id of Object.keys(f.config))
      expect(matchesRailwayPatch(f.config[id], f.original[id])).toBe(true);
    expect([...f.deployments.values()].every((d) => d.deploymentStopped)).toBe(true);
    expect(f.pending()).toBe(false);
    expect(f.events.some((e) => e.startsWith("resume:"))).toBe(false);
  });

  it("recovers a lost exporter deployment response by its run-specific marker", async () => {
    f.loseResponse();
    await expect(f.controller.prepare("run", f.plan, new AbortController().signal)).rejects.toThrow(
      "response lost",
    );
    expect(f.state().services[0].exportDeployment).toBeUndefined();
    await f.controller.restore(f.state(), true);
    expect(f.deployments.get("postgres-export").deploymentStopped).toBe(true);
    expect(f.events.filter((e) => e.startsWith("resume:"))).toHaveLength(3);
    expect(f.pending()).toBe(false);
  });

  it("refuses staged changes and incomplete project selections before source mutation", async () => {
    f.stage();
    await expect(
      f.controller.prepare("run", f.plan, new AbortController().signal),
    ).rejects.toMatchObject({ code: "IMPORT_SOURCE_STAGED_CHANGES" });
    expect(f.events).toEqual([]);
    f = fixture();
    f.plan.services.pop();
    await expect(
      f.controller.prepare("run", f.plan, new AbortController().signal),
    ).rejects.toMatchObject({ code: "IMPORT_PROJECT_INCOMPLETE" });
    expect(f.events).toEqual([]);
  });

  it("detects a newly deployed source before taking downtime", async () => {
    f.deployments.get("postgres-live").id = "different-deployment";
    await expect(
      f.controller.prepare("run", f.plan, new AbortController().signal),
    ).rejects.toMatchObject({ code: "IMPORT_SOURCE_CHANGED" });
    expect(f.events).toEqual([]);
  });

  it("does not overwrite an operator's configuration during recovery", async () => {
    await f.controller.prepare("run", f.plan, new AbortController().signal);
    f.config.postgres.source.image = "operator/new-image:1";
    const patchesBefore = f.events.filter((e) => e === "patch").length;
    await expect(f.controller.restore(f.state(), true)).rejects.toMatchObject({
      code: "IMPORT_SOURCE_CHANGED",
    });
    expect(f.events.filter((e) => e === "patch")).toHaveLength(patchesBefore);
    expect(f.pending()).toBe(true);
  });

  it.each(["configuration", "deployment"])(
    "preserves a later operator %s after export configuration was already restored",
    async (change) => {
      await f.controller.prepare("run", f.plan, new AbortController().signal);
      await f.controller.restore(f.state(), false);
      if (change === "configuration") f.config.worker.deploy.startCommand = "operator-command";
      else
        f.deployments.set("operator", {
          ...structuredClone(f.deployments.get("worker-live")),
          id: "operator",
          deploymentStopped: false,
        });
      const before = [...f.events];
      await expect(f.controller.restore(f.state(), true)).rejects.toMatchObject({
        code: "IMPORT_SOURCE_CHANGED",
      });
      expect(f.events).toEqual(before);
    },
  );

  it("recovers a lost resume response without requesting a second deployment", async () => {
    await f.controller.prepare("run", f.plan, new AbortController().signal);
    await f.controller.restore(f.state(), false);
    f.loseResumeResponse();
    await expect(f.controller.restore(f.state(), true)).rejects.toThrow("resume response lost");
    await f.controller.restore(f.state(), true);
    expect(f.events.filter((e) => e.startsWith("resume:"))).toEqual([
      "resume:postgres",
      "resume:unknown-store",
      "resume:worker",
    ]);
    expect(f.pending()).toBe(false);
  });

  it("refuses a source application that starts during the copy", async () => {
    await f.controller.prepare("run", f.plan, new AbortController().signal);
    f.deployments.get("worker-live").deploymentStopped = false;
    await expect(f.controller.assertExportOnly(f.state())).rejects.toMatchObject({
      code: "IMPORT_SOURCE_STARTED",
    });
  });

  it("cancels a queued exporter on recovery before restoring application configuration", async () => {
    await f.controller.prepare("run", f.plan, new AbortController().signal);
    Object.assign(f.deployments.get("postgres-export"), {
      status: "BUILDING",
      deploymentStopped: true,
    });
    await f.controller.restore(f.state(), false);
    expect(f.events).toContain("cancel:postgres-export");
    expect(f.events.indexOf("cancel:postgres-export")).toBeLessThan(f.events.lastIndexOf("patch"));
  });

  it("treats omitted provider fields as null without treating unrelated fields as owned", () => {
    expect(
      matchesRailwayPatch(
        { unrelated: true, source: { image: "alpine:3" } },
        { source: { image: "alpine:3", repo: null } },
      ),
    ).toBe(true);
    expect(
      matchesRailwayPatch({ source: { image: "changed" } }, { source: { image: "alpine:3" } }),
    ).toBe(false);
    expect(matchesRailwayPatch({ deploy: {} }, { deploy: { sleepApplication: false } })).toBe(true);
    expect(
      matchesRailwayPatch(
        { deploy: { sleepApplication: true } },
        { deploy: { sleepApplication: false } },
      ),
    ).toBe(false);
    expect(railwayMaintenancePatch("run")).toMatchObject({
      deploy: { healthcheckPath: null, cronSchedule: null, preDeployCommand: null },
    });
  });
});
