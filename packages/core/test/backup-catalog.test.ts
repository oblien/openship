/**
 * The catalog's invariants, and the policy rules built on it.
 *
 * These tests exist because the catalog's whole value is a claim: that every fact about
 * a payload kind is stated exactly once, and that adding a kind cannot leave a fact
 * unstated. `Record<PayloadKind, …>` gets most of the way there at compile time, but
 * three things it cannot check are the ones that actually broke before:
 *
 *   - a spec whose `kind` field disagrees with the key it is filed under (copy-paste),
 *   - two kinds claiming the same image, which decides a backup silently,
 *   - the catalog's image table and `detectDbImage` disagreeing — which IS #611: the
 *     dialog promising pg_dump while the run took a volume snapshot of nothing.
 *
 * The registration-ORDER half of the contract is asserted in
 * `packages/adapters/test/backup-catalog-registry.test.ts`, where the registry lives.
 */

import { describe, expect, it } from "vitest";
import {
  ALL_PAYLOAD_CONFIG_KEYS,
  PAYLOAD_COMPRESSION_CODECS,
  BACKUP_PAYLOADS,
  PAYLOAD_KINDS,
  PAYLOAD_KIND_AUTO,
  imageDetectableSpecs,
  isPayloadCompression,
  isPayloadKind,
  isPolicyPayloadKind,
  normalizeBackupPath,
  operatorSelectableKinds,
  payloadSpec,
  requiresRestoreCommand,
  restoreAppliesAfterBounce,
  restoreClearsTarget,
  restoreFailureLeavesTargetIntact,
  restoreNeedsLiveContainer,
  validateBackupPath,
  validateClearPath,
  validatePolicyPayload,
} from "../src/backup-catalog";
import { detectDbImage } from "../src/backup-image-detect";

describe("the catalog is exhaustive and self-consistent", () => {
  it("has a spec for every kind, filed under its own name", () => {
    for (const kind of PAYLOAD_KINDS) {
      const spec = BACKUP_PAYLOADS[kind];
      expect(spec, kind).toBeDefined();
      // The check `Record<…>` cannot do: a spec pasted from its neighbour keeps the
      // neighbour's `kind`, and then `payloadSpec("path").kind` says "volume" while
      // every type still checks out.
      expect(spec.kind, kind).toBe(kind);
      expect(spec.label.trim(), kind).not.toBe("");
      expect(spec.method.trim(), kind).not.toBe("");
      expect(spec.restoreTimeoutMs, kind).toBeGreaterThan(0);
    }
  });

  it("holds no kind outside the union", () => {
    // Guards the other direction: a stale entry left behind after a kind is removed
    // would keep answering `payloadSpec` lookups for a producer that no longer exists.
    expect(Object.keys(BACKUP_PAYLOADS).sort()).toEqual([...PAYLOAD_KINDS].sort());
  });

  it("declares every payloadConfig key it references", () => {
    for (const spec of Object.values(BACKUP_PAYLOADS)) {
      for (const key of spec.configKeys) {
        expect(ALL_PAYLOAD_CONFIG_KEYS, `${spec.kind}.${key}`).toContain(key);
      }
    }
  });

  it("throws on an unknown kind rather than defaulting", () => {
    // A policy row holding a kind this build has no producer for is a real state — a
    // downgrade, a hand-edited row, an import from a newer instance. Quietly treating
    // it as `volume` would back up the wrong thing and report success.
    expect(() => payloadSpec("pg_dumpp" as never)).toThrow(/Unknown backup payload kind/);
  });

  it("recognises kinds and the policy-only `auto`", () => {
    expect(isPayloadKind("pg_dump")).toBe(true);
    expect(isPayloadKind(PAYLOAD_KIND_AUTO)).toBe(false);
    expect(isPolicyPayloadKind(PAYLOAD_KIND_AUTO)).toBe(true);
    expect(isPayloadKind("nope")).toBe(false);
    expect(isPayloadKind(undefined)).toBe(false);
  });
});

