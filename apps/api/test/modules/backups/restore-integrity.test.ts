/**
 * D8: prepare claimed a check it never ran.
 *
 * The comment said "Verify EVERY artifact's sha256 … We HEAD + stream-hash each
 * one". The code destructured `sha256` and never read it, comparing `sizeBytes`
 * alone — so a truncation-and-pad, a swapped archive of equal length, or plain
 * bit-rot all reached `prepared`, and the operator clicked Apply on the strength
 * of a verification that hadn't happened.
 *
 * These tests use the REAL HashingPassthrough and the REAL validateManifest —
 * only the storage backend and the DB are faked. A test that hashed with a fake
 * hasher would prove nothing about the check it's pinning.
 *
 * The load-bearing assertion in the mismatch case is not just "it failed": it's
 * that it failed in PREPARE, without the target being stopped or written.
 * Prepare is the only phase where a failure costs nothing, which is the entire
 * reason verification lives there. (Prepare DOES resolve the target now — it
 * preflights it — so what's tracked is the lifecycle, not the resolution.)
 */

import crypto from "node:crypto";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sha256 = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");

const VOLUME = Buffer.from("openship-volume-archive-bytes");
const VOLUME_SHA = sha256(VOLUME);

interface Recorded {
  name: string;
  key: string;
  sha256: string | null;
  sizeBytes: number;
  payloadKind: string;
  metadata: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  /** Destination contents, keyed exactly as the run recorded them. */
  objects: new Map<string, Buffer>(),
  artifacts: [] as unknown[],
  manifestKey: null as string | null,
  policyId: null as string | null,
  policyConfig: {} as Record<string, unknown>,
  transitions: [] as Array<{ status: string; patch?: Record<string, unknown> }>,
  events: [] as Array<Record<string, unknown>>,
  /** Set the instant the target's lifecycle or contents are touched — i.e. the
   *  instant we're past the point where a failure is free. Prepare, which only
   *  ever probes, must never reach this. */
  targetTouched: false,
  /** Keys the destination was asked to stream in full. */
  reads: [] as string[],
  row: null as Record<string, unknown> | null,
  terminal: null as null | (() => void),
}));

vi.mock("@repo/db", () => ({
  repos: {
    backupRun: {
      findById: async () => ({
        id: "bkr_1",
        status: "succeeded",
        destinationId: "dst_1",
        organizationId: "org_1",
        projectId: "prj_1",
        serviceId: "svc_1",
        sourceKind: "service",
        policyId: h.policyId,
        manifestKey: h.manifestKey,
        deletedAt: null,
        artifacts: h.artifacts,
      }),
    },
    backupPolicy: {
      findById: async (id: string) =>
        id === h.policyId ? { id, payloadConfig: h.policyConfig } : undefined,
    },
    backupDestination: {
      findById: async () => ({ id: "dst_1", organizationId: "org_1", name: "local" }),
    },
    backupRestore: {
      findActiveByRunId: async () => undefined,
      create: async (row: Record<string, unknown>) => {
        h.row = { ...row };
        return h.row;
      },
      findById: async () => h.row,
      transition: async (_id: string, status: string, patch?: Record<string, unknown>) => {
        h.transitions.push({ status, patch });
        Object.assign(h.row!, { status }, patch ?? {});
        if (["prepared", "failed", "succeeded", "cancelled"].includes(status)) h.terminal?.();
      },
    },
    project: {
      findById: async () => ({
        id: "prj_1",
        name: "shop",
        slug: "shop",
        activeDeploymentId: null,
      }),
      listEnvVars: async () => [],
    },
    service: {
      findById: async () => ({
        id: "svc_1",
        projectId: "prj_1",
        name: "db",
        image: "postgres:16",
        environment: {},
        volumes: ["/var/lib/postgresql/data"],
        namespaceVolumes: true,
      }),
      listByProject: async () => [{ id: "svc_1" }],
    },
    deployment: { findById: async () => null },
  },
}));

