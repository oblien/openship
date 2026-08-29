/**
 * The backup payload catalog — ONE table of what each payload kind IS and how it
 * behaves, read by every plane that needs to know.
 *
 * ## Why it exists
 *
 * A payload kind is not just a string on `backup_policy.payload_kind`. Each one
 * carries facts that four different layers act on:
 *
 *   - the producer, which knows the dump command (`packages/adapters/src/backup/producers/*`);
 *   - the RESTORE orchestrator, which must know whether the apply writes through a
 *     live process in the container, and whether the write only takes effect after
 *     the service is power-cycled (`apps/api/src/modules/backups/restore.orchestrator.ts`);
 *   - the policy service, which must refuse a policy that cannot produce a
 *     restorable artifact (`apps/api/src/modules/backups/backup.service.ts`);
 *   - the dashboard, which has to tell the operator what will happen before it does
 *     (`apps/dashboard/src/components/backup/PolicyEditor.tsx`).
 *
 * Those facts were stated separately in each layer, and every copy was a place to
 * drift. The two that had already drifted are the reason this file exists:
 *
 *   - The image→kind table was duplicated between the producers and the dialog, and
 *     the dialog's copy was labelled "display-only … drift here is cosmetic". It was
 *     not: [#611](https://github.com/oblien/openship/issues/611) is an operator
 *     reading *"Detected PostgreSQL — Auto backs it up with pg_dump"* while the run
 *     silently took a volume snapshot of nothing. That copy was consolidated into
 *     `backup-image-detect.ts`; the TABLE now lives here and that module is the
 *     matching mechanism over it.
 *   - `NEEDS_LIVE_CONTAINER` and `NEEDS_BOUNCE_AFTER_WRITE` are `Set`s of kinds in
 *     the API layer. A `Set` is not exhaustive, so adding a producer compiles clean
 *     and gets both answers wrong by omission — which is exactly how every Redis
 *     restore was a silent no-op: the bytes landed in `/data/dump.rdb` under a
 *     running server that only reads that file at startup.
 *
 * ## The rule this file enforces
 *
 * `BACKUP_PAYLOADS` is a `Record<PayloadKind, …>`, so a new kind added to the union
 * is a COMPILE ERROR until every fact about it is stated once, here. Nothing
 * downstream may re-derive these answers from a kind string; it asks the catalog.
 *
 * ## Where it lives, and why here
 *
 * `@repo/core` depends on nothing but zod, and it is the only package that
 * `packages/adapters`, `packages/db`, `apps/api`, `apps/cli` AND `apps/dashboard`
 * can all import — the dashboard cannot reach `@repo/adapters` at all, which is what
 * produced the mirrored table in the first place. So the catalog is here and the
 * adapter's `PayloadKind` re-exports from it rather than declaring its own union.
 *
 * What deliberately stays OUT: the dump and restore COMMANDS. They need an executor
 * to run against and belong with the producer that owns the engine's semantics
 * (`pg_restore --clean` is transactional, `mysql` replaying SQL is not). The catalog
 * holds the facts every layer shares; the producer holds the one thing only it does.
 */

/**
 * Every payload kind, in AUTO-DETECT PRIORITY order.
 *
 * The producer registry walks its producers in registration order and takes the
 * first whose `detects()` matches (`packages/adapters/src/backup/registry.ts`), and
 * `packages/adapters/src/backup/index.ts` controls that order by import order. This
 * array is the intended order written down where it can be asserted against, so the
 * two cannot silently disagree: the DB-specific kinds must precede `volume`, because
 * `volume` is the universal fallback and would otherwise swallow every database.
 */
export const PAYLOAD_KINDS = [
  "pg_dump",
  "mysql_dump",
  "redis_rdb",
  "mongo_dump",
  "custom_command",
  "path",
  "volume",
] as const;

export type PayloadKind = (typeof PAYLOAD_KINDS)[number];

/**
 * What `backup_policy.payload_kind` may hold: a concrete kind, or `auto`.
 *
 * `auto` is not a payload kind — no producer has it, and an artifact is never
 * recorded with it. It means "ask the registry which producer detects this service",
 * resolved at run time so a service that gains a container (or credentials) between
 * two runs gets the better payload without the policy being edited.
 */
export const PAYLOAD_KIND_AUTO = "auto";
export type PolicyPayloadKind = PayloadKind | typeof PAYLOAD_KIND_AUTO;