describe("restore semantics are stated per kind, not inferred", () => {
  it("names exactly the kinds that write through a live container", () => {
    const live = PAYLOAD_KINDS.filter(restoreNeedsLiveContainer);
    // `volume` and `path` are the interesting pair, and they differ for a reason worth
    // pinning: a volume restore mounts into a separate helper, so it survives the
    // service's container being gone; a path restore execs `tar` inside the service.
    expect(live.sort()).toEqual(
      ["custom_command", "mongo_dump", "mysql_dump", "path", "pg_dump", "redis_rdb"].sort(),
    );
    expect(restoreNeedsLiveContainer("volume")).toBe(false);
  });

  it("names exactly the kinds whose write only takes effect after a bounce", () => {
    // One kind, not a category — the logical dumps apply through the live server. This
    // assertion is the guard against the two flags being conflated again: conflating
    // them is what made every redis restore a silent no-op.
    expect(PAYLOAD_KINDS.filter(restoreAppliesAfterBounce)).toEqual(["redis_rdb"]);
  });

  it("names exactly the kinds whose failed restore leaves the target untouched", () => {
    // One kind, and it is allowed to SUPPRESS the partial-data warning — so this
    // assertion is the gate on that list, not documentation of it. Adding a kind here
    // means claiming the engine gives an all-or-nothing guarantee; getting that wrong
    // tells an operator their data is intact when it is half-written, which is the one
    // direction of error this module exists to prevent.
    expect(PAYLOAD_KINDS.filter(restoreFailureLeavesTargetIntact)).toEqual(["pg_dump"]);
  });

  it("keeps the atomicity claim to kinds that write through the engine", () => {
    // A filesystem shape can never claim it: `tar -x` writes file by file, and with
    // clearing on, the target is emptied before the first byte arrives.
    for (const kind of PAYLOAD_KINDS) {
      if (payloadSpec(kind).shape !== "filesystem") continue;
      expect(restoreFailureLeavesTargetIntact(kind), kind).toBe(false);
    }
    // Nor can the opaque one: it is the operator's own command, and we cannot reason
    // about what it does halfway through.
    expect(restoreFailureLeavesTargetIntact("custom_command")).toBe(false);
  });

  it("never claims atomicity for a kind that also clears its target", () => {
    // The two facts would contradict each other: clearing happens BEFORE the write, so a
    // failure has already destroyed the target no matter what the write does after.
    for (const kind of PAYLOAD_KINDS) {
      const spec = payloadSpec(kind);
      if (!spec.restoreClearsTargetByDefault) continue;
      expect(spec.restoreFailureLeavesTargetIntact, kind).toBe(false);
    }
    // Including when an operator opts INTO clearing on a kind that defaults to merging.
    for (const kind of PAYLOAD_KINDS) {
      if (!restoreClearsTarget(kind, { clearPath: true })) continue;
      expect(restoreFailureLeavesTargetIntact(kind), kind).toBe(false);
    }
  });

  it("names exactly the kinds that cannot be restored without a recorded command", () => {
    expect(PAYLOAD_KINDS.filter(requiresRestoreCommand)).toEqual(["custom_command"]);
    // `auto` is not a kind and must not be asked to answer this.
    expect(requiresRestoreCommand(PAYLOAD_KIND_AUTO)).toBe(false);
  });

  it("gives folders and volumes the same generous ceiling", () => {
    // Both archive trees whose size is unbounded by anything we control; a dump has a
    // server on the other end that fails faster.
    expect(payloadSpec("path").restoreTimeoutMs).toBe(payloadSpec("volume").restoreTimeoutMs);
    expect(payloadSpec("redis_rdb").restoreTimeoutMs).toBeLessThan(
      payloadSpec("pg_dump").restoreTimeoutMs,
    );
  });
});

