/**
 * "Backup before each deploy" has to fire on EVERY deploy, exactly ONCE.
 *
 * Both halves were wrong. The trigger was reachable only from
 * `redeployBuildSession` behind a `preDeployBackup` opt-in that only the
 * app-update path passed, so an ordinary deploy — the button, a webhook push, a
 * CLI deploy — never consulted `trigger_on_pre_deploy` policies at all: the one
 * safety net an operator switches on precisely because something is about to
 * change did not run, and nothing said so. Once the hook moved to the shared
 * funnel in `executeBuildAndDeploy`, that leftover opt-in became a DUPLICATE —
 * two runs per policy for one cutover, two artifacts against the destination and
 * the retention window.
 *
 * So this file pins the wiring as well as the behaviour. The behaviour tests can
 * pass while the hook sits on a path no deploy takes (that is exactly what
 * happened), and the wiring is the part a unit test of the function cannot see.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { PromptPayload } from "@repo/core";

const h = vi.hoisted(() => ({
  policies: [] as Array<{ id: string; createdBy: string | null }>,
  /** Policy ids whose enqueue must throw, to exercise the per-policy catch. */
  failFor: new Set<string>(),
  listThrows: false,
  enqueued: [] as Array<{ policyId: string; source: string; userId: string; serviceId?: string }>,
  children: new Map<string, string[]>(),
  runs: new Map<
    string,
    {
      status: string;
      executionFinishedAt: Date | null;
      executionStartedAt?: Date | null;
      errorMessage?: string;
      serviceId?: string;
      bytesTransferred?: number;
    }
  >(),
  missing: new Set<string>(),
  readThrows: false,
  enqueueWait: undefined as Promise<void> | undefined,
}));

vi.mock("@repo/db", () => ({
  repos: {
    service: {
      listByProject: async () => [
        { id: "svc_db", name: "postgres" },
        { id: "svc_files", name: "files" },
      ],
    },
    backupPolicy: {
      listEnabledPreDeployByProject: async () => {
        if (h.listThrows) throw new Error("db is down");
        return h.policies;
      },
    },
    backupRun: {
      findById: async (id: string) => {
        if (h.readThrows) throw new Error("backup status unavailable");
        if (h.missing.has(id)) return undefined;
        return h.runs.get(id) ?? { status: "succeeded", executionFinishedAt: new Date() };
      },
    },
  },
}));

vi.mock("@repo/platform/engine/modules/backups/backup.orchestrator", () => ({
  backupOrchestrator: {
    enqueue: async (input: {
      policyId: string;
      serviceId?: string;
      trigger: { source: string; userId: string };
    }) => {
      await h.enqueueWait;
      if (h.failFor.has(input.policyId)) throw new Error("destination unreachable");
      h.enqueued.push({
        policyId: input.policyId,
        source: input.trigger.source,
        userId: input.trigger.userId,
        ...(input.serviceId ? { serviceId: input.serviceId } : {}),
      });
      const runIds = h.children.get(
        input.serviceId ? `${input.policyId}:${input.serviceId}` : input.policyId,
      ) ?? [`bkr_${input.policyId}`];
      return { runId: runIds[0], runIds };
    },
  },
}));

import { firePreDeployBackups } from "@repo/platform/engine/modules/backups/triggers/pre-deploy";

it("uses the admitted backup requirements when policies change before the worker starts", async () => {
  h.policies = [{ id: "new-policy", createdBy: "new-owner" }];
  h.listThrows = true;
  await firePreDeployBackups({ projectId: "project", organizationId: "org",
    policies: [{ id: "admitted-policy", createdBy: "original-owner" }] });
  expect(h.enqueued.map(item => item.policyId)).toEqual(["admitted-policy"]);
});

it("keeps an explicitly empty admitted set when a backup policy is added later", async () => {
  h.policies = [{ id: "new-policy", createdBy: null }];
  h.listThrows = true;
  expect(await firePreDeployBackups({ projectId: "project", organizationId: "org", policies: [] }))
    .toEqual({ enqueued: 0, completed: 0 });
  expect(h.enqueued).toEqual([]);
});

function failedBackup(extra: Partial<typeof h.runs extends Map<string, infer T> ? T : never> = {}) {
  return {
    status: "failed",
    executionStartedAt: new Date(),
    executionFinishedAt: new Date(),
    errorMessage: "dump interrupted",
    ...extra,
  };
}

