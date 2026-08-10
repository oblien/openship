/**
 * A backup's OUTCOME must never be lost to the text it captured.
 *
 * Field failure: a pre-hook (`pg_dump` into a file, say) printed a NUL byte.
 * That byte reached `backup_run.hook_log` (text) inside the SAME UPDATE as the
 * run's `succeeded` status, Postgres refused the statement, the throw left the
 * orchestrator's try block, and its catch transitioned the run to `failed` —
 * artifact uploaded, manifest written, run recorded FAILED, notification sent
 * saying FAILED.
 *
 * Two independent layers are pinned here:
 *   1. packages/db — the status write is its own statement, and the payload
 *      sheds itself per column instead of taking the outcome with it.
 *   2. the orchestrator — raw hook/error/metadata text is scrubbed before it is
 *      handed to the DB at all, so the payload does not need shedding.
 *
 * The DB fake below refuses what Postgres refuses (a NUL in any value; an
 * unpaired surrogate inside a jsonb value) so both layers are exercised against
 * something that can actually diverge.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";

import { createBackupRunRepo } from "../../../../../packages/db/src/repos/backup.repo";

// ─── Postgres-shaped DB fake ─────────────────────────────────────────────────

/** What Postgres would refuse, and why. `jsonb` values are stricter than text:
 *  text only chokes on the NUL byte, jsonb also rejects an unpaired surrogate. */
function unstorableReason(value: unknown, jsonb = false): string | null {
  if (typeof value === "string") {
    if (value.includes("\u0000")) return 'invalid byte sequence for encoding "UTF8": 0x00';
    if (jsonb && !value.isWellFormed()) {
      return "unsupported Unicode escape sequence";
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = unstorableReason(item, true);
      if (reason) return reason;
    }
    return null;
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      const reason = unstorableReason(item, true);
      if (reason) return reason;
    }
  }
  return null;
}

interface PgFake {
  db: unknown;
  row: Record<string, unknown>;
  /** Every value set the fake refused, newest last. */
  rejections: string[];
  statements: number;
}

function makePgFake(initial: Record<string, unknown> = {}): PgFake {
  const state: PgFake = {
    db: null,
    row: { ...initial },
    rejections: [],
    statements: 0,
  };
  state.db = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.statements++;
          for (const [key, value] of Object.entries(values)) {
            const reason = unstorableReason(value);
            if (reason) {
              state.rejections.push(`${key}: ${reason}`);
              throw new Error(reason);
            }
          }
          Object.assign(state.row, values);
        },
      }),
    }),
  };
  return state;
}

// ─── Layer 1: the repo ───────────────────────────────────────────────────────

describe("backupRun.transition — status must not ride a payload that can fail", () => {
  it("records succeeded even when the hook log is unstorable", async () => {
    const pg = makePgFake({ id: "bkr_1", status: "verifying" });
    const repo = createBackupRunRepo(pg.db as never);

    await repo.transition("bkr_1", "succeeded", {
      manifestKey: "p/manifest.json",
      bytesTransferred: 4096,
      hookLog: "dump ok\u0000",
    } as never);

    expect(pg.row.status).toBe("succeeded");
    expect(pg.row.finishedAt).toBeInstanceOf(Date);
    // Storable siblings survive; only the poisoned column sheds its value.
    expect(pg.row.manifestKey).toBe("p/manifest.json");
    expect(pg.row.bytesTransferred).toBe(4096);
    expect(String(pg.row.hookLog)).toContain("unstorable");
    expect(String(pg.row.hookLog)).not.toContain("\u0000");
    expect(pg.rejections.length).toBeGreaterThan(0);
  });

  it("keeps a failed run's reason when a sibling jsonb column is unstorable", async () => {
    const pg = makePgFake({ id: "bkr_2", status: "uploading" });
    const repo = createBackupRunRepo(pg.db as never);

    await repo.transition("bkr_2", "failed", {
      errorMessage: "producer exited 1",
      artifacts: [{ name: "vol", metadata: { note: "raw\u0000bytes" } }],
    } as never);

    expect(pg.row.status).toBe("failed");
    // The reason a human reads must not be collateral damage of the jsonb blob.
    expect(pg.row.errorMessage).toBe("producer exited 1");
  });

  it("never lets the patch overwrite the status it was given", async () => {
    const pg = makePgFake({ id: "bkr_3", status: "queued" });
    const repo = createBackupRunRepo(pg.db as never);

    await repo.transition("bkr_3", "succeeded", { status: "failed" } as never);

    expect(pg.row.status).toBe("succeeded");
  });

  it("stays a single statement on the happy path", async () => {
    const pg = makePgFake({ id: "bkr_4", status: "queued" });
    const repo = createBackupRunRepo(pg.db as never);
    await repo.transition("bkr_4", "preparing");
    expect(pg.statements).toBe(1);
  });
});