describe("the image table and the matcher agree", () => {
  it("detects every name the catalog claims, as the kind that claims it", () => {
    // The mechanical closing of #611. Any name added to a spec is now covered here
    // without the test being edited, and a name that the regex rule cannot actually
    // match (a typo, a stray space, a leading slash) fails immediately.
    for (const spec of imageDetectableSpecs()) {
      for (const name of spec.images.names) {
        expect(detectDbImage(name)?.payloadKind, name).toBe(spec.kind);
        expect(detectDbImage(`${name}:1.2.3`)?.payloadKind, `${name}:1.2.3`).toBe(spec.kind);
      }
      for (const ns of spec.images.namespaces ?? []) {
        expect(detectDbImage(`${ns}/anything:1`)?.payloadKind, ns).toBe(spec.kind);
      }
    }
  });

  it("lets no image be claimed by two kinds", () => {
    // Two kinds matching one image makes the backup depend on registration order, which
    // is a decision nobody would have made on purpose.
    const claimed = new Map<string, string>();
    for (const spec of imageDetectableSpecs()) {
      for (const name of spec.images.names) {
        const prior = claimed.get(name);
        expect(prior, `${name} claimed by ${prior} and ${spec.kind}`).toBeUndefined();
        claimed.set(name, spec.kind);
      }
    }
  });

  it("gives every image-detectable kind a label the dialog can show", () => {
    for (const spec of imageDetectableSpecs()) {
      expect(detectDbImage(spec.images.names[0])).toEqual({
        payloadKind: spec.kind,
        label: spec.label,
        method: spec.method,
      });
    }
  });

  it("keeps the fallback and explicit-only kinds out of image detection", () => {
    // `volume` is chosen by the registry when nothing detects; `path` and
    // `custom_command` are named by an operator. None of them may be selected by an
    // image, or the DB kinds would stop being reachable.
    const detectable = imageDetectableSpecs().map((s) => s.kind);
    expect(detectable).not.toContain("volume");
    expect(detectable).not.toContain("path");
    expect(detectable).not.toContain("custom_command");
  });

  it("offers every kind to an operator", () => {
    // Forcing a kind is the fix for an adopted service whose image `auto` cannot read —
    // `acme/pg-custom:1` is a PostgreSQL, and the difference between a dump and a tar of
    // a live data directory is the difference between a usable and a corrupt restore.
    expect(operatorSelectableKinds().map((s) => s.kind).sort()).toEqual([...PAYLOAD_KINDS].sort());
  });
});

describe("path validation", () => {
  it("reduces a path to one spelling", () => {
    expect(normalizeBackupPath("/data//app/")).toBe("/data/app");
    expect(normalizeBackupPath("  /data/app  ")).toBe("/data/app");
    expect(normalizeBackupPath("/")).toBe("/");
    expect(normalizeBackupPath("/data/")).toBe("/data");
  });

  it("refuses what cannot be archived safely", () => {
    expect(validateBackupPath("/var/www")).toBeNull();
    expect(validateBackupPath("/data")).toBeNull();
    // Relative: resolved against whatever directory the exec happened to start in.
    expect(validateBackupPath("data/app")).toMatch(/must be absolute/);
    // Traversal: the path shown to the operator is not the path that gets touched.
    expect(validateBackupPath("/data/../etc")).toMatch(/contains "\.\."/);
    expect(validateBackupPath("/")).toMatch(/whole filesystem/);
    expect(validateBackupPath("   ")).toMatch(/must be absolute|cannot be empty/);
  });

  it("archiving a system directory is allowed; emptying one is not", () => {
    // The asymmetry is the point. Backing up /etc/nginx is ordinary. Emptying /etc
    // before extracting into it destroys the container.
    expect(validateBackupPath("/etc/nginx")).toBeNull();
    expect(validateClearPath("/etc/nginx")).toMatch(/holds the operating system/);
    expect(validateClearPath("/usr/share/nginx/html")).toMatch(/holds the operating system/);
  });

  it("refuses to clear a top-level directory", () => {
    // `/data` is plausibly a mount point the operator never chose; `/data/app` is one
    // they did. A second segment costs nothing and removes the whole class.
    expect(validateClearPath("/data")).toMatch(/top-level directory/);
    expect(validateClearPath("/data/app")).toBeNull();
    // Canonicalization must not be a way past the check.
    expect(validateClearPath("/data//")).toMatch(/top-level directory/);
  });
});