// Partial mock: HashingPassthrough and validateManifest stay REAL — they are the
// subject. Only the storage backend is faked.
vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  return {
    ...actual,
    resolveDestination: () => ({
      head: async (key: string) => {
        const body = h.objects.get(key);
        return body ? { sizeBytes: body.byteLength, uploadedAt: new Date(0) } : null;
      },
      get: async (key: string) => {
        const body = h.objects.get(key);
        if (!body) throw new Error(`no such key ${key}`);
        h.reads.push(key);
        return Readable.from([body]);
      },
    }),
    resolveExecutor: () => ({
      runtimeName: "docker",
      // Read-only, and prepare's preflight calls it: one declared volume so the
      // recorded artifact resolves. Everything below MUTATES the target.
      listSources: async () => [
        { id: "pgdata", source: "shop_pgdata", target: "/var/lib/postgresql/data", type: "volume" },
      ],
      isRunning: async () => false,
      stopService: async () => {
        h.targetTouched = true;
      },
      startService: async () => {
        h.targetTouched = true;
      },
      receiveStream: async () => {
        h.targetTouched = true;
      },
    }),
  };
});

vi.mock("../../../src/modules/backups/restore.sse", () => ({
  restoreRunBus: {
    publish: (_id: string, event: Record<string, unknown>) => {
      h.events.push(event);
    },
    subscribe: () => () => {},
  },
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentPlatform: async () => ({ platform: { runtime: { name: "docker" } } }),
  resolveTargetPlatform: async () => ({ runtime: { name: "bare" } }),
}));
vi.mock("../../../src/lib/encryption", () => ({ decryptEnvMap: (v: unknown) => v }));
vi.mock("../../../src/lib/job-runner", () => ({
  getJobRunner: async () => ({ enqueueRun: async () => {} }),
}));
vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: { emit: () => {} },
}));
vi.mock("../../../src/modules/backup-destinations/hydrate-server", () => ({
  toAdapterRow: async (row: unknown) => row,
}));
vi.mock("../../../src/modules/services/service-container", () => ({
  liveContainerIdForService: async () => null,
}));

import { RestoreOrchestrator } from "../../../src/modules/backups/restore.orchestrator";

const recorded = (over: Partial<Recorded> = {}): Recorded => ({
  name: "volume-pgdata.tar.zst",
  key: "org_1/bkr_1/volume-pgdata.tar.zst",
  sha256: VOLUME_SHA,
  sizeBytes: VOLUME.byteLength,
  payloadKind: "volume",
  // As the volume producer records it — prepare's preflight resolves this
  // against what the target actually exposes.
  metadata: { volumeId: "pgdata", compression: "zstd" },
  ...over,
});

/** manifest.json as the backup orchestrator writes it. */
const manifestFor = (artifacts: Recorded[]) =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      runId: "bkr_1",
      projectId: "prj_1",
      projectSlug: "shop",
      serviceId: "svc_1",
      serviceName: "db",
      serviceImage: null,
      capturedAt: new Date(0).toISOString(),
      artifacts,
      envVarKeys: [],
      serviceConfig: { image: null, ports: [], command: null, environmentKeys: [] },
    }),
  );

/** Run prepare to its terminal state and return the last transition. */
async function prepare() {
  const done = new Promise<void>((resolve) => {
    h.terminal = resolve;
  });
  await new RestoreOrchestrator().beginPrepare({
    runId: "bkr_1",
    trigger: { source: "manual", userId: "usr_1" } as never,
    confirmationToken: "t".repeat(32),
  });
  await done;
  return h.transitions.at(-1)!;
}

const meta = () => (h.transitions.at(-1)!.patch?.meta ?? {}) as Record<string, unknown>;

beforeEach(() => {
  h.objects.clear();
  h.artifacts = [];
  h.manifestKey = null;
  h.policyId = null;
  h.policyConfig = {};
  h.transitions.length = 0;
  h.events.length = 0;
  h.reads.length = 0;
  h.targetTouched = false;
  h.row = null;
  h.terminal = null;
});