// ─── Layer 2: the orchestrator ───────────────────────────────────────────────

const h = vi.hoisted(() => ({
  run: null as Record<string, unknown> | null,
  transition: null as
    | null
    | ((id: string, status: string, patch?: Record<string, unknown>) => Promise<void>),
  hookStdout: "hook ran\n",
  hookExit: { code: 0 as number | null, stderr: "" },
  artifactMetadata: {} as Record<string, unknown>,
  notifications: [] as Array<{ eventType: string; payload: Record<string, unknown> }>,
  verifyNotes: [] as Array<string | undefined>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    backupRun: {
      findById: async () => h.run,
      transition: async (id: string, status: string, patch?: Record<string, unknown>) =>
        h.transition!(id, status, patch),
    },
    backupPolicy: {
      findById: async () => ({
        id: "pol_1",
        destinationId: "dst_1",
        sourceKind: "mail_server",
        mailServerId: "mail_1",
        projectId: null,
        payloadKind: "auto",
        preHook: "pg_dump > /tmp/d.sql",
        postHook: null,
        hookTimeoutSeconds: 30,
        payloadConfig: {},
      }),
    },
    backupDestination: {
      findById: async () => ({
        id: "dst_1",
        organizationId: "org_1",
        name: "S3 primary",
        pathPrefix: null,
      }),
      setLastVerified: async (_id: string, _ok: boolean, note?: string) => {
        h.verifyNotes.push(note);
      },
    },
    mailServer: { get: async () => ({ id: "mail_1", domain: "mail.example.com" }) },
  },
}));

// `node:stream` is imported INSIDE the factory: vi.mock factories are hoisted
// above the file's own imports, so closing over a top-level binding throws.
vi.mock("@repo/adapters", async () => {
  const { Readable, PassThrough } = await import("node:stream");
  class FakeHasher extends PassThrough {
    summary() {
      return { sha256: "d0", bytesWritten: 11 };
    }
  }
  return {
    HashingPassthrough: FakeHasher,
    artifactKey: (_base: unknown, name: string) => `pfx/${name}`,
    manifestKey: () => "pfx/manifest.json",
    runPrefix: () => "pfx/",
    buildManifest: () => ({ version: 1 }),
    resolveDestination: () => ({
      preflight: async () => ({ ok: true }),
      put: async () => {},
    }),
    resolveExecutor: () => ({
      execStream: async () => ({
        stdout: Readable.from([Buffer.from(h.hookStdout, "utf8")]),
        awaitExit: Promise.resolve(h.hookExit),
      }),
    }),
    resolveProducerForService: () => ({
      // eslint-disable-next-line require-yield
      async *produce() {
        yield {
          name: "vmail.tar.zst",
          stream: Readable.from([Buffer.from("bytes")]),
          sizeHint: 5,
          payloadKind: "volume",
          metadata: h.artifactMetadata,
        };
      },
    }),
    resolveProducer: () => ({ async *produce() {} }),
  };
});

vi.mock("../../../src/lib/job-runner", () => ({
  getJobRunner: async () => ({ enqueueRun: async () => {} }),
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentPlatform: async () => ({ platform: { runtime: { name: "bare" } } }),
  resolveTargetPlatform: async () => ({ runtime: { name: "bare" } }),
}));

vi.mock("../../../src/lib/encryption", () => ({ decryptEnvMap: (v: unknown) => v }));

vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: {
    emit: (e: { eventType: string; payload: Record<string, unknown> }) => {
      h.notifications.push(e);
    },
  },
}));

vi.mock("../../../src/modules/backup-destinations/hydrate-server", () => ({
  toAdapterRow: async (row: unknown) => row,
}));

vi.mock("../../../src/modules/services/service-container", () => ({
  liveContainerIdForService: async () => null,
}));

import { BackupOrchestrator } from "../../../src/modules/backups/backup.orchestrator";
import { boundedStorableText } from "../../../src/modules/deployments/build-log-sanitize";

/** Wire the orchestrator to the REAL run repo over the Postgres-shaped fake, so
 *  a rejected write fails exactly where it fails in production. */