describe("validatePolicyPayload refuses a policy that could not be restored", () => {
  const ok = (kind: unknown, cfg?: Record<string, unknown>) =>
    expect(validatePolicyPayload(kind, cfg)).toBeNull();

  it("accepts the ordinary shapes", () => {
    ok(PAYLOAD_KIND_AUTO, {});
    ok("volume", { sourceIds: ["pgdata"], quiesce: true, compression: "gzip" });
    ok(undefined, undefined);
    ok(null, null);
    ok("path", { paths: ["/var/www/html"] });
    ok("custom_command", { produceCommand: "cat /db.sqlite", restoreCommand: "cat > /db.sqlite" });
  });

  it("refuses an unrecognised kind at save time", () => {
    // This used to save fine and fail once, later, in the orchestrator — after the
    // schedule had been advertised to the operator as active.
    expect(validatePolicyPayload("pg_dumps", {})).toMatch(/Unknown backup payload kind/);
    expect(validatePolicyPayload("PG_DUMP", {})).toMatch(/Unknown backup payload kind/);
  });

  it("refuses an option no producer reads", () => {
    // A typo here is a policy that looks configured and captures nothing.
    expect(validatePolicyPayload("volume", { sourceIDs: ["x"] })).toMatch(
      /Unknown backup payload option "sourceIDs"/,
    );
  });

  it("accepts the cross-kind options that are not capture options", () => {
    // Both were read in production and documented nowhere. A validator built from the
    // keys producers read would have refused every mail policy and every restore that
    // turns verification off.
    ok("volume", { verifyOnPrepare: false });
    ok("custom_command", {
      produceCommand: "tar -c /x",
      restoreCommand: "tar -x",
      mail: { messageData: true, keys: false },
    });
  });

  it("keeps a cross-kind option from blocking a kind change", () => {
    // Switching a policy from volume to pg_dump must not be blocked by the `exclude` it
    // no longer uses — otherwise the operator cannot fix the kind.
    ok("pg_dump", { exclude: ["*.log"] });
  });

  it("refuses a custom command with only one half of the round trip", () => {
    expect(validatePolicyPayload("custom_command", { produceCommand: "cat /db" })).toMatch(
      /needs `payloadConfig.restoreCommand`/,
    );
    expect(validatePolicyPayload("custom_command", { restoreCommand: "cat > /db" })).toMatch(
      /needs `payloadConfig.produceCommand`/,
    );
    // `command` is the dashboard's legacy name for the produce half and the producer
    // still reads it, so a policy carrying only it stays saveable.
    ok("custom_command", { command: "cat /db", restoreCommand: "cat > /db" });
  });

  it("refuses a folder policy that names no folder", () => {
    expect(validatePolicyPayload("path", {})).toMatch(/needs `payloadConfig.paths`/);
    expect(validatePolicyPayload("path", { paths: [] })).toMatch(/needs `payloadConfig.paths`/);
    expect(validatePolicyPayload("path", { paths: "/data" })).toMatch(
      /needs `payloadConfig.paths`/,
    );
    expect(validatePolicyPayload("path", { paths: [42] })).toMatch(/must be a string/);
  });

  it("refuses folder paths that are unsafe or redundant", () => {
    expect(validatePolicyPayload("path", { paths: ["relative/dir"] })).toMatch(/must be absolute/);
    expect(validatePolicyPayload("path", { paths: ["/data/../etc"] })).toMatch(/contains "\.\."/);
    expect(validatePolicyPayload("path", { paths: ["/"] })).toMatch(/whole filesystem/);
    // Two spellings of one directory would archive it twice under two names, and restore
    // it twice in an order nobody chose.
    expect(validatePolicyPayload("path", { paths: ["/data/app", "/data/app/"] })).toMatch(
      /listed more than once/,
    );
  });

  it("only applies the clear rules when clearing was asked for", () => {
    // Archiving /etc/nginx is fine; asking the restore to empty it first is not.
    ok("path", { paths: ["/etc/nginx"] });
    expect(validatePolicyPayload("path", { paths: ["/etc/nginx"], clearPath: true })).toMatch(
      /holds the operating system/,
    );
    expect(validatePolicyPayload("path", { paths: ["/data"], clearPath: true })).toMatch(
      /top-level directory/,
    );
    ok("path", { paths: ["/data/app"], clearPath: true });
    // Every path is checked, not just the first.
    expect(
      validatePolicyPayload("path", { paths: ["/data/app", "/usr/lib/x"], clearPath: true }),
    ).toMatch(/holds the operating system/);
  });
});