/** Image repositories that select a kind under `auto`. */
export interface PayloadImageMatch {
  /**
   * Exact repository names, matched as `^<name>(:|$)` — the repository, then a tag
   * separator or end of string. So `postgres` and `postgres:16-alpine` match;
   * `postgres-exporter:1` does not, and neither does `someorg/postgres:16`, which is
   * a different image that merely shares a word.
   */
  names: readonly string[];
  /**
   * Whole Docker Hub organisations, matched as `^<ns>/`. Only `redis/` has one, and
   * it is not a nicety: `redis/redis-stack` and `redis/redis-stack-server` are Redis
   * Inc's own images, and matching the exact repository alone would silently drop
   * them back to a crash-consistent volume snapshot.
   */
  namespaces?: readonly string[];
}

export interface BackupPayloadSpec {
  readonly kind: PayloadKind;
  /**
   * What the operator sees this called. A product name for a database
   * ("PostgreSQL"), a shape for the rest ("Volume snapshot"). Used in the dialog AND
   * in orchestrator error prose, so the two cannot name the same thing differently.
   */
  readonly label: string;
  /** The tool the operator will see named ("pg_dump", "tar", "your command"). */
  readonly method: string;
  /**
   * What the bytes ARE, which is what decides whether a crash-consistent copy is
   * acceptable:
   *   `database`   a logical export produced by the engine itself — consistent by
   *                construction, and always preferable to a tar of its live data dir.
   *   `filesystem` an archive of files, consistent only as far as the writer was
   *                quiet (or quiesced) while it was walked.
   *   `opaque`     whatever the operator's command emitted. We cannot reason about it.
   */
  readonly shape: "database" | "filesystem" | "opaque";
  /**
   * Images that select this kind under `auto`, or absent for a kind that is never
   * chosen by image (`volume` is the fallback; `path` and `custom_command` are
   * explicit-only).
   *
   * A match here is a NECESSARY condition for the producer, never a sufficient one:
   * the server also checks facts the browser cannot know — whether the service has a
   * container we can exec in, whether credentials are discoverable. So this answers
   * "which engine is this image", and the run record remains the authority on what
   * actually ran.
   */
  readonly images?: PayloadImageMatch;
  /**
   * True when the apply writes THROUGH a process inside the container
   * (`executor.pipeIntoCommand`) — `pg_restore`, `mysql`, `mongorestore`, a `cat`
   * into a file, the operator's own restore command. The docker executor cannot do
   * that without a live container, so the restore orchestrator must refuse early
   * rather than fail mid-apply.
   *
   * `volume` and `path` differ: a volume restore mounts the volume into a SEPARATE
   * helper container, so it works with the service's own container gone — which is
   * also what makes it the only kind that can restore into a service that has never
   * deployed.
   */
  readonly restoreNeedsLiveContainer: boolean;
  /**
   * True when the write only TAKES EFFECT after the service is power-cycled.
   *
   * Distinct from `restoreNeedsLiveContainer`, and conflating the two is what made
   * every Redis restore a silent no-op. `redis_rdb` needs the container alive to
   * receive the bytes, so it is not stopped by the orchestrator and no restart site
   * fires — but Redis reads `dump.rdb` only at STARTUP, so the running server never
   * looked at the file: success reported, dataset unchanged, and the next ordinary
   * restart snapshotted over the artifact.
   *
   * The logical dumps genuinely do not belong here — `pg_restore` / `mysql` /
   * `mongorestore` apply through the live server — so this is one kind, not a
   * category. It stays a per-kind FACT rather than an inference from the other flag.
   */
  readonly restoreAppliesAfterBounce: boolean;
  /**
   * Ceiling on the apply step, in ms. Centralized because it was four copies of
   * `60 * 60 * 1000` in four producers, which is a number nobody could change in one
   * place. A restore that legitimately takes longer than this is a real shape (a
   * 110 GB dump, #633), so these are ceilings on a WEDGED apply, not budgets.
   */
  readonly restoreTimeoutMs: number;
  /**
   * Does a restore of this kind REPLACE its target, or write over what is already
   * there?
   *
   * `volume` replaces: a named volume is a single-purpose store, and a merge leaves
   * files the artifact never held — a hybrid of two points in time that nothing
   * downstream can tell apart from a clean restore.
   *
   * `path` does NOT: a folder can hold things the service put there for other
   * reasons, and the same artifact may legitimately be restored into a directory that
   * is also in use. The operator opts in per policy with `clearPath`.
   *
   * For the logical dumps and `custom_command` this flag is INERT and false, because
   * their restore never reads it — replacement semantics belong to the loader
   * (`pg_restore --clean`, `mongorestore --drop`, the operator's own inverse command),
   * which is where an engine's transactional guarantees live. False rather than true
   * so that nothing clears unless this table says it does.
   *
   * It exists because the orchestrator used to pass `clearTarget: true` for every kind
   * unconditionally. With only volumes and dumps that read as "the volume default,
   * spelled at the call site"; the moment a kind whose default is the opposite existed,
   * it became a folder restore that wiped a shared directory the operator never asked
   * to empty — and, for a path that `validateClearPath` refuses outright, a capture
   * that could never be restored at all.
   */
  readonly restoreClearsTargetByDefault: boolean;
  /**
   * True when a FAILED restore of this kind leaves its target exactly as it was.
   *
   * Only `pg_dump`, and only because `pg_restore` runs under `--single-transaction`:
   * the DROPs and the reload are one transaction, so an error anywhere aborts the whole
   * thing and the database is bit-for-bit unchanged.
   *
   * Every other kind can leave a target half-written, for reasons that belong to the
   * engine or to the shape rather than to a flag we are not passing: `mysql` replaying
   * a dump commits each DDL statement as it goes (MySQL has no transactional DDL),
   * `mongorestore --drop` drops and reloads per collection, `volume` and `path` clear
   * and then extract, `redis_rdb` truncates the snapshot file it is writing, and
   * `custom_command` is whatever the operator's own command does.
   *
   * The restore orchestrator reads this to decide whether a failed apply may restart
   * the service, and whether the row is stamped `partialWrite`. It used to INFER that
   * from "did we get as far as calling producer.restore", which is the safe answer for
   * six kinds and a false alarm for the seventh: an aborted Postgres restore showed the
   * operator a "the target holds partial data and the service was deliberately left
   * stopped" banner about a database that had not changed and a service that was never
   * stopped. Under-reporting partial data is the dangerous direction, so this is the
   * one fact that is allowed to SUPPRESS that warning, and a kind may claim `true` only
   * where the all-or-nothing behaviour is a guarantee the engine makes.
   *
   * `false` is therefore the safe answer, and the answer an unrecognised kind resolves
   * to one layer up.
   */
  readonly restoreFailureLeavesTargetIntact: boolean;
  /**
   * True when a capture is permanently unrestorable unless the policy carried a
   * restore command at capture time.
   *
   * Only `custom_command`: its restore is the operator's own inverse command, frozen
   * into the artifact's metadata when it is captured because nothing downstream can
   * reconstruct it. A policy saved without one produces artifacts that look
   * successful and can never be put back, which is why the policy service refuses
   * the save rather than discovering it at restore time.
   */
  readonly requiresRestoreCommand: boolean;
  /**
   * True when an operator may pick this kind EXPLICITLY on a policy.
   *
   * All of them can be, and that matters for the adopted-service case: an image
   * named `acme/pg-custom:1` is a PostgreSQL that `auto` cannot recognise, and
   * forcing `pg_dump` is the difference between a logical dump and a crash-consistent
   * tar of a live data directory. The flag exists so a future internal-only kind
   * (a pre-restore safety capture, say) can be excluded from the picker without the
   * dialog hard-coding a list.
   */
  readonly operatorSelectable: boolean;
  /**
   * Which `payloadConfig` keys this kind reads. The dialog renders controls from
   * this, and `assertPayloadConfig` validates against it, so a key that no producer
   * consumes cannot be presented as if it did anything.
   */
  readonly configKeys: readonly PayloadConfigKey[];
}

