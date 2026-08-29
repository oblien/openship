# Backups + restore — open work

Only what is NOT done. Anything fixed in the tree is gone from this file; the
reasoning for a shipped fix lives in the code it landed in, and in git history.
The rollback half has its own file: `../deployments/rollback/PENDING.md`.

Every item was re-verified against the working tree on 2026-08-20, after the
critical-defect pass. Line numbers are from that check.

---

## Capture

### The image is not captured

`serviceImage` in the manifest is a tag STRING (`common/manifest.ts:20`, `:33`;
`types.ts:548`), read off the service row (`backup.orchestrator.ts:370`, `:496-501`).
Nothing calls `docker save`, and `PayloadKind` has no entry for it
(`types.ts:274-280`). A locally built image that was never pushed is therefore
unrestorable even with perfect volumes.

The native primitive already exists outside this module — `runtime/docker.ts:3540-3554`
and `runtime/image-transfer.ts`, used by `migration/direct-transfer.ts:366` — so this
is a producer wrapping `docker save` / `docker load`, not new plumbing. Needs an
`image` payload kind, the producer, registration in `backup/index.ts`, restore
wiring, and 9 locale strings. The dialog no longer needs touching to OFFER it —
`PolicyEditor.tsx` derives its cards from `operatorSelectableKinds()`, so a new kind
appears with its catalog label and its own `configKeys` as controls; the locale keys
are what turn that into translated copy.

### Capture cannot be cancelled

There is no `POST /backup-runs/:runId/cancel`. `backup.routes.ts:30-51` is the whole
route table and line 49 is the only cancel, for restores. `createAbortWatch`
(`executors/docker.ts:124`) has exactly ONE call site — inside `receiveStream`, the
restore extract.

Capture has no signal to join: `StreamPathOpts` and `ProducerOpts`
(`types.ts:337-374`) carry no `signal`; the only `AbortSignal` fields in the module
are restore-side. `backup_run` has no cancel columns at all (`schema/backup.ts:216-295`;
the trio is on `backupRestore` at `:358-360`). The only thing that "cancels" a run
today is a DB-only status flip in `project-teardown.ts:542-552`, whose own comment
says there is no worker-side abort signal. (The RESTORE half of that loop now goes
through `restoreOrchestrator.cancel`, which does have one — capture is what is left.)

Needs: cancel columns on `backup_run`, the route + controller + an orchestrator
`cancel()`, a `signal` on `StreamPathOpts`/`ProducerOpts` threaded into `streamPath`
so capture joins `createAbortWatch`, and a UI entry point.

### No upload progress, and `uploading` stays out of the idle sweep

The idle predicate is `preparing | snapshotting | verifying`
(`packages/db/src/repos/backup.repo.ts`); `uploading` is reachable only through the 6h
absolute ceiling. Deliberate, because nothing heartbeats mid-stream:
`HashingPassthrough` (`common/sha256-stream.ts:16-47`) has no progress callback and
its byte count is readable only via `summary()`, which throws before the stream ends;
`PutOpts` (`types.ts:450-464`) has no `onProgress`, so a destination cannot report
upward (S3 tracks `httpUploadProgress` into a local counter only); and the
orchestrator writes `bytesTransferred` only at artifact boundaries.

One change buys both halves: a throttled progress signal that writes
`bytesTransferred` and bumps `lastEventAt` mid-upload, which lets `uploading` back
into the idle branch and gives the UI real progress at the same time.

### A single artifact past ~281 GiB still cannot complete on S3

`partSizeFor(undefined)` returns the 32 MiB unknown-size part size
(`destinations/s3.ts`), and against the 9,000-part budget that is a ~281 GiB ceiling
for any stream whose size we do not know — which is every database dump. It is now
ENFORCED EARLY (`partLimitCeiling` + the abort in `put`) with a message naming the
limit, instead of failing at `CompleteMultipartUpload` after transferring every byte,
and the reach was doubled from ~140 GiB at unchanged in-flight memory.

Going further trades resident memory for reach, which this module refuses — an
unbounded byte plane is what OOM'd the API in #633. Raising it properly means getting
a size estimate for dumps (S3 needs a uniform part size, so it cannot be renegotiated
mid-upload) or splitting a capture across multiple objects, which changes the artifact
shape and wants a decision before code.

---

## Restore

### Atomic restore — into a new volume, then swap

Scoped down to the FILESYSTEM kinds. `clearTarget` destroys in place on every
executor: `executors/docker.ts` (a prelude in the SAME helper that then extracts into
the bind-mounted volume), `executors/bare.ts` (`rm -rf` then `tar -x`), and
`executors/cloud.ts`, which forwards it to Oblien's `transfer.upload` against the live
destination. Whether it is asked for at all is now the policy's decision per artifact
(`shouldClearTarget`), so a `path` restore merges by default and only a `volume`
replaces — but when it IS asked for, the delete still precedes the extract.

The wipe-and-lie window is closed on BOTH executors — each proves its decompressor
exists before clearing anything (exit 90, "your data is untouched") — and a failed
extract no longer restarts the service on the emptied volume. But that is not
atomicity: a mid-extract failure leaves partial data. The module is honest about it
(`PartialWriteError`, `partialWrite`, `serviceLeftStopped`).

Real atomicity for those kinds means restoring into a fresh volume and swapping it into
the service, which touches the deploy path — a feature, deliberately not smuggled in
here.