describe("prepare re-hashes what it says it re-hashes", () => {
  it("reaches prepared and records that sha256 actually ran", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);

    const last = await prepare();

    expect(last.status).toBe("prepared");
    expect(last.patch?.bytesRestored).toBe(VOLUME.byteLength);
    expect(meta().integrity).toBe("sha256");
    expect(meta().hashedArtifacts).toBe(1);
    // The claim is specific: these many bytes were read back and hashed.
    expect(meta().verifiedBytes).toBe(VOLUME.byteLength);
    expect(h.reads).toEqual([artifact.key]);
  });

  it("fails on a digest mismatch before any executor is resolved", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    // Same length, different bytes — precisely what the size-only check waved
    // through. `tar` would extract this happily onto a live volume.
    const corrupt = Buffer.from("openship-volume-archive-BYTES");
    expect(corrupt.byteLength).toBe(VOLUME.byteLength);
    h.objects.set(artifact.key, corrupt);

    const last = await prepare();

    expect(last.status).toBe("failed");
    const message = String(last.patch?.errorMessage);
    // Both digests, because "wrong archive" and "damaged archive" are different
    // problems and the operator's next step differs.
    expect(message).toContain(VOLUME_SHA);
    expect(message).toContain(sha256(corrupt));
    expect(message).toContain("Nothing has been stopped or overwritten");
    // The point of verifying in prepare.
    expect(h.targetTouched).toBe(false);
  });

  it("hashes every artifact, not just the first", async () => {
    const good = recorded();
    const second = recorded({ key: "org_1/bkr_1/volume-uploads.tar.zst" });
    h.artifacts = [good, second];
    h.objects.set(good.key, VOLUME);
    h.objects.set(second.key, Buffer.from("openship-volume-archive-BYTES"));

    const last = await prepare();

    expect(last.status).toBe("failed");
    expect(String(last.patch?.errorMessage)).toContain(second.key);
  });

  it("still reports a pruned artifact as pruned rather than failing mid-read", async () => {
    h.artifacts = [recorded()];
    // Nothing registered in the destination.
    const last = await prepare();

    expect(last.status).toBe("failed");
    expect(String(last.patch?.errorMessage)).toContain("may have been pruned");
    expect(h.reads).toEqual([]);
  });

  it("keeps the size check as a distinct, earlier failure", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, Buffer.concat([VOLUME, Buffer.from("!")]));

    const last = await prepare();

    expect(last.status).toBe("failed");
    expect(String(last.patch?.errorMessage)).toContain("size mismatch");
    // Cheaper round trip first: no full read needed to know this is wrong.
    expect(h.reads).toEqual([]);
  });
});

describe("what happens when a digest was never recorded", () => {
  it("falls back to size-only, warns, and says so on the row", async () => {
    const artifact = recorded({ sha256: null });
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);

    const last = await prepare();

    expect(last.status).toBe("prepared");
    expect(meta().integrity).toBe("size-only");
    expect(meta().unverifiableArtifacts).toEqual([artifact.key]);
    expect(meta().verifiedBytes).toBe(0);
    const warning = h.events.find((e) => e.type === "warning");
    expect(String(warning?.message)).toContain("no recorded sha256");
  });

  it("labels a partly-hashable run by its weakest link", async () => {
    const hashable = recorded();
    const not = recorded({ key: "org_1/bkr_1/legacy.tar", sha256: null });
    h.artifacts = [hashable, not];
    h.objects.set(hashable.key, VOLUME);
    h.objects.set(not.key, VOLUME);

    await prepare();

    // One artifact we cannot vouch for means the RUN is not sha256-verified,
    // however many others were — and the list names which one.
    expect(meta().integrity).toBe("size-only");
    expect(meta().hashedArtifacts).toBe(1);
    expect(meta().unverifiableArtifacts).toEqual([not.key]);
  });
});

describe("verifyOnPrepare = false", () => {
  it("skips the read, marks the row deferred, and warns loudly", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);
    h.policyId = "bkp_1";
    h.policyConfig = { verifyOnPrepare: false };

    const last = await prepare();

    expect(last.status).toBe("prepared");
    expect(meta().integrity).toBe("deferred");
    // The whole point of the opt-out: no second full read of the archive.
    expect(h.reads).toEqual([]);
    // Presence and size are still checked — the opt-out is about hashing.
    expect(last.patch?.bytesRestored).toBe(VOLUME.byteLength);
    const warning = h.events.find((e) => e.type === "warning");
    expect(String(warning?.message)).toContain("after the target has been cleared");
  });

  it("verifies anyway when the policy is gone", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);
    // policyId is SET NULL on policy delete. Absence is not consent to skip.
    h.policyId = null;

    await prepare();
    expect(meta().integrity).toBe("sha256");
  });

  it("verifies when the policy simply does not mention the knob", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);
    h.policyId = "bkp_1";
    h.policyConfig = { sourceIds: ["pgdata"] };

    await prepare();
    expect(meta().integrity).toBe("sha256");
  });
});