/**
 * Every `payloadConfig` key any producer reads, as one vocabulary.
 *
 * `payloadConfig` is free-form jsonb forwarded WHOLE to the producer (hand-picking
 * keys is what dropped every `custom_command` key and made each mail backup
 * unrestorable), so the schema cannot enforce this — but the policy service and the
 * dialog can agree on it, which is what keeps a typo like `produceCmd` from being
 * saved as a valid-looking policy that then backs up nothing.
 */
export const PAYLOAD_CONFIG_KEYS = [
  "sourceIds",
  "exclude",
  "quiesce",
  "compression",
  "paths",
  "clearPath",
  "produceCommand",
  "command",
  "restoreCommand",
  "artifactName",
] as const;
export type PayloadConfigKey = (typeof PAYLOAD_CONFIG_KEYS)[number];

/**
 * Keys that are valid on ANY kind, because they configure something other than the
 * capture itself.
 *
 * Kept apart from the per-kind `configKeys` so the dialog still renders one kind's
 * options without also offering a restore-time switch as if it were a capture option.
 * They are in the vocabulary all the same — a policy carrying one is correct, and
 * validation must not reject it.
 *
 *  `verifyOnPrepare`  restore-time: whether artifact digests are re-checked while
 *                     preparing. Read by the restore orchestrator, not by a producer.
 *  `mail`             what a mail-server policy included (message data, keys). Written
 *                     by the mail backup plan and read back by the mail admin tab to
 *                     show what the policy covers; the shell never sees it.
 *
 * This pair is also the clearest evidence for why the vocabulary needed writing down:
 * neither was documented anywhere, and a validator built from the keys the producers
 * read would have refused every mail policy and every restore that turns verification
 * off.
 */
