import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@repo/core";

const h = vi.hoisted(() => ({
  cloud: true,
  releaseFails: false,
  workspace: null as any,
  project: null as any,
  run: null as any,
  deployments: [] as any[],
  restores: [] as any[],
  migration: null as any,
  otherBackups: [] as any[],
  beforeLock: undefined as (() => void) | undefined,
  list: vi.fn(),
  acknowledge: vi.fn(),
  recover: vi.fn(),
  diagnostic: vi.fn(),
  sweep: vi.fn(),
}));
vi.mock("../src/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/core/diagnostics", () => ({ diagnostics: { warn: h.diagnostic } }));
vi.mock("@repo/adapters", async () => import("../../adapters/src/runtime/cloud/command-tracking"));
vi.mock("../src/engine/lib/cloud/server-link", () => ({
  remoteCloudRequest: vi.fn(),
  requireLinkedCloudServer: vi.fn(),
}));
vi.mock("../src/engine/lib/provision-lock", async () => {
  const { withKeyedMutex, tryWithKeyedMutex } = await import("@repo/core");
  return {
    createProvisionLock: (key: string) => ({
      run: (work: () => Promise<unknown>) => withKeyedMutex(key, work),
    }),
    tryWithProvisionLock: (key: string, work: () => Promise<unknown>) =>
      tryWithKeyedMutex(key, () => {
        if (key.startsWith("cloud:workspace-activity:")) {
          const hook = h.beforeLock;
          h.beforeLock = undefined;
          hook?.();
        }
        return work();
      }),
  };
});
vi.mock("../src/engine/lib/cloud-workspace-host", () => ({
  openCloudWorkspaceExecutor: async () => ({ recoverCommand: h.recover, dispose: async () => {} }),
}));
vi.mock("@repo/db", () => ({
  repos: {
    cloudWorkspace: {
      findById: async () => h.workspace,
      claimActivity: async (_id: string, _org: string, activity: any) => {
        const old = h.workspace.activity;
        if (
          old &&
          (old.id !== activity.id ||
            old.scope !== activity.scope ||
            old.controllerId !== activity.controllerId)
        )
          throw new AppError("busy", 409, "CLOUD_WORKSPACE_ACTIVITY_BUSY");
        return (h.workspace.activity ??= activity);
      },
      completeActivityCommand: async (_id: string, _activity: string, marker: string) => {
        h.workspace.activity.commands = h.workspace.activity.commands.filter(
          (c: any) => c.marker !== marker,
        );
      },
      settleActivity: async () => {
        h.workspace.activity.settled = true;
      },
      releaseActivity: async () => {
        if (h.releaseFails) throw new Error("release temporarily unavailable");
        h.workspace.activity = null;
      },
    },
    project: { findById: async () => h.project },
    backupRun: {
      sweepRunsWithStaleHeartbeat: h.sweep,
      listUnfinishedCloudExecutions: h.list,
      acknowledgeRecoveredExecution: h.acknowledge,
      listInFlightByProject: async () => [
        ...(h.run.executionFinishedAt ? [] : [h.run]),
        ...h.otherBackups,
      ],
    },
    deployment: { listInFlightByProject: async () => h.deployments },
    backupRestore: { listInFlightByProject: async () => h.restores },
    dockerMigrationRun: { findActiveForProject: async () => h.migration },
  },
}));

import { createProvisionLock } from "../src/engine/lib/provision-lock";
import {
  recoverOrphanedCloudBackupExecutions,
  runBackupStaleSweep,
} from "../src/engine/modules/backups/backup-stale-sweep";

const candidate = {
  runId: "backup",
  projectId: "project",
  organizationId: "org",
  workspaceId: "workspace",
};
beforeEach(() => {
  vi.resetAllMocks();
  h.cloud = true;
  h.releaseFails = false;
  h.beforeLock = undefined;
  h.project = { id: "project", organizationId: "org", workspaceId: "workspace" };
  h.run = {
    id: "backup",
    status: "server_error",
    finishedAt: new Date(),
    executionFinishedAt: null,
  };
  h.workspace = {
    id: "workspace",
    organizationId: "org",
    remote: null,
    activity: {
      id: "old-activity",
      controllerId: "saas",
      scope: "project:project",
      startedAt: new Date(0).toISOString(),
      commands: [
        { workspaceId: "vm", marker: "request-one", kind: "docker" },
        { workspaceId: "vm", marker: "request-two", kind: "docker" },
      ],
    },
  };
  h.deployments = [];
  h.restores = [];
  h.otherBackups = [];
  h.migration = null;
  h.list.mockResolvedValue([candidate]);
  h.sweep.mockResolvedValue(0);
  h.recover.mockResolvedValue(undefined);
  h.acknowledge.mockImplementation(async () => {
    expect(h.workspace.activity).toBeNull();
    h.run.executionFinishedAt = new Date();
    return true;
  });
});