function actionFor(prompt: PromptPayload, label: string): string {
  const action = prompt.actions.find((action) => action.label === label);
  expect(action).toBeDefined();
  return action!.id;
}

const API_SRC = join(__dirname, "../../../../../packages/platform/src/engine");
const read = (rel: string): string => {
  const enginePath = join(API_SRC, rel);
  return readFileSync(existsSync(enginePath) ? enginePath : join(__dirname, "../../../src", rel), "utf8");
};

beforeEach(() => {
  vi.useFakeTimers();
  h.policies = [];
  h.failFor = new Set();
  h.listThrows = false;
  h.enqueued = [];
  h.children.clear();
  h.runs.clear();
  h.missing.clear();
  h.readThrows = false;
  h.enqueueWait = undefined;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("firePreDeployBackups", () => {
  it("enqueues one pre_deploy run per enabled policy, attributed to its creator", async () => {
    h.policies = [
      { id: "pol_db", createdBy: "usr_alice" },
      { id: "pol_files", createdBy: "usr_bob" },
    ];

    const result = await firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" });

    expect(result).toEqual({ enqueued: 2, completed: 2 });
    expect(h.enqueued).toEqual([
      { policyId: "pol_db", source: "pre_deploy", userId: "usr_alice" },
      { policyId: "pol_files", source: "pre_deploy", userId: "usr_bob" },
    ]);
  });

  it("falls back to 'system' when the policy has no creator", async () => {
    h.policies = [{ id: "pol_orphan", createdBy: null }];

    await firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" });

    expect(h.enqueued[0]?.userId).toBe("system");
  });

  it("attempts the other policies but stops deployment if any enqueue fails", async () => {
    h.policies = [
      { id: "pol_a", createdBy: "usr_alice" },
      { id: "pol_broken", createdBy: "usr_alice" },
      { id: "pol_c", createdBy: "usr_alice" },
    ];
    h.failFor = new Set(["pol_broken"]);

    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" }),
    ).rejects.toThrow(/pol_broken.*destination unreachable/);
    expect(h.enqueued.map((e) => e.policyId)).toEqual(["pol_a", "pol_c"]);
  });

  it("stops deployment when policies cannot be read", async () => {
    h.listThrows = true;

    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" }),
    ).rejects.toThrow("db is down");
  });

  it("continues immediately when no pre-deploy policies are enabled", async () => {
    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" }),
    ).resolves.toEqual({ enqueued: 0, completed: 0 });
    expect(h.enqueued).toHaveLength(0);
  });

  it("holds a cache-fast cutover until every fan-out child succeeds and its worker finishes", async () => {
    // node:timers/promises uses real timers; observe each poll rather than
    // merely advancing the fake clock past states the worker never read.
    vi.useRealTimers();
    h.policies = [{ id: "pol_project", createdBy: "user" }];
    h.children.set("pol_project", ["bkr_db", "bkr_files"]);
    h.runs.set("bkr_db", { status: "uploading", executionFinishedAt: null });
    h.runs.set("bkr_files", { status: "queued", executionFinishedAt: null });
    const cutover = vi.fn();
    const log = vi.fn();
    const result = firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1", log }).then(
      cutover,
    );
    await vi.waitFor(() => expect(h.enqueued).toHaveLength(1));
    expect(cutover).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(expect.stringContaining("bkr_files: queued")),
    );
    expect(cutover).not.toHaveBeenCalled();
    h.runs.set("bkr_db", { status: "succeeded", executionFinishedAt: new Date() });
    await vi.waitFor(
      () => expect(log).toHaveBeenCalledWith(expect.stringContaining("bkr_db succeeded")),
      { timeout: 3000 },
    );
    expect(cutover).not.toHaveBeenCalled();
    h.runs.set("bkr_files", { status: "succeeded", executionFinishedAt: null });
    await vi.waitFor(
      () => expect(log).toHaveBeenCalledWith(expect.stringContaining("finishing cleanup")),
      { timeout: 3000 },
    );
    expect(cutover).not.toHaveBeenCalled();
    h.runs.set("bkr_files", { status: "succeeded", executionFinishedAt: new Date() });
    await result;
    expect(cutover).toHaveBeenCalledExactlyOnceWith({ enqueued: 2, completed: 2 });
  });

  it.each(["failed", "cancelled", "server_error"])(
    "stops cutover for a %s backup",
    async (status) => {
      h.policies = [{ id: "pol_db", createdBy: null }];
      h.runs.set("bkr_pol_db", {
        status,
        executionFinishedAt: null,
        errorMessage: "dump interrupted",
      });
      const cutover = vi.fn();
      await expect(
        firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" }).then(cutover),
      ).rejects.toThrow(`bkr_pol_db ${status}: dump interrupted`);
      expect(cutover).not.toHaveBeenCalled();
    },
  );

  it("fails closed if a run disappears or its status cannot be read", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.missing.add("bkr_pol_db");
    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" }),
    ).rejects.toThrow("bkr_pol_db disappeared");
    h.readThrows = true;
    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" }),
    ).rejects.toThrow("backup status unavailable");
  });

  it("does not treat an empty fan-out as a completed backup", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.children.set("pol_db", []);
    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" }),
    ).rejects.toThrow("no backup runs were created");
  });

  it("cancels a waiting deploy without starting its new release", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.runs.set("bkr_pol_db", { status: "uploading", executionFinishedAt: null });
    const controller = new AbortController();
    const result = firePreDeployBackups({
      projectId: "prj_1",
      organizationId: "org_1",
      signal: controller.signal,
    });
    const rejection = expect(result).rejects.toMatchObject({ name: "DeploymentCancelledError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejection;
  });

  it("does not enqueue work for a deploy that is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      firePreDeployBackups({
        projectId: "prj_1",
        organizationId: "org_1",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "DeploymentCancelledError" });
    expect(h.enqueued).toHaveLength(0);
  });

  it("stops waiting at the backup ceiling instead of leaving a deploy stuck forever", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.runs.set("bkr_pol_db", { status: "queued", executionFinishedAt: null });
    const result = firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1" });
    const rejection = expect(result).rejects.toThrow(/timed out.*bkr_pol_db/);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
  });

  it("holds a failed backup for an explicit decision and records a one-deployment bypass", async () => {
    h.policies = [{ id: "pol_db", createdBy: "user" }];
    h.runs.set("bkr_pol_db", failedBackup());
    let answer!: (action: string) => void;
    const promptUser = vi.fn(
      (_prompt: PromptPayload) =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    const log = vi.fn();
    const cutover = vi.fn();
    const result = firePreDeployBackups({
      projectId: "prj_1",
      organizationId: "org_1",
      log,
      promptUser,
    }).then(cutover);
    await vi.advanceTimersByTimeAsync(0);
    expect(promptUser).toHaveBeenCalledOnce();
    expect(cutover).not.toHaveBeenCalled();
    const prompt = promptUser.mock.calls[0]![0];
    expect(prompt.actions.map((action) => action.label)).toEqual([
      "Retry backup",
      "Continue without backup",
      "Stop deployment",
    ]);
    expect(prompt.details?.backupErrors).toEqual(["bkr_pol_db failed: dump interrupted"]);
    answer(actionFor(prompt, "Continue without backup"));
    await result;
    expect(cutover).toHaveBeenCalledExactlyOnceWith({ enqueued: 1, completed: 0 });
    expect(h.runs.get("bkr_pol_db")?.status).toBe("failed");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("User chose Continue without backup for this deployment"),
      "warn",
    );
    expect(h.enqueued).toHaveLength(1);
  });

  it("offers retry only after failed-worker cleanup and all siblings finish, then retries only the failed source", async () => {
    vi.useRealTimers();
    h.policies = [{ id: "pol_project", createdBy: "user" }];
    h.children.set("pol_project", ["bkr_db", "bkr_files"]);
    h.children.set("pol_project:svc_db", ["bkr_db_retry"]);
    h.runs.set("bkr_db", failedBackup({ serviceId: "svc_db", executionFinishedAt: null }));
    h.runs.set("bkr_files", {
      status: "uploading",
      serviceId: "svc_files",
      executionFinishedAt: null,
    });
    const promptUser = vi.fn(async (prompt: PromptPayload) => actionFor(prompt, "Retry backup"));
    const log = vi.fn();
    const cutover = vi.fn();
    const controller = new AbortController();
    const result = firePreDeployBackups({
      projectId: "prj_1",
      organizationId: "org_1",
      log,
      promptUser,
      signal: controller.signal,
    }).then(cutover);
    try {
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(expect.stringContaining("finishing cleanup"), "warn"),
      );
      expect(promptUser).not.toHaveBeenCalled();
      h.runs.set("bkr_db", failedBackup({ serviceId: "svc_db" }));
      await vi.waitFor(
        () =>
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining("postgres (bkr_db) failed: dump interrupted"),
            "warn",
          ),
        { timeout: 3000 },
      );
      expect(promptUser).not.toHaveBeenCalled();
      expect(cutover).not.toHaveBeenCalled();
      h.runs.set("bkr_files", {
        status: "succeeded",
        serviceId: "svc_files",
        executionFinishedAt: new Date(),
      });
      await result;
      expect(promptUser).toHaveBeenCalledOnce();
      expect(h.enqueued).toEqual([
        { policyId: "pol_project", source: "pre_deploy", userId: "user" },
        { policyId: "pol_project", source: "pre_deploy", userId: "user", serviceId: "svc_db" },
      ]);
      expect(cutover).toHaveBeenCalledExactlyOnceWith({ enqueued: 3, completed: 2 });
    } finally {
      controller.abort();
      await result.catch(() => {});
    }
  });

  it("retries a policy that could not enqueue without repeating successful policies", async () => {
    h.policies = [
      { id: "pol_ok", createdBy: "user" },
      { id: "pol_bad", createdBy: "user" },
    ];
    h.failFor.add("pol_bad");
    const promptUser = vi.fn(async (prompt: PromptPayload) => {
      h.failFor.clear();
      return actionFor(prompt, "Retry backup");
    });
    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1", promptUser }),
    ).resolves.toEqual({ enqueued: 2, completed: 2 });
    expect(h.enqueued.map((target) => target.policyId)).toEqual(["pol_ok", "pol_bad"]);
  });

  it.each(["Stop deployment", "invented-action"])("does not continue on %s", async (choice) => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.runs.set("bkr_pol_db", failedBackup());
    const promptUser = vi.fn(async (prompt: PromptPayload) =>
      choice === "invented-action" ? choice : actionFor(prompt, choice),
    );
    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1", promptUser }),
    ).rejects.toThrow("deployment stopped");
    expect(h.enqueued).toHaveLength(1);
  });

  it("stops without bypassing a failed backup if the prompt expires", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.runs.set("bkr_pol_db", failedBackup());
    const promptUser = vi.fn(async () => {
      throw new Error("Prompt timed out - no response from user");
    });
    const log = vi.fn();
    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1", promptUser, log }),
    ).rejects.toThrow("Prompt timed out");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("No backup decision received; deployment stopped"),
      "warn",
    );
    expect(h.enqueued).toHaveLength(1);
  });

  it("cancels while a backup decision is held", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.runs.set("bkr_pol_db", failedBackup());
    const controller = new AbortController();
    const promptUser = vi.fn(() => new Promise<string>(() => {}));
    const result = firePreDeployBackups({
      projectId: "prj_1",
      organizationId: "org_1",
      promptUser,
      signal: controller.signal,
    });
    const rejection = expect(result).rejects.toMatchObject({ name: "DeploymentCancelledError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(promptUser).toHaveBeenCalledOnce();
    controller.abort();
    await rejection;
    expect(h.enqueued).toHaveLength(1);
  });

  it("keeps queue progress visible and cancellation responsive if the job runner stalls", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.enqueueWait = new Promise(() => {});
    const controller = new AbortController();
    const log = vi.fn();
    const promptUser = vi.fn();
    const result = firePreDeployBackups({
      projectId: "prj_1",
      organizationId: "org_1",
      log,
      promptUser,
      signal: controller.signal,
    });
    const rejection = expect(result).rejects.toMatchObject({ name: "DeploymentCancelledError" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Still queueing policy pol_db; 30s elapsed"),
    );
    controller.abort();
    await rejection;
    expect(promptUser).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancelled", "server_error"])(
    "allows a decision for an unclaimed %s run that can no longer start",
    async (status) => {
      h.policies = [{ id: "pol_db", createdBy: null }];
      h.runs.set(
        "bkr_pol_db",
        failedBackup({ status, executionStartedAt: null, executionFinishedAt: null }),
      );
      const promptUser = vi.fn(async (prompt: PromptPayload) =>
        actionFor(prompt, "Continue without backup"),
      );
      await expect(
        firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1", promptUser }),
      ).resolves.toEqual({ enqueued: 1, completed: 0 });
      expect(promptUser).toHaveBeenCalledOnce();
    },
  );

  it("never offers a bypass when a run cannot be read", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    const promptUser = vi.fn();
    h.missing.add("bkr_pol_db");
    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1", promptUser }),
    ).rejects.toThrow("disappeared");
    h.readThrows = true;
    await expect(
      firePreDeployBackups({ projectId: "prj_1", organizationId: "org_1", promptUser }),
    ).rejects.toThrow("backup status unavailable");
    expect(promptUser).not.toHaveBeenCalled();
  });

  it("logs elapsed time and uploaded bytes during a long backup without pausing it for a prompt", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.runs.set("bkr_pol_db", {
      status: "uploading",
      serviceId: "svc_db",
      bytesTransferred: 1024,
      executionFinishedAt: null,
    });
    let reportProgress!: () => void;
    const progress = new Promise<void>((resolve) => {
      reportProgress = resolve;
    });
    const log = vi.fn((line: string) => {
      if (line.includes("Still waiting")) reportProgress();
    });
    const promptUser = vi.fn();
    const controller = new AbortController();
    const result = firePreDeployBackups({
      projectId: "prj_1",
      organizationId: "org_1",
      log,
      promptUser,
      signal: controller.signal,
    });
    const rejection = expect(result).rejects.toMatchObject({ name: "DeploymentCancelledError" });
    try {
      await vi.advanceTimersByTimeAsync(0);
      h.runs.get("bkr_pol_db")!.bytesTransferred = 512 * 1024 * 1024;
      vi.setSystemTime(Date.now() + 5 * 60_000);
      await progress;
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("postgres (bkr_pol_db): uploading; 5m elapsed; 512 MB uploaded"),
      );
      expect(promptUser).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await rejection;
    }
  });

  it("does not offer retry or skip for a timed-out worker that has not released its lease", async () => {
    h.policies = [{ id: "pol_db", createdBy: null }];
    h.runs.set("bkr_pol_db", failedBackup({ status: "server_error", executionFinishedAt: null }));
    const promptUser = vi.fn();
    const result = firePreDeployBackups({
      projectId: "prj_1",
      organizationId: "org_1",
      promptUser,
    });
    const rejection = expect(result).rejects.toThrow(/timed out.*bkr_pol_db/);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
    await rejection;
    expect(promptUser).not.toHaveBeenCalled();
  });
});