export const UNIVERSAL_PAYLOAD_CONFIG_KEYS = ["verifyOnPrepare", "mail"] as const;
export type UniversalPayloadConfigKey = (typeof UNIVERSAL_PAYLOAD_CONFIG_KEYS)[number];

/**
 * The compression codecs a `payloadConfig.compression` may name.
 *
 * The same three values were written out inline in six places — `DumpCodec` in the
 * shell layer, three fields on the adapters' option types, and a cast in the volume
 * producer — and NONE of them was checked against the jsonb the operator's policy
 * actually carries.
 *
 * That gap was not cosmetic. A policy saved with `compression: "brotli"` (a typo, a
 * hand-written API call, a copied example) captured happily: the compressor lookup
 * fell through to "apply nothing", so the artifact was written UNCOMPRESSED, while the
 * value was recorded verbatim in its metadata. The restore then read that metadata
 * through `recordedCodec`, which maps anything unrecognised to `zstd` — deliberately,
 * because every artifact written before it existed was zstd — and piped a plain tar
 * through `zstd -d`. Capture green, artifact real, restore impossible. Forever, and
 * only discoverable by attempting it.
 *
 * So the vocabulary lives here, once, and `validatePolicyPayload` refuses a value
 * outside it at save time.
 */
export const PAYLOAD_COMPRESSION_CODECS = ["zstd", "gzip", "none"] as const;
export type PayloadCompression = (typeof PAYLOAD_COMPRESSION_CODECS)[number];

/** Narrow an untrusted `payloadConfig.compression` to a codec the pipeline can build. */
export function isPayloadCompression(value: unknown): value is PayloadCompression {
  return (
    typeof value === "string" && (PAYLOAD_COMPRESSION_CODECS as readonly string[]).includes(value)
  );
}

/** Every key a policy's `payloadConfig` may legitimately carry. */
export const ALL_PAYLOAD_CONFIG_KEYS: readonly string[] = [
  ...PAYLOAD_CONFIG_KEYS,
  ...UNIVERSAL_PAYLOAD_CONFIG_KEYS,
];

/** One hour. The apply ceiling every logical restore shared as a literal. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * The catalog.
 *
 * A `Record<PayloadKind, …>`, deliberately: adding a kind to `PAYLOAD_KINDS` is a
 * compile error here until every fact about it is stated, which is the property the
 * `Set`s in the API layer never had.
 */