describe("who clears their target on restore", () => {
  it("is exactly the volume kind, and nothing else", () => {
    // The list, asserted rather than described. Adding a kind that destroys before
    // writing should be a deliberate edit to this test, not a default inherited from a
    // call site.
    const clears = PAYLOAD_KINDS.filter((k) => BACKUP_PAYLOADS[k].restoreClearsTargetByDefault);
    expect(clears).toEqual(["volume"]);
  });

  it("never resolves an absent or unreadable config to clearing", () => {
    // A run can outlive its policy (the FK is `set null`). "We could not find out what
    // you wanted" must not mean "empty the target".
    for (const kind of PAYLOAD_KINDS) {
      const fallback = BACKUP_PAYLOADS[kind].restoreClearsTargetByDefault;
      expect(restoreClearsTarget(kind, null), kind).toBe(fallback);
      expect(restoreClearsTarget(kind, {}), kind).toBe(fallback);
      expect(restoreClearsTarget(kind, { clearPath: "yes" }), kind).toBe(fallback);
    }
  });

  it("lets a path policy opt in and back out again", () => {
    expect(restoreClearsTarget("path", null)).toBe(false);
    expect(restoreClearsTarget("path", { clearPath: true })).toBe(true);
    expect(restoreClearsTarget("path", { clearPath: false })).toBe(false);
  });

  it("ignores the override on kinds that do not declare it", () => {
    // `clearPath` on a volume policy must not turn clearing OFF: the volume restore has
    // no merge semantics to fall back to, and a half-replaced volume is a hybrid of two
    // points in time.
    expect(restoreClearsTarget("volume", { clearPath: false })).toBe(true);
    // And it cannot turn clearing ON for a logical dump, where the flag is inert and
    // the loader owns replacement.
    expect(restoreClearsTarget("pg_dump", { clearPath: true })).toBe(false);
  });

  it("agrees with the config-key table about who can be overridden", () => {
    for (const kind of PAYLOAD_KINDS) {
      const overridable = BACKUP_PAYLOADS[kind].configKeys.includes("clearPath");
      const flipped = restoreClearsTarget(kind, {
        clearPath: !BACKUP_PAYLOADS[kind].restoreClearsTargetByDefault,
      });
      expect(flipped !== BACKUP_PAYLOADS[kind].restoreClearsTargetByDefault, kind).toBe(
        overridable,
      );
    }
  });
});

/**
 * The smallest `payloadConfig` a kind accepts, so a test about ONE rule is not
 * answered by a different rule. Built from the catalog's own requirements rather than
 * a literal per kind, so a new required key fails here loudly instead of quietly
 * making a later assertion vacuous.
 */
