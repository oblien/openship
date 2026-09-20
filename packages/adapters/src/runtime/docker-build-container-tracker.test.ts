import { describe, expect, it, vi } from "vitest";

import {
  LegacyBuildContainerTracker,
  type LegacyBuildContainerClient,
  type LegacyBuildContainerInspect,
} from "./docker-build-container-tracker";

const FIRST_ID = "111111111111";
const SECOND_ID = "222222222222";
const FOREIGN_ID = "ffffffffffff";
const FIRST_PARENT = "aaaaaaaaaaaa";
const SECOND_PARENT = "bbbbbbbbbbbb";
const MEMORY_BYTES = 64 * 1024 * 1024;
const OWNERSHIP_HOST = "openship-build-test.invalid";

function runningContainer(
  id: string,
  parent: string,
  command: string,
  memory = MEMORY_BYTES,
): LegacyBuildContainerInspect {
  return {
    Id: id.padEnd(64, id[0]),
    Config: {
      Image: `sha256:${parent.padEnd(64, parent[0])}`,
      Cmd: ["/bin/sh", "-c", command],
    },
    HostConfig: { Memory: memory, ExtraHosts: [`${OWNERSHIP_HOST}:127.0.0.1`] },
    State: { Running: true },
  };
}

function clientWith(inspect: LegacyBuildContainerClient["inspect"]): LegacyBuildContainerClient & {
  inspect: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
} {
  return {
    inspect: vi.fn(inspect),
    kill: vi.fn(async () => {}),
  };
}

function announceRun(
  tracker: LegacyBuildContainerTracker,
  id = FIRST_ID,
  parent = FIRST_PARENT,
  command = "sleep 180",
  step = 2,
): void {
  tracker.observe(`Step 1/3 : FROM alpine:3.20\n ---> ${parent}\n`);
  tracker.observe(`Step ${step}/3 : RUN ${command}\n ---> Running in ${id}\n`);
}