**Postgres is no longer part of this item.** An earlier draft of this file claimed
`pg_restore --clean` was already transactional; the flags said otherwise, and the
measured behaviour was worse than "not atomic". With `--clean --if-exists --no-owner`
alone, a `DROP TABLE` blocked by a dependent view was skipped and the archive's rows
were loaded ON TOP of the live ones — one table holding a merge of two points in time,
reported as `errors ignored on restore: 3`. `producers/pg-dump.ts` now restores under
`--single-transaction --no-acl`, so that same failure aborts with the database bit-for-bit
unchanged. See the comment there for why this cannot regress a restore that used to
work, and why `--no-acl` is required rather than incidental.

What remains, per engine, is engine-limited rather than a flag we are not passing:
`mysql` replaying a dump commits each DDL statement as it goes (MySQL has no
transactional DDL), and `mongorestore --drop` drops and reloads per collection. Neither
can be made all-or-nothing from the client side; both would need the restore-into-a-copy
shape above.

### Pre-restore safety capture

Nothing implemented; the restore FSM has no such phase, and `backup_restore` carries
no safety-run column (`schema/backup.ts:300-365`).

The natural shape reuses the capture path, which means it needs the source run's
policy — and the design blocker is still live: the destination FK is
`onDelete: "set null"` (`schema/backup.ts:56-60`) and policies are soft-deletable
(`:183`), so a historical run can outlive the policy that would be reused. Design
questions first: does a restore block on a fresh backup, what happens when the
destination is full, what happens when the policy is gone.

### No post-restore start probe

`startupTimeoutMs` appears exactly once in the repo and it is prose — the doc comment
above `RestoreOpts` (`types.ts:330`), whose interface declares only `clearTarget` and
`signal`. Honoring it means building the probe; `OpenshipReadiness` is its home.

## Detection

### mysql detection still requires credentials in env

`producers/mysql-dump.ts` gates on `MYSQL_ROOT_PASSWORD ?? MYSQL_PASSWORD`.
Deliberate, and the last of its kind: there is no credential-free local path the way
postgres has the container's unix socket (`trust` in the official image), and relaxing
it would turn a working volume snapshot into a failing dump. With container env now
layered in, an adopted MariaDB reaches its password anyway.

*(mongo and redis no longer differ from postgres — all four now require a container
they can actually exec in, via `common/exec-target.ts`.)*

---

## Data plane / integrity

### A same-host source and destination could skip the API entirely

The one narrow case the architecture review left open. When a source host and an
`sftp` / `openship_server` destination resolve to the SAME server, the dump could run
there writing to that host's own filesystem — no credential travels, because the host
writes to its own disk — recorded with a new `integrity: "host-reported"` value
alongside the existing `sha256` / `size-only` / `deferred` vocabulary.

Nothing exists. `host-reported` appears nowhere in code; the vocabulary is one ternary
in `restore.orchestrator.ts`. `openship_server` resolves to the plain SFTP
implementation with no locality check, and no source-vs-destination server comparison
exists anywhere in the module. The `resolvePlan` worth imitating
(`volume-transfer.ts`) keys off executor reference identity, not destination rows.

One cell, opt-in, not a refactor. Explicitly **not** the general "move the byte plane
out of the API" proposal — that was reviewed and rejected: `presignPut` signs S3's
single 5 GB PUT and cannot carry a 110 GB dump, it reaches one destination kind of
four (`local` is impossible, `sftp`/`openship_server` would ship a root-equivalent
private key to every source box), and a host-computed digest loses INDEPENDENCE, since
a truncating upload downstream of a tee is invisible to a digest computed upstream.

---

## Deferred, with the reason

### `docker-edge-executor.ts` is the last `modem.demuxStream` consumer

`packages/adapters/src/system/docker-edge-executor.ts:144`. The blocker is still
literally true: `outStream`/`errStream` are bare PassThroughs with only `data`
listeners and `run()`'s only error listener is on the SOURCE stream, while the
replacement's failure path destroys `stdout` with the cause and takes `onError` as an
optional 4th parameter that nothing here would supply. Converting today would destroy
`outStream` with an Error no one listens for, on a path that runs during every deploy.

It has no backpressure problem of its own — the output is a few lines of
`openresty -t` fully consumed into strings. Give that path an error channel first, then
convert.

### Mail policies with both retention columns NULL are never pruned

`prunePolicy` reads both-NULL as "the operator asked for unlimited" and skips, with no
`DEFAULT_RETAIN_COUNT` fallback (`retention-prune.ts:82-88`) — correct for project
policies, because migration 0096 backfilled them and made that reading unambiguous.
0096 is still the only retention backfill (the journal now ends at 0108), and there is
no boot repair.

The affected set is narrower than an earlier draft of this file claimed: 0096's
`UPDATE` was table-wide and `mail_server_id` has been on `backup_policy` since
`0026_mail_backup_source.sql`, so pre-0096 mail rows WERE caught. What remains is mail
policies written through the mail endpoint AFTER 0096 but BEFORE the null-on-omission
fix, because that endpoint passed `retainCount` explicitly and so bypassed the column
default.

Not backfilled on purpose: unlike 0096 this would start deleting backups on rows an
operator may have left alone deliberately, so it wants an explicit call rather than a
migration.
