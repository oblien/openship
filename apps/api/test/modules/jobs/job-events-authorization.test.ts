import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  jobs: [] as Array<Record<string, unknown>>,
  servers: new Map<string, { id: string; organizationId: string | null }>(),
  runs: [] as Array<{ key: string; trigger: string }>,
  requestedServerIds: [] as string[],
}));

vi.mock("@repo/db", () => ({
  repos: {
    job: {
      listAll: async () => h.jobs,
    },
    server: {
      getMany: async (ids: string[]) => {
        h.requestedServerIds = ids;
        return new Map(ids.flatMap((id) => (h.servers.has(id) ? [[id, h.servers.get(id)!]] : [])));
      },
    },
  },
}));

vi.mock("@repo/platform/engine/modules/jobs/job-command", () => ({
  startCommandRun: async (job: { key: string }, trigger: string) => {
    h.runs.push({ key: job.key, trigger });
    return `run:${job.key}`;
  },
}));

import { fireJobTriggers, refreshTriggerArm } from "@repo/platform/engine/modules/jobs/job-events";

function eventJob(key: string, serverIds: string[]) {
  return {
    key,
    enabled: true,
    actionType: "command",
    actionConfig: { serverIds, command: "true" },
    triggerEvents: ["deployment.failed"],
  };
}

beforeEach(() => {
  h.jobs = [];
  h.servers = new Map();
  h.runs = [];
  h.requestedServerIds = [];
});

describe("event-triggered command-job authorization", () => {
  it("fires only jobs whose complete target set belongs to the event organization", async () => {
    h.jobs = [
      eventJob("custom:foreign", ["server-b"]),
      eventJob("custom:mixed", ["server-a", "server-b"]),
      eventJob("custom:deleted-target", ["server-missing"]),
      eventJob("custom:targetless", []),
      eventJob("custom:local", ["server-a"]),
    ];
    h.servers = new Map([
      ["server-a", { id: "server-a", organizationId: "org-a" }],
      ["server-b", { id: "server-b", organizationId: "org-b" }],
    ]);
    await refreshTriggerArm();

    fireJobTriggers("deployment.failed", "org-a");

    // The local job is last, so observing it means every earlier foreign,
    // mixed, stale, and targetless candidate has already been evaluated.
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    expect(h.runs).toEqual([{ key: "custom:local", trigger: "event" }]);
    expect(new Set(h.requestedServerIds)).toEqual(
      new Set(["server-a", "server-b", "server-missing"]),
    );
  });
});