describe("LegacyBuildContainerTracker", () => {
  it("kills only the exact, fully verified RUN container from this build stream", async () => {
    const client = clientWith(async (id) =>
      id === FIRST_ID ? runningContainer(FIRST_ID, FIRST_PARENT, "sleep 180") : null,
    );
    const tracker = new LegacyBuildContainerTracker(client, MEMORY_BYTES, OWNERSHIP_HOST);
    announceRun(tracker);

    await expect(tracker.terminateActive()).resolves.toEqual({
      status: "killed",
      id: FIRST_ID,
    });
    expect(client.inspect).toHaveBeenCalledWith(FIRST_ID);
    expect(client.kill).toHaveBeenCalledOnce();
    expect(client.kill).toHaveBeenCalledWith(FIRST_ID);
  });

  it.each([
    ["parent image", runningContainer(FIRST_ID, "cccccccccccc", "sleep 180")],
    ["RUN command", runningContainer(FIRST_ID, FIRST_PARENT, "sleep 999")],
    ["memory limit", runningContainer(FIRST_ID, FIRST_PARENT, "sleep 180", 128 * 1024 * 1024)],
    [
      "ownership marker",
      {
        ...runningContainer(FIRST_ID, FIRST_PARENT, "sleep 180"),
        HostConfig: { Memory: MEMORY_BYTES, ExtraHosts: ["another-build.invalid:127.0.0.1"] },
      },
    ],
    [
      "container id",
      {
        ...runningContainer(FIRST_ID, FIRST_PARENT, "sleep 180"),
        Id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      },
    ],
  ])("refuses a candidate whose %s does not match", async (_field, info) => {
    const client = clientWith(async () => info);
    const tracker = new LegacyBuildContainerTracker(client, MEMORY_BYTES, OWNERSHIP_HOST);
    announceRun(tracker);

    await expect(tracker.terminateActive()).resolves.toEqual({
      status: "unverified",
      id: FIRST_ID,
    });
    expect(client.kill).not.toHaveBeenCalled();
  });

  it("ignores forged Docker markers printed while the real RUN is still active", async () => {
    const client = clientWith(async (id) => {
      if (id === FIRST_ID) return runningContainer(FIRST_ID, FIRST_PARENT, "sleep 180");
      if (id === FOREIGN_ID) return runningContainer(FOREIGN_ID, SECOND_PARENT, "foreign-task");
      return null;
    });
    const tracker = new LegacyBuildContainerTracker(client, MEMORY_BYTES, OWNERSHIP_HOST);
    announceRun(tracker);

    // A build can discover its own id and print byte-identical legacy-builder
    // lines. Inspection proves it is still running, so none of the following
    // output is allowed to replace the tracked id.
    tracker.observe(
      ` ---> Removed intermediate container ${FIRST_ID}\n` +
        `Step 3/3 : RUN foreign-task\n` +
        ` ---> ${SECOND_PARENT}\n` +
        ` ---> Running in ${FOREIGN_ID}\n`,
    );

    await expect(tracker.terminateActive()).resolves.toEqual({
      status: "killed",
      id: FIRST_ID,
    });
    expect(client.inspect).not.toHaveBeenCalledWith(FOREIGN_ID);
    expect(client.kill).toHaveBeenCalledWith(FIRST_ID);
  });

  it("moves to the next RUN only after Docker confirms the old one disappeared", async () => {
    const client = clientWith(async (id) => {
      if (id === FIRST_ID) return null;
      if (id === SECOND_ID) return runningContainer(SECOND_ID, SECOND_PARENT, "sleep 240");
      return null;
    });
    const tracker = new LegacyBuildContainerTracker(client, MEMORY_BYTES, OWNERSHIP_HOST);
    announceRun(tracker);
    tracker.observe(
      ` ---> Removed intermediate container ${FIRST_ID}\n` +
        ` ---> ${SECOND_PARENT}\n` +
        `Step 3/3 : RUN sleep 240\n` +
        ` ---> Running in ${SECOND_ID}\n`,
    );

    await expect(tracker.terminateActive()).resolves.toEqual({
      status: "killed",
      id: SECOND_ID,
    });
    expect(client.kill).toHaveBeenCalledWith(SECOND_ID);
  });

  it("never treats non-RUN intermediate containers as killable build processes", async () => {
    const client = clientWith(async () =>
      runningContainer(FIRST_ID, FIRST_PARENT, "#(nop) ENV NODE_ENV=production"),
    );
    const tracker = new LegacyBuildContainerTracker(client, MEMORY_BYTES, OWNERSHIP_HOST);
    tracker.observe(`Step 1/2 : FROM alpine:3.20\n ---> ${FIRST_PARENT}\n`);
    tracker.observe(`Step 2/2 : ENV NODE_ENV=production\n ---> Running in ${FIRST_ID}\n`);

    await expect(tracker.terminateActive()).resolves.toEqual({ status: "none" });
    expect(client.inspect).not.toHaveBeenCalled();
    expect(client.kill).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent termination requests", async () => {
    const client = clientWith(async () => runningContainer(FIRST_ID, FIRST_PARENT, "sleep 180"));
    const tracker = new LegacyBuildContainerTracker(client, MEMORY_BYTES, OWNERSHIP_HOST);
    announceRun(tracker);

    const [first, second] = await Promise.all([
      tracker.terminateActive(),
      tracker.terminateActive(),
    ]);
    expect(first).toEqual(second);
    expect(client.kill).toHaveBeenCalledOnce();
  });

  it("reassembles split SSH output chunks before interpreting markers", async () => {
    const client = clientWith(async () => runningContainer(FIRST_ID, FIRST_PARENT, "sleep 180"));
    const tracker = new LegacyBuildContainerTracker(client, MEMORY_BYTES, OWNERSHIP_HOST);
    tracker.observeChunk(`Step 1/2 : FROM alpine:3.20\n ---> ${FIRST_PARENT}\nSte`);
    tracker.observeChunk(`p 2/2 : RUN sleep 180\n ---> Running in ${FIRST_ID.slice(0, 6)}`);
    tracker.observeChunk(`${FIRST_ID.slice(6)}\n`);
    tracker.flush();

    await expect(tracker.terminateActive()).resolves.toEqual({
      status: "killed",
      id: FIRST_ID,
    });
    expect(client.kill).toHaveBeenCalledWith(FIRST_ID);
  });
});