it("recovers remote requests and releases the server before acknowledging a failed backup", async () => {
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(1);
  expect(h.recover.mock.calls.map(([c]) => c.marker)).toEqual(["request-one", "request-two"]);
  expect(h.acknowledge).toHaveBeenCalledWith(candidate);
  expect(h.run.status).toBe("server_error");
  expect(h.workspace.activity).toBeNull();
});

it("keeps the execution discoverable until a failed activity release succeeds", async () => {
  h.releaseFails = true;
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
  expect(h.workspace.activity).toMatchObject({ id: "old-activity", commands: [], settled: true });
  expect(h.acknowledge).not.toHaveBeenCalled();
  h.releaseFails = false;
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(1);
  expect(h.recover).toHaveBeenCalledTimes(2);
  expect(h.workspace.activity).toBeNull();
  expect(h.run.executionFinishedAt).toBeInstanceOf(Date);
});

it("retries a failed acknowledgement after the activity was already released", async () => {
  h.acknowledge.mockRejectedValueOnce(new Error("acknowledgement unavailable"));
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
  expect(h.workspace.activity).toBeNull();
  expect(h.run.executionFinishedAt).toBeNull();
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(1);
  expect(h.run.executionFinishedAt).toBeInstanceOf(Date);
});

it("recovers an interrupted uploading execution without waiting for a heartbeat timeout", async () => {
  h.run.status = "uploading";
  h.run.finishedAt = null;
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(1);
  expect(h.acknowledge).toHaveBeenCalledWith(candidate);
  expect(h.workspace.activity).toBeNull();
});

it("retries durable recovery even when no new heartbeat timeouts were found", async () => {
  expect(await runBackupStaleSweep()).toEqual({ swept: 0, recovered: 1 });
  expect(h.sweep).toHaveBeenCalledOnce();
  expect(h.run.executionFinishedAt).toBeInstanceOf(Date);
  expect(h.workspace.activity).toBeNull();
});

it.each(["cloud:workspace-activity:workspace", "project-runtime:project"])(
  "does not close a live execution while %s is held",
  async (key) => {
    await createProvisionLock(key).run(async () => {
      expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
    });
    expect(h.acknowledge).not.toHaveBeenCalled();
  },
);

it("retains the claim and execution barrier when a Docker request cannot confirm exit", async () => {
  h.recover.mockRejectedValue(new Error("request exit unconfirmed"));
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
  expect(h.workspace.activity.id).toBe("old-activity");
  expect(h.workspace.activity.commands).toHaveLength(2);
  expect(h.acknowledge).not.toHaveBeenCalled();
});

it.each(["deployment", "restore", "migration"])(
  "does not recover an enclosing %s from the verdict of one backup",
  async (kind) => {
    if (kind === "deployment") h.deployments = [{ id: "deploy" }];
    if (kind === "restore") h.restores = [{ id: "restore" }];
    if (kind === "migration") h.migration = { id: "migration" };
    expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  },
);

it.each(["different-controller", "different-scope", "different-org", "linked"])(
  "leaves a %s activity untouched",
  async (kind) => {
    if (kind === "different-controller")
      h.workspace.activity.controllerId = "customer:installation";
    if (kind === "different-scope") h.workspace.activity.scope = "terminal";
    if (kind === "different-org") h.workspace.organizationId = "other-org";
    if (kind === "linked") h.workspace.remote = { serverId: "external" };
    expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.acknowledge).not.toHaveBeenCalled();
  },
);

it("does not recover a replacement activity installed between discovery and fence acquisition", async () => {
  h.beforeLock = () => {
    h.workspace.activity = { ...h.workspace.activity, id: "new-activity" };
  };
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
  expect(h.workspace.activity.id).toBe("new-activity");
  expect(h.recover).not.toHaveBeenCalled();
});

it("rechecks project membership under its runtime fence", async () => {
  h.beforeLock = () => {
    h.project.workspaceId = "different-workspace";
  };
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
  expect(h.acknowledge).not.toHaveBeenCalled();
});

it("finishes an orphan whose workspace claim was already released", async () => {
  h.workspace.activity = null;
  h.acknowledge.mockImplementation(async () => {
    h.run.executionFinishedAt = new Date();
    return true;
  });
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(1);
  expect(h.recover).not.toHaveBeenCalled();
  expect(h.workspace.activity).toBeNull();
});

it("does not count a conditional acknowledgement refused after a state change", async () => {
  h.acknowledge.mockResolvedValue(false);
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
  expect(h.run.executionFinishedAt).toBeNull();
});

it("pages past busy owners so they cannot starve a later orphan", async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({
    ...candidate,
    runId: `busy-${i}`,
    projectId: `other-${i}`,
  }));
  h.list.mockResolvedValueOnce(first).mockResolvedValueOnce([candidate]);
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(1);
  expect(h.list).toHaveBeenNthCalledWith(2, "busy-99");
});

it("does not run Cloud recovery on a self-hosted installation", async () => {
  h.cloud = false;
  expect(await recoverOrphanedCloudBackupExecutions()).toBe(0);
  expect(h.list).not.toHaveBeenCalled();
});
