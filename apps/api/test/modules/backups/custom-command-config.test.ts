/**
 * D5: every custom_command backup ever captured was unrestorable.
 *
 * The orchestrator built the producer's opts by hand-picking three keys off
 * `policy.payloadConfig` (`sourceIds`, `command`, `exclude`) and dropped
 * `produceCommand` / `restoreCommand` / `artifactName` — the exact three a
 * mail-server policy writes (`mail/admin/backup-plan.ts`). The producer read
 * them back through an `as ProducerOpts & CustomConfig` cast, so the typechecker
 * saw nothing wrong. The result was either a throw naming `produceCommand` as
 * missing when the operator HAD supplied it, or — where a legacy `command` was
 * set — an artifact recorded with `restoreCommand: null`, which
 * `CustomCommandProducer.restore` refuses forever.
 *
 * So the assertion that pins this is one hop: the policy row in, the RECORDED
 * artifact metadata out, with the real CustomCommandProducer and the real
 * registry in between. Nothing about the producer is faked — only the shell it
 * runs on and the bucket it writes to.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { createHash } from "node:crypto";

import { buildMailBackupPayload } from "../../../src/modules/mail/admin/backup-plan";

const h = vi.hoisted(() => ({
  /** payloadConfig the policy under test carries. */
  payloadConfig: {} as Record<string, unknown>,
  /** Commands the fake executor was asked to run. */
  execCommands: [] as string[],
  /** stdin the fake executor received, per pipeIntoCommand call. */
  pipedInto: [] as Array<{ command: string; body: string }>,
  /** Every put the destination saw. */
  puts: [] as Array<{ key: string; opts: Record<string, unknown>; bytes: Buffer }>,
  /** Etag the fake destination reports back. Null = report none (SFTP-like). */
  etag: null as string | null,
  /** Terminal status + patch history for the run row. */
  row: {} as Record<string, unknown>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    backupRun: {
      findById: async () => ({
        id: "bkr_live",
        status: "queued",
        policyId: "pol_mail",
        serviceId: null,
        mailServerId: "mail_1",
        organizationId: "org_1",
      }),
      transition: async (_id: string, status: string, patch?: Record<string, unknown>) => {
        Object.assign(h.row, { status }, patch ?? {});
      },
    },
    backupPolicy: {
      findById: async () => ({
        id: "pol_mail",
        destinationId: "dst_1",
        sourceKind: "mail_server",
        mailServerId: "mail_1",
        projectId: null,
        payloadKind: "custom_command",
        preHook: null,
        postHook: null,
        hookTimeoutSeconds: 30,
        payloadConfig: h.payloadConfig,
      }),
    },
    backupDestination: {
      findById: async () => ({
        id: "dst_1",
        organizationId: "org_1",
        name: "Local",
        pathPrefix: null,
      }),
      setLastVerified: async () => {},
    },
    mailServer: { get: async () => ({ id: "mail_1", domain: "mail.example.com" }) },
  },
}));

// PARTIAL mock: the registry, the hasher, the key builders and the manifest
// builder all stay real, so `resolveProducer("custom_command")` returns the
// actual CustomCommandProducer. Only the shell and the bucket are stand-ins.
vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/adapters")>();
  const { PassThrough: PT, Readable: R } = await import("node:stream");
  return {
    ...actual,
    resolveDestination: () => ({
      preflight: async () => ({ ok: true }),
      put: async (key: string, body: NodeJS.ReadableStream, opts: Record<string, unknown>) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
        const bytes = Buffer.concat(chunks);
        h.puts.push({ key, opts, bytes });
        return { bytesWritten: bytes.byteLength, ...(h.etag ? { etag: h.etag } : {}) };
      },
    }),
    resolveExecutor: () => ({
      execStream: async (_svc: unknown, argv: string[]) => {
        h.execCommands.push(argv[argv.length - 1]);
        const stdout = new PT();
        stdout.end(Buffer.from("ARCHIVE-BYTES"));
        return { stdout, awaitExit: Promise.resolve({ code: 0, stderr: "" }) };
      },
      pipeIntoCommand: async (
        _svc: unknown,
        argv: string[],
        body: NodeJS.ReadableStream,
      ) => {
        const chunks: Buffer[] = [];
        for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
        h.pipedInto.push({
          command: argv[argv.length - 1],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        return { code: 0, stderr: "" };
      },
      isRunning: async () => false,
      listSources: async () => [],
      // Unused here but part of the surface `R` keeps referenced.
      receiveStream: async () => R.from([]),
    }),
  };
});