function minimallyValid(kind: string): Record<string, unknown> {
  const cfg: Record<string, unknown> = {};
  if (kind === PAYLOAD_KIND_AUTO) return cfg;
  const spec = payloadSpec(kind as (typeof PAYLOAD_KINDS)[number]);
  if (spec.requiresRestoreCommand) {
    cfg.produceCommand = "echo hi";
    cfg.restoreCommand = "cat > /tmp/x";
  }
  if (spec.configKeys.includes("paths")) cfg.paths = ["/data"];
  return cfg;
}

describe("the compression vocabulary is one list, and it is checked at save time", () => {
  it("narrows exactly the three codecs the pipeline can build", () => {
    for (const codec of PAYLOAD_COMPRESSION_CODECS) expect(isPayloadCompression(codec)).toBe(true);
    // Not merely "unknown strings" — these are the plausible ones. `br` and `brotli`
    // because they are real codecs someone would reasonably try; `zst` and `gz`
    // because they are the file EXTENSIONS this module writes, so copying a suffix
    // out of an artifact name is the likeliest way to produce a wrong value.
    for (const nope of ["brotli", "br", "zst", "gz", "xz", "lz4", "ZSTD", "gzip ", "", "auto"]) {
      expect(isPayloadCompression(nope), nope).toBe(false);
    }
  });

  it("rejects every non-string, so a jsonb number or object cannot pass as a codec", () => {
    for (const nope of [undefined, null, 0, 1, true, false, {}, [], ["zstd"], { codec: "zstd" }]) {
      expect(isPayloadCompression(nope), JSON.stringify(nope) ?? "undefined").toBe(false);
    }
  });

  it("refuses an unknown codec on EVERY kind, not only the two that declare it", () => {
    // Cross-kind keys are deliberately preserved when a policy switches kinds (see
    // validatePolicyPayload), so a bad value parked on a `pg_dump` policy comes back
    // the moment someone switches it to `path`. Checking only the declaring kinds
    // would let it be saved and then become live on the switch.
    for (const kind of [...PAYLOAD_KINDS, PAYLOAD_KIND_AUTO]) {
      // Otherwise-valid on purpose. The validator reports the FIRST problem it finds,
      // and a `custom_command` config missing its produceCommand fails on that
      // instead — which is how this test first passed for the wrong reason.
      const problem = validatePolicyPayload(kind, { ...minimallyValid(kind), compression: "brotli" });
      expect(problem, kind).toBeTruthy();
      // The message has to name the value and the alternatives — the operator's only
      // clue is this string, and "invalid payload config" would send them reading code.
      expect(problem, kind).toContain("brotli");
      for (const codec of PAYLOAD_COMPRESSION_CODECS) expect(problem, kind).toContain(codec);
    }
  });

  it("accepts every codec in the vocabulary, and an absent one", () => {
    for (const codec of PAYLOAD_COMPRESSION_CODECS) {
      expect(validatePolicyPayload("path", { paths: ["/data"], compression: codec }), codec).toBe(
        null,
      );
    }
    // Absent means "probe the container / use the producer default", which is a real
    // choice and the one every policy written before the key existed made.
    expect(validatePolicyPayload("path", { paths: ["/data"] })).toBe(null);
    expect(validatePolicyPayload("path", { paths: ["/data"], compression: undefined })).toBe(null);
  });

  it("would have caught the artifact nobody can open", () => {
    // The failure this refusal exists for: the compressor lookup falls through to
    // "apply nothing" for an unrecognised codec, so the artifact is written
    // UNCOMPRESSED while its metadata records the bogus name. The restore reads that
    // name through `recordedCodec`, which maps anything unknown to `zstd` — correctly,
    // since every artifact predating it was zstd — and pipes a plain tar through
    // `zstd -d`. Capture green, bytes real, restore impossible forever, and only
    // discoverable by attempting it. Save time is the last point it is recoverable.
    expect(validatePolicyPayload("volume", { compression: "brotli" })).toBeTruthy();
    expect(validatePolicyPayload("volume", { compression: "zstd" })).toBe(null);
  });
});