export const BACKUP_PAYLOADS: Record<PayloadKind, BackupPayloadSpec> = {
  pg_dump: {
    kind: "pg_dump",
    label: "PostgreSQL",
    method: "pg_dump",
    shape: "database",
    images: { names: ["postgres", "postgis/postgis"] },
    restoreNeedsLiveContainer: true,
    restoreAppliesAfterBounce: false,
    restoreTimeoutMs: HOUR_MS,
    // Inert: `pg_restore --clean --if-exists` owns replacement.
    restoreClearsTargetByDefault: false,
    // The only kind that can claim this, and only since `producers/pg-dump.ts` restores
    // under `--single-transaction`. Before that flag, a DROP blocked by a dependent view
    // was skipped and the archive's rows were loaded ON TOP of the live ones — one table
    // holding a merge of two points in time, reported as "errors ignored on restore".
    restoreFailureLeavesTargetIntact: true,
    requiresRestoreCommand: false,
    operatorSelectable: true,
    configKeys: [],
  },
  mysql_dump: {
    kind: "mysql_dump",
    label: "MySQL/MariaDB",
    method: "mysqldump",
    shape: "database",
    // `percona/percona-server` and `percona/percona-server-mongodb` are kept apart by
    // the `(:|$)` anchor: what follows `percona-server` in the MongoDB image is `-`,
    // which is neither a tag separator nor the end of the string.
    images: { names: ["mysql", "mariadb", "percona/percona-server"] },
    restoreNeedsLiveContainer: true,
    restoreAppliesAfterBounce: false,
    restoreTimeoutMs: HOUR_MS,
    restoreClearsTargetByDefault: false,
    // MySQL has no transactional DDL: replaying a dump commits each statement as it
    // goes, so a failure halfway leaves half the schema and part of the data.
    restoreFailureLeavesTargetIntact: false,
    requiresRestoreCommand: false,
    operatorSelectable: true,
    configKeys: [],
  },
  redis_rdb: {
    kind: "redis_rdb",
    label: "Redis",
    method: "RDB snapshot",
    shape: "database",
    images: { names: ["redis"], namespaces: ["redis"] },
    restoreNeedsLiveContainer: true,
    // The one kind whose write is inert until the service restarts. See the field doc.
    restoreAppliesAfterBounce: true,
    restoreTimeoutMs: 30 * 60 * 1000,
    restoreClearsTargetByDefault: false,
    // The write is a stream into `dump.rdb`. A failure halfway leaves a TRUNCATED
    // snapshot — which the running server has not read (see restoreAppliesAfterBounce)
    // but the next start will, and refuse.
    restoreFailureLeavesTargetIntact: false,
    requiresRestoreCommand: false,
    operatorSelectable: true,
    configKeys: [],
  },
  mongo_dump: {
    kind: "mongo_dump",
    label: "MongoDB",
    method: "mongodump",
    shape: "database",
    images: { names: ["mongo", "percona/percona-server-mongodb"] },
    restoreNeedsLiveContainer: true,
    restoreAppliesAfterBounce: false,
    restoreTimeoutMs: HOUR_MS,
    restoreClearsTargetByDefault: false,
    // `mongorestore --drop` drops and reloads per collection, so a failure between two
    // collections leaves one restored and the next dropped.
    restoreFailureLeavesTargetIntact: false,
    requiresRestoreCommand: false,
    operatorSelectable: true,
    configKeys: [],
  },
  custom_command: {
    kind: "custom_command",
    label: "Custom command",
    method: "your command",
    shape: "opaque",
    restoreNeedsLiveContainer: true,
    restoreAppliesAfterBounce: false,
    restoreTimeoutMs: HOUR_MS,
    // Inert: the operator's own inverse command decides what it replaces.
    restoreClearsTargetByDefault: false,
    // We cannot reason about someone else's command. `opaque` in, opaque out.
    restoreFailureLeavesTargetIntact: false,
    requiresRestoreCommand: true,
    operatorSelectable: true,
    configKeys: ["produceCommand", "command", "restoreCommand", "artifactName"],
  },
  path: {
    kind: "path",
    label: "Files and folders",
    method: "tar",
    shape: "filesystem",
    // Explicit-only: a path is something the operator names. Nothing about an image
    // says "back up /var/www", and guessing would either miss the data or archive an
    // OS.
    restoreNeedsLiveContainer: true,
    restoreAppliesAfterBounce: false,
    // Matches the docker helper's own absolute ceiling for the volume directions, so
    // one number covers all three: a tree big enough to need hours to capture needs
    // hours to restore.
    restoreTimeoutMs: 6 * HOUR_MS,
    // Merge, unless the policy sets `clearPath`. A folder is not necessarily this
    // artifact's alone.
    restoreClearsTargetByDefault: false,
    // `tar -x` writes file by file: a failure halfway leaves the tree part-updated,
    // and with `clearPath` set it leaves it part-updated on top of an emptied folder.
    restoreFailureLeavesTargetIntact: false,
    requiresRestoreCommand: false,
    operatorSelectable: true,
    configKeys: ["paths", "exclude", "compression", "clearPath"],
  },
  volume: {
    kind: "volume",
    label: "Volume snapshot",
    method: "tar",
    shape: "filesystem",
    // No `images`: this is the fallback the registry uses when nothing else detects,
    // not a match on anything.
    //
    // A volume restore extracts through a SEPARATE helper container mounted on the
    // volume, so it is the only kind that can restore into a service whose container
    // is gone — or that never deployed.
    restoreNeedsLiveContainer: false,
    restoreAppliesAfterBounce: false,
    restoreTimeoutMs: 6 * HOUR_MS,
    // Replace: a volume is a single-purpose store, so a merge would leave files this
    // artifact never held.
    restoreClearsTargetByDefault: true,
    // Clear-then-extract, and the clear happens in the helper's PRELUDE — so by the
    // time any error escapes, the volume is already empty. This is the case the
    // orchestrator's old inference was built around, and it is still exactly right.
    restoreFailureLeavesTargetIntact: false,
    requiresRestoreCommand: false,
    operatorSelectable: true,
    configKeys: ["sourceIds", "exclude", "quiesce", "compression"],
  },
};