vi.mock("../../../src/lib/job-runner", () => ({
  getJobRunner: async () => ({ enqueueRun: async () => {} }),
}));
vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveTargetPlatform: async () => ({ runtime: { name: "bare" } }),
  resolveDeploymentPlatform: async () => ({ platform: { runtime: { name: "bare" } } }),
}));
vi.mock("../../../src/lib/encryption", () => ({ decryptEnvMap: (v: unknown) => v }));
vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: { emit: () => {} },
}));
vi.mock("../../../src/modules/backup-destinations/hydrate-server", () => ({
  toAdapterRow: async (row: unknown) => row,
}));
vi.mock("../../../src/modules/services/service-container", () => ({
  liveContainerIdForService: async () => null,
}));

const { BackupOrchestrator } = await import("../../../src/modules/backups/backup.orchestrator");
// Producers self-register by side effect and aren't exported by name, so this is
// also the registry lookup the orchestrator itself makes.
const { resolveProducer, resolveExecutor } = await import("@repo/adapters");

interface RecordedArtifact {
  name: string;
  key: string;
  sha256: string;
  sizeBytes: number;
  payloadKind: string;
  metadata: Record<string, unknown>;
}

const recorded = (): RecordedArtifact[] => (h.row.artifacts ?? []) as RecordedArtifact[];

beforeEach(() => {
  h.payloadConfig = {};
  h.execCommands.length = 0;
  h.pipedInto.length = 0;
  h.puts.length = 0;
  h.etag = null;
  h.row = {};
});

describe("a mail policy's payloadConfig reaches the producer", () => {
  const mail = buildMailBackupPayload("mail.example.com", { messageData: true, keys: true });

  beforeEach(() => {
    h.payloadConfig = { ...mail.payloadConfig };
  });

  it("runs the policy's produceCommand, not a missing `command`", async () => {
    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("succeeded");
    // Before the fix this threw "custom_command producer requires
    // `produceCommand` in policy payload config" — for a policy that had one.
    expect(h.row.errorMessage).toBeUndefined();
    expect(h.execCommands).toHaveLength(1);
    expect(h.execCommands[0]).toBe(mail.payloadConfig.produceCommand);
  });

  it("records a restoreCommand, which is the whole point", async () => {
    await new BackupOrchestrator().execute("bkr_live");

    expect(recorded()).toHaveLength(1);
    // THE defect: this was null on every mail backup on every instance, and
    // it is the only record of how to put the archive back.
    expect(recorded()[0].metadata.restoreCommand).toBe(mail.payloadConfig.restoreCommand);
    expect(String(recorded()[0].metadata.produceCommand)).toContain("pg_dump");
  });

  it("keeps a multiline command out of the upload's headers, not out of the record", async () => {
    // S3 carries object metadata as `x-amz-meta-*` HTTP headers, which may not
    // contain newlines — so a policy whose restoreCommand spans lines failed the
    // upload itself. Only the PUT is filtered: restore reads the RECORDED
    // metadata, so the command has to survive there verbatim or this is just the
    // D5 defect again by another route.
    const multiline = "set -e\npsql -U postgres < /tmp/dump.sql";
    h.payloadConfig = { ...mail.payloadConfig, restoreCommand: multiline };

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("succeeded");
    expect((h.puts[0]!.opts.metadata as Record<string, unknown>).restoreCommand).toBeUndefined();
    expect(recorded()[0].metadata.restoreCommand).toBe(multiline);
  });

  it("honors artifactName in the destination key", async () => {
    await new BackupOrchestrator().execute("bkr_live");

    expect(recorded()[0].name).toBe("mail.tar.zst");
    expect(recorded()[0].key).toContain("mail.tar.zst");
    // Not the fallback the dropped key left behind.
    expect(recorded()[0].name).not.toBe("custom-backup.bin");
  });

  it("yields an artifact the producer can actually restore", async () => {
    // The end of the chain: feed the RECORDED metadata straight back into the
    // real producer's restore. This is what threw "Backup has no restoreCommand
    // recorded" for every existing mail backup.
    await new BackupOrchestrator().execute("bkr_live");
    const artifact = recorded()[0];

    await resolveProducer("custom_command").restore!(
      {
        id: "mail_1",
        projectId: "",
        name: "mail",
        image: null,
        env: {},
        volumes: [],
        containerId: null,
        projectSlug: "mail",
        namespaceVolumes: false,
      },
      resolveExecutor("bare", {} as never),
      {
        key: artifact.key,
        metadata: artifact.metadata,
        payloadKind: "custom_command",
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        open: async () => Readable.from([Buffer.from("ARCHIVE-BYTES")]),
      },
      {},
    );

    expect(h.pipedInto).toHaveLength(1);
    expect(h.pipedInto[0].command).toBe(mail.payloadConfig.restoreCommand);
    expect(h.pipedInto[0].body).toBe("ARCHIVE-BYTES");
  });
});

