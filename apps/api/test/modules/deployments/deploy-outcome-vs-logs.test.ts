import { describe, expect, it, beforeEach, vi } from "vitest";

import { createDeploymentRepo } from "../../../../../packages/db/src/repos/deployment.repo";

/**
 * A failed BOOKKEEPING write must never change a deployment's outcome.
 *
 * Field failure: a Convex app deployed fine (2/2 services running), then the
 * captured prepare-step output — raw docker stream bytes, NUL frame headers and
 * all — was handed to `build_session.logs` (jsonb). Postgres rejected it, the
 * UPDATE threw out of onSuccess, and the pipeline's outer catch ran onFailure:
 * the deploy was recorded FAILED (destroying the containers it had just
 * started), while the SSE terminal event was skipped so the header sat on
 * "Deploying" forever.
 *
 * The same shape exists for every write that lands BEFORE the outcome —
 * `deployment.meta` (jsonb, partly user data from the compose file), the version
 * lookup, the container-id write. Each is pinned behaviourally below by making it
 * reject and asserting the deploy still settles.
 */

/** D800–DFFF, BOTH halves: what JSON.stringify escapes for a lone surrogate. */
const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;
const NUL = String.fromCharCode(0);
const ROCKET = "\u{1F680}";

/** The two things a real jsonb column refuses (both verified against Postgres). */
function jsonbRejection(value: unknown): string | null {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.includes("\\u0000")) return "unsupported Unicode escape sequence";
  if (LONE_SURROGATE_ESCAPE.test(serialized)) return "invalid input syntax for type json";
  return null;
}

const h = vi.hoisted(() => ({
  finishError: null as Error | null,
  /** Rejects every status write, whatever the payload (a dead connection). */
  rejectAllStatusWrites: false,
  containerIdError: null as Error | null,
  versionError: null as Error | null,
  statusWrites: [] as Array<{ id: string; status: string; extra?: Record<string, unknown> }>,
  sessionStatuses: [] as Array<{ id: string; status: string; detail?: Record<string, unknown> }>,
  activePointer: [] as string[],
  notifications: [] as string[],
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      setContainerId: async () => {
        if (h.containerIdError) throw h.containerIdError;
      },
      findReadyVersionByCommit: async () => {
        if (h.versionError) throw h.versionError;
        return 7;
      },
      getNextReadyVersion: async () => 7,
      // Stands in for Postgres: the statement fails as a whole when any column
      // in it carries a value jsonb refuses.
      updateStatus: async (id: string, status: string, extra?: Record<string, unknown>) => {
        h.statusWrites.push({ id, status, extra });
        if (h.rejectAllStatusWrites) throw new Error("connection terminated unexpectedly");
        const rejection = jsonbRejection(extra ?? null);
        if (rejection) throw new Error(rejection);
      },
      supersedePendingDecisions: async () => {},
      finishBuildSession: async () => {
        if (h.finishError) throw h.finishError;
      },
    },
    project: {
      setActiveDeployment: async (projectId: string, depId: string) => {
        h.activePointer.push(`${projectId}:${depId}`);
      },
      setCloudWorkspaceId: async () => {},
    },
    service: { listByDeployment: async () => [] },
  },
}));

vi.mock("../../../src/modules/deployments/session-manager", () => ({
  updateStatus: (id: string, status: string, detail?: Record<string, unknown>) => {
    h.sessionStatuses.push({ id, status, detail });
  },
  broadcastServiceStatus: () => {},
  appendLog: () => {},
}));

vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: {
    emit: (e: { eventType: string }) => {
      h.notifications.push(e.eventType);
    },
  },
}));
vi.mock("../../../src/lib/audit", () => ({ audit: { recordAsync: () => {} } }));
vi.mock("../../../src/lib/favicon-detector", () => ({ detectAndStoreFavicon: async () => {} }));
vi.mock("../../../src/modules/mail/webmail/webmail-project.service", () => ({
  markWebmailInstalled: async () => {},
  mailServerIdFromWebmailSlug: () => null,
}));

const { onSuccess, onFailure, reportPipelineError } = await import(
  "../../../src/modules/deployments/deployment-lifecycle"
);
type LifecycleContext = Parameters<typeof onSuccess>[0];