/** True when `value` is a payload kind this build knows. */
export function isPayloadKind(value: unknown): value is PayloadKind {
  return typeof value === "string" && (PAYLOAD_KINDS as readonly string[]).includes(value);
}

/** True when `value` is storable in `backup_policy.payload_kind` — a kind, or `auto`. */
export function isPolicyPayloadKind(value: unknown): value is PolicyPayloadKind {
  return value === PAYLOAD_KIND_AUTO || isPayloadKind(value);
}

/**
 * The spec for a kind.
 *
 * Throws on an unknown kind rather than returning a default, and the message names
 * what IS known: a policy row holding a kind this build has no producer for is a
 * real state (a downgrade, a hand-edited row), and silently treating it as `volume`
 * would back up the wrong thing while reporting success.
 */
export function payloadSpec(kind: PayloadKind): BackupPayloadSpec {
  const spec = BACKUP_PAYLOADS[kind];
  if (!spec) {
    throw new Error(
      `Unknown backup payload kind "${kind}". Known kinds: ${PAYLOAD_KINDS.join(", ")}.`,
    );
  }
  return spec;
}

/** Specs in auto-detect priority order — the order producers must register in. */
export function payloadSpecs(): BackupPayloadSpec[] {
  return PAYLOAD_KINDS.map((k) => BACKUP_PAYLOADS[k]);
}

/** The kinds an operator may choose explicitly, in the order the dialog lists them. */
export function operatorSelectableKinds(): BackupPayloadSpec[] {
  return payloadSpecs().filter((s) => s.operatorSelectable);
}

/** The kinds `auto` can select by image, with their matchers. */
export function imageDetectableSpecs(): Array<BackupPayloadSpec & { images: PayloadImageMatch }> {
  return payloadSpecs().filter(
    (s): s is BackupPayloadSpec & { images: PayloadImageMatch } => !!s.images,
  );
}

/** Whether a restore of `kind` writes through a process in a live container. */
export function restoreNeedsLiveContainer(kind: PayloadKind): boolean {
  return payloadSpec(kind).restoreNeedsLiveContainer;
}

/** Whether a restore of `kind` only takes effect once the service is power-cycled. */
export function restoreAppliesAfterBounce(kind: PayloadKind): boolean {
  return payloadSpec(kind).restoreAppliesAfterBounce;
}

/**
 * Whether a FAILED restore of `kind` leaves its target unchanged.
 *
 * Read by the restore orchestrator to decide two things it used to infer from control
 * flow alone: may a failed apply restart the service, and does the row warn the operator
 * about partial data. See the field doc for why only one kind answers `true`.
 */
export function restoreFailureLeavesTargetIntact(kind: PayloadKind): boolean {
  return payloadSpec(kind).restoreFailureLeavesTargetIntact;
}

/**
 * Whether a restore of `kind` should EMPTY its target first, given the policy's
 * `payloadConfig`.
 *
 * One function, because the answer has two inputs that used to live in different
 * layers: the kind's own default (this table) and the operator's per-policy override
 * (`clearPath`). The orchestrator asks here rather than deciding, which is what keeps
 * "does this destroy data" from being a boolean literal at a call site.
 *
 * A missing or unreadable config falls back to the kind's default — never to `true`.
 * A historical run can outlive its policy (the FK is `set null`), and "we could not
 * find out what you wanted" must not resolve to the destructive answer.
 *
 * The override is only honored for kinds that declare `clearPath`; setting it on a
 * volume policy does not turn clearing off, because the volume path has no merge
 * semantics to fall back to.
 */