describe("payloadConfig forwarding is not mail-specific", () => {
  it("carries a minimal custom policy through, defaulting the artifact name", async () => {
    h.payloadConfig = {
      produceCommand: "sqlite3 /data/app.db .dump",
      restoreCommand: "sqlite3 /data/app.db",
    };

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("succeeded");
    expect(recorded()[0].name).toBe("custom-backup.bin");
    expect(recorded()[0].metadata.restoreCommand).toBe("sqlite3 /data/app.db");
  });

  it("still honors the legacy `command` alias", async () => {
    // `command` was the one key the old pick DID forward, so policies written
    // against it must keep working.
    h.payloadConfig = { command: "cat /data/dump.bin", restoreCommand: "tee /data/dump.bin" };

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.execCommands[0]).toBe("cat /data/dump.bin");
    expect(recorded()[0].metadata.restoreCommand).toBe("tee /data/dump.bin");
  });

  it("fails clearly when the policy really has no produce command", async () => {
    h.payloadConfig = { restoreCommand: "tee /data/dump.bin" };

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("failed");
    expect(String(h.row.errorMessage)).toContain("produceCommand");
  });
});

describe("artifact integrity at capture time", () => {
  beforeEach(() => {
    h.payloadConfig = { produceCommand: "cat /data/x", restoreCommand: "tee /data/x" };
  });

  it("gates the manifest on a sha256 it knows up front", async () => {
    await new BackupOrchestrator().execute("bkr_live");

    const manifest = h.puts.find((p) => p.key.endsWith("manifest.json"));
    expect(manifest).toBeDefined();
    // Buffered, so the digest and the real length are both knowable before the
    // body moves — the previous `size: 0` also lied to S3's multipart threshold.
    expect(manifest!.opts.sha256).toBe(createHash("sha256").update(manifest!.bytes).digest("hex"));
    expect(manifest!.opts.size).toBe(manifest!.bytes.byteLength);
  });

  it("fails the run when the destination stored different bytes", async () => {
    // A streamed artifact's digest can't be handed to `put` up front, so the
    // check runs the other way: local reports the sha256 it hashed as it landed
    // the file. Recording OUR digest over a disagreement would make restore's
    // verification pass against corrupt bytes.
    h.etag = "0".repeat(64);

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("failed");
    expect(String(h.row.errorMessage)).toContain("changed in transit");
  });

  it("ignores an etag that isn't a sha256", async () => {
    // S3 reports an MD5 (or a multipart composite); comparing it to a sha256
    // would fail every S3 backup.
    h.etag = "d41d8cd98f00b204e9800998ecf8427e";

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("succeeded");
  });

  it("accepts a destination that reports the matching digest", async () => {
    h.etag = createHash("sha256").update(Buffer.from("ARCHIVE-BYTES")).digest("hex").toUpperCase();

    await new BackupOrchestrator().execute("bkr_live");

    expect(h.row.status).toBe("succeeded");
    expect(recorded()[0].sha256).toBe(h.etag.toLowerCase());
  });
});

describe("PassThrough sanity", () => {
  it("keeps the fake executor's stdout drainable", async () => {
    // Guards the fixture itself: a stdout that never ends would hang the
    // orchestrator's upload rather than fail it, and every test above would
    // time out with no useful signal.
    const pt = new PassThrough();
    pt.end("x");
    const chunks: Buffer[] = [];
    for await (const c of pt) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe("x");
  });
});