function ctxFor(): LifecycleContext {
  return {
    project: { id: "prj_1", name: "convex", slug: "convex", framework: "docker" } as never,
    dep: {
      id: "dep_1",
      projectId: "prj_1",
      organizationId: "org_1",
      branch: "main",
      commitSha: "abc123",
      status: "deploying",
      meta: null,
    } as never,
    buildSessionId: "bld_1",
    persistLogs: () => [],
    provisioned: {},
  };
}

/** Deeper than sanitizeStorableStrings' recursion limit, so the hostile byte
 *  genuinely reaches jsonb — the sanitizer is a filter, not a guarantee. */
function deeplyNestedHostile(): Record<string, unknown> {
  let node: Record<string, unknown> = { key: `admin${NUL}key` };
  for (let i = 0; i < 12; i++) node = { nested: node };
  return node;
}

const statusPairs = () => h.statusWrites.map((w) => `${w.id}:${w.status}`);

function loggerSpy() {
  const lines: Array<{ message: string; level?: string }> = [];
  return { lines, logger: { log: (message: string, level?: string) => lines.push({ message, level }) } };
}

beforeEach(() => {
  h.finishError = null;
  h.rejectAllStatusWrites = false;
  h.containerIdError = null;
  h.versionError = null;
  h.statusWrites = [];
  h.sessionStatuses = [];
  h.activePointer = [];
  h.notifications = [];
});

describe("lifecycle: a rejected log payload cannot invert the outcome", () => {
  it("onSuccess still reports ready when finishBuildSession throws", async () => {
    h.finishError = new Error(
      'Failed query: update "build_session" set "status" = $1, "logs" = $2 …',
    );
    const ctx = ctxFor();

    await expect(onSuccess(ctx, { containerId: "c1", durationMs: 1234 })).resolves.toBeUndefined();

    expect(statusPairs()).toEqual(["dep_1:ready"]);
    // The terminal SSE event is what closes the stream — skipping it is what
    // left the header on "Deploying" with nothing ever correcting it.
    expect(h.sessionStatuses.map((s) => s.status)).toEqual(["ready"]);
    expect(h.notifications).toEqual(["deployment.succeeded"]);
    // And the pipeline's outer catch can tell the outcome is already recorded.
    expect(ctx.settled).toBe("ready");
  });

  it("onFailure still reports failed when finishBuildSession throws", async () => {
    h.finishError = new Error("unsupported Unicode escape sequence");
    const ctx = ctxFor();

    await expect(onFailure(ctx, "build blew up", 99)).resolves.toBeUndefined();

    expect(statusPairs()).toEqual(["dep_1:failed"]);
    expect(h.sessionStatuses.map((s) => s.status)).toEqual(["failed"]);
    expect(h.notifications).toEqual(["deployment.failed"]);
    expect(ctx.settled).toBe("failed");
  });

  it("sanitizes the writes that land BEFORE the outcome (text + jsonb)", async () => {
    // These two columns take the same raw process output the log does, and they
    // are written before the row reaches ready/failed — so a NUL there fails the
    // deploy outright instead of merely losing a message. `text` rejects the
    // byte ("invalid byte sequence for encoding UTF8: 0x00"), jsonb the escape.
    const ctx = ctxFor();
    await onSuccess(ctx, {
      containerId: "c1",
      durationMs: 1,
      metaPatch: { deployWarning: `service crashed: (HTTP code 101)${NUL}raw` },
    });
    // One write only: the fake Postgres accepted it, so nothing was shed.
    expect(h.statusWrites).toHaveLength(1);
    expect(jsonbRejection(h.statusWrites[0].extra)).toBeNull();

    h.statusWrites = [];
    await onFailure(ctx, `Required app setup step failed: ${NUL}raw`, 1, {
      errorDetails: { stdout: `x${NUL}y` },
    });
    const failWrite = h.statusWrites[0].extra as { errorMessage: string };
    expect(failWrite.errorMessage).not.toContain(NUL);
    expect(h.statusWrites).toHaveLength(1);
    expect(jsonbRejection(h.statusWrites[0].extra)).toBeNull();
  });

  it("truncates the error message on a code-point boundary", async () => {
    // 512 is MAX_ERROR_MESSAGE_LENGTH; put the astral char exactly at the cut.
    const ctx = ctxFor();
    await onFailure(ctx, `${"a".repeat(511)}${ROCKET} and more`, 1);
    const { errorMessage } = h.statusWrites[0].extra as { errorMessage: string };
    expect(errorMessage.isWellFormed()).toBe(true);
    expect(JSON.stringify(errorMessage)).not.toMatch(LONE_SURROGATE_ESCAPE);
  });

  it("a persistLogs crash degrades to an explanation, not a failed deploy", async () => {
    const ctx = ctxFor();
    ctx.persistLogs = () => {
      throw new Error("collapse blew up");
    };

    await expect(onSuccess(ctx, { containerId: "c1", durationMs: 1 })).resolves.toBeUndefined();
    expect(statusPairs()).toEqual(["dep_1:ready"]);
    expect(h.sessionStatuses.map((s) => s.status)).toEqual(["ready"]);
  });
});