export function restoreClearsTarget(
  kind: PayloadKind,
  config?: Record<string, unknown> | null,
): boolean {
  const spec = payloadSpec(kind);
  if (spec.configKeys.includes("clearPath")) {
    const requested = config?.clearPath;
    if (typeof requested === "boolean") return requested;
  }
  return spec.restoreClearsTargetByDefault;
}

/** Whether a policy of `kind` must carry a restore command to be restorable at all. */
export function requiresRestoreCommand(kind: PolicyPayloadKind): boolean {
  return kind !== PAYLOAD_KIND_AUTO && payloadSpec(kind).requiresRestoreCommand;
}

// ─── Policy validation ───────────────────────────────────────────────────────

/**
 * Absolute paths whose CONTENTS may never be cleared by a restore.
 *
 * Note what this is not: it is not a list of directories you may not back UP.
 * Archiving `/etc/nginx` is a perfectly ordinary thing to want. The danger is the
 * other direction — a restore that empties a directory before extracting into it —
 * and the rule that governs it is below in `validateClearPath`.
 */
const SYSTEM_ROOTS: readonly string[] = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
];

/**
 * Reduce a path to one canonical spelling: no duplicate separators, no trailing
 * separator (except root itself).
 *
 * Canonicalization is not cosmetic here — it is what makes the checks below
 * decidable. `/data//sub/` and `/data/sub` must not be able to give different answers
 * to "is this the same directory", or a denylist becomes a formality that any extra
 * slash walks past.
 */
export function normalizeBackupPath(input: string): string {
  const collapsed = input.trim().replace(/\/{2,}/g, "/");
  if (collapsed === "/") return "/";
  return collapsed.replace(/\/+$/, "");
}

/**
 * Reject a path that cannot be safely archived, or null when it is fine.
 *
 * Absolute only, and no `..` segment. Both are the same rule from two directions: the
 * path is interpolated into a shell `tar -C` and later into an extract, so a relative
 * path means "wherever that process happened to start" and a traversal segment means
 * the operator's stated target is not the one that gets touched.
 */
export function validateBackupPath(input: string): string | null {
  const path = normalizeBackupPath(input);
  if (path === "") return "A backup path cannot be empty.";
  if (!path.startsWith("/")) {
    return `Backup path "${input}" must be absolute — it is resolved inside the service, where there is no meaningful working directory.`;
  }
  if (path.includes("\0")) return `Backup path "${input}" contains a NUL byte.`;
  if (path.split("/").includes("..")) {
    return `Backup path "${input}" contains "..". Name the directory you mean directly; a traversal segment would archive somewhere other than what is shown here.`;
  }
  if (path === "/") {
    return "Refusing to archive `/` — that is the whole filesystem, including /proc and /sys. Name the data directory instead.";
  }
  return null;
}

/**
 * Reject a path whose contents must not be emptied before a restore extracts into it,
 * or null when clearing it is allowed.
 *
 * Two conditions, and both exist because of the same class of incident: a success path
 * that ran `rm -rf` on a directory it had mis-derived, and destroyed a live site.
 *
 *  - Depth ≥ 2. `/data` is plausibly a mount point whose parent is the container root;
 *    `/data/app` is something the operator chose. Requiring a second segment costs a
 *    real user nothing and removes the whole class of "cleared a top-level directory".
 *  - Not inside a system root. Emptying `/etc` or `/usr` does not lose data, it
 *    destroys the container — and the operator asking for it almost certainly meant a
 *    subdirectory of their own.
 *
 * A path that fails this is still BACKED UP normally; only the pre-extract clear is
 * refused, so the restore merges instead. That is the conservative direction: extra
 * files left behind are recoverable, a wiped tree is not.
 */
export function validateClearPath(input: string): string | null {
  const path = normalizeBackupPath(input);
  const invalid = validateBackupPath(path);
  if (invalid) return invalid;
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) {
    return `Refusing to clear "${path}" before restoring: it is a top-level directory. Name a subdirectory, or leave clearing off so the restore extracts over the existing files.`;
  }
  const top = `/${segments[0]}`;
  if (SYSTEM_ROOTS.includes(top)) {
    return `Refusing to clear "${path}" before restoring: it is inside ${top}, which holds the operating system rather than your data. Leave clearing off, or restore into a path you own.`;
  }
  return null;
}