describe("the destination's own manifest is finally consulted", () => {
  it("cross-checks it against the recorded artifact list", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);
    h.manifestKey = "org_1/bkr_1/manifest.json";
    h.objects.set(h.manifestKey, manifestFor([artifact]));

    const last = await prepare();

    expect(last.status).toBe("prepared");
    expect(meta().manifest).toBe("verified");
  });

  it("continues on the recorded list when there is no manifest", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);
    // Runs captured before manifests were written have none. Not a failure.
    h.manifestKey = null;

    const last = await prepare();

    expect(last.status).toBe("prepared");
    expect(meta().manifest).toBe("missing");
    expect(meta().integrity).toBe("sha256");
  });

  it("continues when the manifest key is recorded but unreadable", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);
    h.manifestKey = "org_1/bkr_1/manifest.json"; // never stored

    const last = await prepare();

    expect(last.status).toBe("prepared");
    expect(meta().manifest).toBe("missing");
  });

  it("hard-fails when a present manifest lists an artifact we never captured", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);
    h.manifestKey = "org_1/bkr_1/manifest.json";
    h.objects.set(
      h.manifestKey,
      manifestFor([artifact, recorded({ key: "org_1/bkr_1/volume-elsewhere.tar.zst" })]),
    );

    const last = await prepare();

    expect(last.status).toBe("failed");
    expect(String(last.patch?.errorMessage)).toContain("volume-elsewhere.tar.zst");
    expect(h.targetTouched).toBe(false);
  });

  it("hard-fails when a present manifest omits one we did capture", async () => {
    const artifact = recorded();
    const other = recorded({ key: "org_1/bkr_1/volume-uploads.tar.zst" });
    h.artifacts = [artifact, other];
    h.objects.set(artifact.key, VOLUME);
    h.objects.set(other.key, VOLUME);
    h.manifestKey = "org_1/bkr_1/manifest.json";
    h.objects.set(h.manifestKey, manifestFor([artifact]));

    const last = await prepare();

    expect(last.status).toBe("failed");
    expect(String(last.patch?.errorMessage)).toContain(other.key);
  });

  it("hard-fails when the manifest's digest disagrees with the run's", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);
    h.manifestKey = "org_1/bkr_1/manifest.json";
    h.objects.set(h.manifestKey, manifestFor([recorded({ sha256: "b".repeat(64) })]));

    const last = await prepare();

    expect(last.status).toBe("failed");
    expect(String(last.patch?.errorMessage)).toContain("manifest sha256");
  });

  it("rejects a manifest of an unsupported version", async () => {
    const artifact = recorded();
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);
    h.manifestKey = "org_1/bkr_1/manifest.json";
    // Reachable only through validateManifest — proof it's wired, which it
    // wasn't: the function had zero call sites in the whole repo.
    h.objects.set(h.manifestKey, Buffer.from(JSON.stringify({ version: 2, artifacts: [] })));

    const last = await prepare();

    expect(last.status).toBe("failed");
    expect(String(last.patch?.errorMessage)).toContain("Unsupported manifest version");
  });
});

describe("digest normalization", () => {
  it("accepts a recorded digest written with a sha256: prefix or in upper case", async () => {
    const artifact = recorded({ sha256: `SHA256:${VOLUME_SHA.toUpperCase()}` });
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);

    const last = await prepare();

    expect(last.status).toBe("prepared");
    expect(meta().integrity).toBe("sha256");
  });

  it("treats a malformed digest as unverifiable rather than as a mismatch", async () => {
    // "not-a-digest" is not a wrong hash — it's an absent one. Failing the
    // restore over it would strand a perfectly good archive.
    const artifact = recorded({ sha256: "not-a-digest" });
    h.artifacts = [artifact];
    h.objects.set(artifact.key, VOLUME);

    const last = await prepare();

    expect(last.status).toBe("prepared");
    expect(meta().integrity).toBe("size-only");
  });
});