describe("lifecycle: no write before settlement may tear down a live deploy", () => {
  it("sheds the rejected meta blob and still records ready", async () => {
    const ctx = ctxFor();

    await expect(
      onSuccess(ctx, { containerId: "c1", durationMs: 1, metaPatch: deeplyNestedHostile() }),
    ).resolves.toBeUndefined();

    // First attempt carried meta and was refused; the retry dropped meta only.
    expect(h.statusWrites).toHaveLength(2);
    expect(h.statusWrites[0].extra).toHaveProperty("meta");
    expect(h.statusWrites[1].extra).not.toHaveProperty("meta");
    expect(h.statusWrites[1].status).toBe("ready");
    expect(h.statusWrites[1].extra).toMatchObject({ version: 7, errorMessage: null });
    expect(ctx.settled).toBe("ready");
    expect(h.sessionStatuses.map((s) => s.status)).toEqual(["ready"]);
    expect(h.notifications).toEqual(["deployment.succeeded"]);
    expect(h.activePointer).toEqual(["prj_1:dep_1"]);
  });

  it("still settles ready + emits the terminal event when the row write fails outright", async () => {
    h.rejectAllStatusWrites = true;
    const ctx = ctxFor();

    await expect(
      onSuccess(ctx, { containerId: "c1", durationMs: 1, metaPatch: { a: 1 } }),
    ).resolves.toBeUndefined();

    // full → without meta → status only. All refused, and STILL no throw: the
    // containers are running, so the pipeline must not be told to destroy them.
    expect(h.statusWrites.map((w) => w.status)).toEqual(["ready", "ready", "ready"]);
    expect(ctx.settled).toBe("ready");
    const terminal = h.sessionStatuses.at(-1);
    expect(terminal?.status).toBe("ready");
    expect(String(terminal?.detail?.warningMessage)).toContain("recording it failed");
  });

  it("onFailure sheds errorDetails rather than stranding the deploy on 'deploying'", async () => {
    const ctx = ctxFor();

    await expect(
      onFailure(ctx, "prepare step failed", 5, { errorDetails: deeplyNestedHostile() }),
    ).resolves.toBeUndefined();

    expect(h.statusWrites).toHaveLength(2);
    expect(h.statusWrites[1].extra).not.toHaveProperty("errorDetails");
    expect(h.statusWrites[1].extra).toMatchObject({ errorMessage: "prepare step failed" });
    expect(ctx.settled).toBe("failed");
    expect(h.sessionStatuses.map((s) => s.status)).toEqual(["failed"]);
  });

  it("onFailure still closes the stream when the row write fails outright", async () => {
    h.rejectAllStatusWrites = true;
    const ctx = ctxFor();

    await expect(onFailure(ctx, "build blew up", 5)).resolves.toBeUndefined();

    expect(ctx.settled).toBe("failed");
    expect(h.sessionStatuses.map((s) => s.status)).toEqual(["failed"]);
    expect(h.notifications).toEqual(["deployment.failed"]);
  });

  it("a version lookup failure leaves the release unnumbered instead of failing it", async () => {
    h.versionError = new Error("canceling statement due to statement timeout");
    const ctx = ctxFor();

    await expect(onSuccess(ctx, { containerId: "c1", durationMs: 1 })).resolves.toBeUndefined();

    expect(statusPairs()).toEqual(["dep_1:ready"]);
    // Undefined, not 0 or 1 — drizzle omits the column, so no version is claimed.
    expect((h.statusWrites[0].extra as { version?: number }).version).toBeUndefined();
    expect(ctx.settled).toBe("ready");
  });

  it("a setContainerId failure does not invert the deploy", async () => {
    h.containerIdError = new Error("connection terminated unexpectedly");
    const ctx = ctxFor();

    await expect(onSuccess(ctx, { containerId: "c1", durationMs: 1 })).resolves.toBeUndefined();

    expect(statusPairs()).toEqual(["dep_1:ready"]);
    expect(ctx.settled).toBe("ready");
  });
});