/**
 * Everything wrong with a policy's payload, or null when it is saveable.
 *
 * Returns a message rather than throwing so the CLI, the API and the dashboard can
 * each present it in their own shape — and so it is a pure function that a test can
 * enumerate. The API turns it into a refused write; the dashboard shows it inline.
 *
 * Why a policy is refused rather than repaired: every failure here produces runs that
 * report `succeeded`, hold real bytes at the destination, list as restore points
 * forever, and refuse at the one moment somebody needs them. A save that fails loudly
 * is strictly better than a backup that fails silently.
 */
export function validatePolicyPayload(
  kind: unknown,
  config: Record<string, unknown> | null | undefined,
): string | null {
  // An unrecognised kind used to save fine and fail at run time, once, in the
  // orchestrator — after the schedule had been advertised to the operator as active.
  if (kind !== undefined && kind !== null && !isPolicyPayloadKind(kind)) {
    return `Unknown backup payload kind "${String(kind)}". Use one of: ${PAYLOAD_KIND_AUTO}, ${PAYLOAD_KINDS.join(", ")}.`;
  }
  const resolved: PolicyPayloadKind = isPolicyPayloadKind(kind) ? kind : PAYLOAD_KIND_AUTO;
  const cfg = config ?? {};

  // A key no producer reads is a typo, and a typo here is a policy that looks
  // configured and captures nothing. Cross-kind keys are deliberately NOT refused: a
  // policy switched from `volume` to `pg_dump` keeps its old `exclude` harmlessly, and
  // refusing the patch would block the operator from fixing the kind.
  for (const key of Object.keys(cfg)) {
    if (!ALL_PAYLOAD_CONFIG_KEYS.includes(key)) {
      return `Unknown backup payload option "${key}". Known options: ${ALL_PAYLOAD_CONFIG_KEYS.join(", ")}.`;
    }
  }

  const nonEmptyString = (key: string) => {
    const value = cfg[key];
    return typeof value === "string" && value.trim() !== "";
  };

  if (resolved === "custom_command") {
    // `command` is the dashboard's legacy name for the produce half; the producer
    // still reads it, so a policy that only has it is captureable and must stay
    // saveable.
    if (!nonEmptyString("produceCommand") && !nonEmptyString("command")) {
      return "A custom-command backup policy needs `payloadConfig.produceCommand` — the command whose stdout becomes the artifact.";
    }
  }

  // The restore half is the only record of how to put such an artifact back: the
  // producer reads it off the recorded run and executes it, and nothing downstream can
  // reconstruct it.
  if (
    resolved !== PAYLOAD_KIND_AUTO &&
    requiresRestoreCommand(resolved) &&
    !nonEmptyString("restoreCommand")
  ) {
    return `A ${payloadSpec(resolved).label.toLowerCase()} backup policy needs \`payloadConfig.restoreCommand\` — the command that receives the artifact on stdin. Without it the runs it captures can never be restored, so the policy is refused rather than saved.`;
  }

  // Checked for EVERY kind, not only the two that declare it: cross-kind keys are
  // deliberately kept on a policy that switches kinds, so a bad value parked on a
  // `pg_dump` policy would come back the moment it was switched to `path`.
  if (cfg.compression !== undefined && !isPayloadCompression(cfg.compression)) {
    return `Unknown backup compression "${String(cfg.compression)}". Use one of: ${PAYLOAD_COMPRESSION_CODECS.join(", ")}. An unrecognised codec captures an UNCOMPRESSED artifact and then records a name the restore cannot read, so the run succeeds and can never be restored.`;
  }

  if (resolved === "path") {
    const paths = cfg.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return "A files-and-folders backup policy needs `payloadConfig.paths` — one or more absolute paths inside the service to archive.";
    }
    const seen = new Set<string>();
    for (const entry of paths) {
      if (typeof entry !== "string") {
        return "Every entry in `payloadConfig.paths` must be a string.";
      }
      const bad = validateBackupPath(entry);
      if (bad) return bad;
      const normalized = normalizeBackupPath(entry);
      // Two spellings of one directory would archive it twice under two artifact
      // names, and restore it twice in an order nobody chose.
      if (seen.has(normalized)) {
        return `Backup path "${normalized}" is listed more than once.`;
      }
      seen.add(normalized);
    }
    if (cfg.clearPath === true) {
      for (const entry of paths as string[]) {
        const bad = validateClearPath(entry);
        if (bad) return bad;
      }
    }
  }

  return null;
}