function wireRun(): PgFake {
  const pg = makePgFake({ id: "bkr_live", status: "queued" });
  const repo = createBackupRunRepo(pg.db as never);
  h.run = {
    id: "bkr_live",
    status: "queued",
    policyId: "pol_1",
    serviceId: null,
    mailServerId: "mail_1",
    organizationId: "org_1",
  };
  h.transition = (id, status, patch) => repo.transition(id, status as never, patch as never);
  return pg;
}

beforeEach(() => {
  h.hookStdout = "hook ran\n";
  h.hookExit = { code: 0, stderr: "" };
  h.artifactMetadata = {};
  h.notifications.length = 0;
  h.verifyNotes.length = 0;
});

describe("BackupOrchestrator.execute — hook output cannot fail the backup", () => {
  it("records a successful backup as succeeded when the pre-hook printed a NUL", async () => {
    h.hookStdout = "snapshot done\u0000 (pg_dump)\n";
    const pg = wireRun();

    await new BackupOrchestrator().execute("bkr_live");

    expect(pg.row.status).toBe("succeeded");
    expect(pg.row.manifestKey).toBe("pfx/manifest.json");
    expect(h.notifications.map((n) => n.eventType)).toEqual(["backup_run.succeeded"]);
    // The hook log is KEPT (scrubbed), not shed as an unstorable marker: the
    // orchestrator sanitizes before the write, so the payload never offends.
    const hookLog = String(pg.row.hookLog);
    expect(hookLog).toContain("snapshot done");
    expect(hookLog).toContain("(pg_dump)");
    expect(hookLog).not.toContain("\u0000");
    expect(pg.rejections).toEqual([]);
  });

  it("keeps artifact metadata storable (jsonb refuses what text tolerates)", async () => {
    h.artifactMetadata = { note: "tar said\u0000this", nested: { deep: "\u0000" } };
    const pg = wireRun();

    await new BackupOrchestrator().execute("bkr_live");

    expect(pg.row.status).toBe("succeeded");
    const artifacts = pg.row.artifacts as Array<{ metadata: Record<string, unknown> }>;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].metadata.note).toBe("tar saidthis");
    expect(pg.rejections).toEqual([]);
  });

  it("scrubs the failure reason on every column it lands in", async () => {
    h.hookExit = { code: 3, stderr: "fatal:\u0000 role does not exist" };
    const pg = wireRun();

    await new BackupOrchestrator().execute("bkr_live");

    expect(pg.row.status).toBe("failed");
    expect(h.notifications.map((n) => n.eventType)).toEqual(["backup_run.failed"]);
    for (const note of h.verifyNotes) {
      expect(String(note)).not.toContain("\u0000");
    }
    for (const n of h.notifications) {
      expect(String(n.payload.errorMessage ?? "")).not.toContain("\u0000");
    }
    expect(pg.rejections).toEqual([]);
  });

  it("treats an unknown hook exit status as a failure, not a success", async () => {
    // The docker backup executor maps a null `ExitCode` to 0; a pre-hook is what
    // guarantees the snapshot is consistent, so "don't know" must not pass.
    h.hookExit = { code: null, stderr: "" };
    const pg = wireRun();

    await new BackupOrchestrator().execute("bkr_live");

    expect(pg.row.status).toBe("failed");
    expect(String(pg.row.errorMessage)).toContain("unknown");
    expect(String(pg.row.errorMessage)).not.toMatch(/exited with code (0|null)\b/);
  });
});

describe("boundedStorableText", () => {
  it("caps at the requested length and leaves no lone surrogate at ANY cut point", () => {
    // A run of astral characters means every odd cut splits a surrogate pair.
    const raw = "🚀".repeat(64);
    for (let max = 1; max <= raw.length; max++) {
      const out = boundedStorableText(raw, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.isWellFormed()).toBe(true);
    }
  });

  it("repairs a lone surrogate that was never part of a pair", () => {
    for (const unit of ["\ud800", "\ud83d", "\udbff", "\udc00", "\udfff"]) {
      const out = boundedStorableText(`a${unit}b`, 100);
      expect(out.isWellFormed()).toBe(true);
      expect(out).toContain("a");
      expect(out).toContain("b");
    }
  });

  it("keeps valid astral characters and newlines intact", () => {
    expect(boundedStorableText("a🚀b\nc\n", 100)).toBe("a🚀b\nc\n");
  });

  it("drops the NUL that Postgres refuses, everywhere in the payload", () => {
    const out = boundedStorableText("a\u0000b\nc\u0000\n\u0000", 100);
    expect(out).not.toContain("\u0000");
    expect(out).toBe("ab\nc\n");
  });
});