describe("pipeline: the outer catch must not re-report a settled deploy", () => {
  it("keeps a settled outcome and only warns", async () => {
    const ctx = ctxFor();
    ctx.settled = "ready";
    const { lines, logger } = loggerSpy();

    await reportPipelineError(ctx, "logs write blew up", logger);

    // onFailure did not run: no row write, no terminal "failed", no notification.
    expect(h.statusWrites).toEqual([]);
    expect(h.sessionStatuses).toEqual([]);
    expect(h.notifications).toEqual([]);
    expect(ctx.settled).toBe("ready");
    expect(lines).toHaveLength(1);
    expect(lines[0].level).toBe("warn");
    expect(lines[0].message).toContain("logs write blew up");
  });

  it("reports an UNSETTLED error as a real failure", async () => {
    const ctx = ctxFor();
    const { lines, logger } = loggerSpy();

    await reportPipelineError(ctx, "docker build failed", logger);

    expect(statusPairs()).toEqual(["dep_1:failed"]);
    expect(h.sessionStatuses.map((s) => s.status)).toEqual(["failed"]);
    expect(h.notifications).toEqual(["deployment.failed"]);
    expect(ctx.settled).toBe("failed");
    expect(lines[0]).toEqual({ message: "Error: docker build failed", level: "error" });
  });
});

describe("repo: finishBuildSession sheds the payload, never the status", () => {
  /** Stand-in for Postgres: refuses exactly what a real jsonb column refuses. */
  function fakeDb() {
    const writes: Array<Record<string, unknown>> = [];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            writes.push(values);
            if ("logs" in values) {
              const rejection = jsonbRejection(values.logs ?? null);
              if (rejection) throw new Error(rejection);
            }
          },
        }),
      }),
    };
    return { writes, repo: createDeploymentRepo(db as never) };
  }

  it("retries with a marker payload and keeps status + duration", async () => {
    const { writes, repo } = fakeDb();
    const poisoned = [{ timestamp: "t", level: "warn", message: `Admin key: ${NUL}x` }];

    await expect(repo.finishBuildSession("bld_1", "ready", 4321, poisoned)).resolves.toBeUndefined();

    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(w.status).toBe("ready");
      expect(w.durationMs).toBe(4321);
      expect(w.finishedAt).toBeInstanceOf(Date);
    }
    expect(JSON.stringify(writes[1].logs)).toContain("Build logs could not be stored");
  });

  it("sheds a lone-surrogate payload too, not just a NUL", async () => {
    const { writes, repo } = fakeDb();
    const poisoned = [{ timestamp: "t", level: "warn", message: `half ${String.fromCharCode(0xd83d)}` }];

    await expect(repo.finishBuildSession("bld_1", "ready", 1, poisoned)).resolves.toBeUndefined();

    expect(writes).toHaveLength(2);
    expect(writes[1].status).toBe("ready");
    expect(jsonbRejection(writes[1].logs)).toBeNull();
  });

  it("writes once when the payload is storable", async () => {
    const { writes, repo } = fakeDb();
    await repo.finishBuildSession("bld_1", "ready", 10, [
      { timestamp: "t", level: "info", message: "clean" },
    ]);
    expect(writes).toHaveLength(1);
  });

  it("omits the logs COLUMN entirely when no payload is given", async () => {
    const { writes, repo } = fakeDb();
    await repo.finishBuildSession("bld_1", "cancelled", 0);
    expect(writes).toHaveLength(1);
    // Absent from the SET clause — not merely set to undefined. A caller with no
    // payload has nothing to shed, so its error must propagate untouched.
    expect("logs" in writes[0]).toBe(false);
    expect(writes[0].status).toBe("cancelled");
  });
});