describe("deploy wiring", () => {
  it("is called from the shared build→deploy funnel, and from nowhere else", () => {
    const callers = [
      "modules/deployments/build-pipeline.ts",
      "modules/deployments/build.service.ts",
      "modules/deployments/compose/deploy.service.ts",
      "modules/updates/updates.service.ts",
    ].filter((rel) => /firePreDeployBackups\s*\(/.test(read(rel)));

    expect(callers).toEqual(["modules/deployments/build-pipeline.ts"]);
  });

  it("fires once per deploy, before the mode branch and before the build", () => {
    const src = read("modules/deployments/build-pipeline.ts");
    const calls = src.match(/firePreDeployBackups\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const hook = src.indexOf("firePreDeployBackups(");
    // The compose/single-app split, and the first thing either branch does. A
    // hook after either one is the bug this file exists for: inside the branch it
    // misses the other mode, after the build it races the cutover it is meant to
    // precede.
    const modeBranch = src.indexOf("if (useServicePipeline && isMultiServiceRuntime(runtime))");
    const composeBuild = src.indexOf("await executeComposePipeline(");
    expect(modeBranch).toBeGreaterThan(-1);
    expect(composeBuild).toBeGreaterThan(-1);
    expect(hook).toBeLessThan(modeBranch);
    expect(hook).toBeLessThan(composeBuild);
  });

  it("no deploy entry point carries a pre-deploy opt-in of its own", () => {
    // `redeployBuildSession(..., { preDeployBackup: true })` was the old opt-in.
    // Re-introducing a flag like it means one entry point backs up twice and the
    // rest are back to relying on a caller remembering.
    expect(read("modules/deployments/build.service.ts")).not.toMatch(/preDeployBackup/);
    expect(read("modules/updates/updates.service.ts")).not.toMatch(/preDeployBackup/);
  });
});
