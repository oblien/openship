# Backups + restore — what's guaranteed, and what isn't

State as of 2026-08-05, written alongside the pass that closed
[#434](https://github.com/oblien/openship/issues/434). It lives next to the
orchestrators so the limits are visible before anyone builds on them. The rollback
half has its own file: `../deployments/rollback/PENDING.md`.

---

## What a restore now guarantees

**It cannot hang.** `receiveStream` (`packages/adapters/src/backup/executors/docker.ts`)
used to `await helper.wait()` with no bound — a long-poll against a container the
daemon had already reaped under `AutoRemove: true`, which is the `404 no such
container` in #434. It now races four outcomes: the wait, an **exit-via-inspect
poll** (the same "don't trust the attach stream" backstop `demuxContainerStream`
already had), an **inactivity watchdog** (`idleTimeoutMs`, default 10 min, fed by
bytes in both directions), and an **absolute ceiling** (`timeoutMs`, default 6h).
Idle rather than wall-clock on purpose: a legitimate 50 GB extract has continuous
traffic and the hang has none, so the idle timer separates them where a wall-clock
bound would either strangle the first or miss the second. The helper is reaped in
`finally` with `AutoRemove: false`, which also closes a leak that predated the
issue — a throw between `createContainer` and `start()` used to leave the helper
behind forever.

**It fails in prepare, not halfway through.** Target resolution, source probing and
integrity verification all happen in `prepare` — the only phase that runs before
anything is stopped or written. A service whose container is deployment-managed
resolves through `dep.containerId`; one with no container but recorded volumes
restores fine (the volume is bind-mounted into a separate helper, so nothing needs
stopping); only "no container **and** no recorded volumes" fails, naming both facts.
`isRunning()` now gates the stop, and we start only what we stopped.

**Integrity is real.** Prepare streams every artifact through `HashingPassthrough`
and compares against the recorded sha256, normalizing `sha256:` prefixes and case.
The comment used to claim this while the code compared byte sizes only. `meta.integrity`
records which check actually ran — `sha256`, `size-only` (no digest on record: older
runs), or `deferred` — and `validateManifest` is wired against the destination's
`manifest.json`, so "the DB's artifact list disagrees with what the destination
holds" is a hard failure instead of a surprise mid-apply. The apply download is
wrapped in the same hasher for free, catching bit-rot between the two phases.

**Cancel is honest, and says which kind it was.** `cancel()` never throws and never
lies: it sets `cancel_requested`, fires the in-process `AbortController`, and
publishes SSE. Two outcomes, deliberately worded differently — before the first
destructive write, `cancelled` with `meta.destructive: false` and the service
restarted if we stopped it; after a `receiveStream` began, `cancelled` with
`meta.partialWrite` and a fixed sentence saying that volume holds partial data. The
service is then **left stopped on purpose**: we never start a service on a
half-written volume. A second cancel on a row whose `cancel_requested_at` is older
than ~2 min force-terminals it with `meta.forced` and *identical* partial-data
wording, which is also what unblocks project deletion on a wedged row.

**Capture is bounded exactly like restore.** The #434 fix initially landed on the
restore half only, which left `streamPath` on a flat 1h wall clock — so a volume whose
*restore* was allowed six hours could not be *backed up* at all, and a wedged `tar -c`
still burned the full hour before anyone heard. Both directions now go through one
`awaitHelperExit` and one pair of defaults (`DEFAULT_HELPER_IDLE_MS` 10 min,
`DEFAULT_HELPER_TIMEOUT_MS` 6h); `StreamPathOpts` declares `idleTimeoutMs` and
`timeoutMs` instead of the old `as ExecuteCommandOpts` cast, which was reading an
option nothing declared — the same shape as the D5 bug in this pass. `bare.ts`
forwards `timeoutMs` and has no idle equivalent on purpose: its channel closes when
the SSH connection dies, which is the bound the docker helper had to build itself.

**One reap, not four.** `withHelper` (create → run → always remove) and
`handOffHelper` (remove only if the hand-off throws, for helpers whose output
outlives the call, i.e. `streamPath` → `demuxContainerStream`) replace four
hand-copied create/`finally`-remove scaffolds. `AutoRemove` is off deliberately — it
races `/wait` and never fires for a container that failed before starting — so every
helper must be reaped by us, and four independent copies of that reap is exactly how
one of them came to be the one that didn't.

---

## Deliberate omissions — decided, not forgotten

- **`startupTimeoutMs` is gone** from `RestoreOpts`, not implemented. It was
  dropped by `producers/volume.ts` and read by no executor; honoring it means
  building a post-restore start probe, which is a feature. `OpenshipReadiness` is
  its home when it lands.
- **`verifyOnPrepare` is policy-level, not per-request.** `payloadConfig.verifyOnPrepare`
  (default `true`) downgrades verification to apply-time-only and stamps
  `integrity: "deferred"`. A per-request flag would be the one an operator clicks
  past on the run that matters. The cost it buys out of is one extra full read, so
  the run reports `verifiedBytes` and elapsed — visible rather than mysterious.
- **`PutOpts.sha256` is populated only where the bytes are buffered** (the manifest
  put), plus a `local.put` digest gate before the atomic rename and a `PutResult.etag`
  cross-check when the etag is sha256-shaped. A streaming upload can't know its digest
  before it finishes, so a general pre-declared hash isn't available. S3's
  `ChecksumSHA256` was deliberately NOT added — it would tie the contract to one
  provider's trailer support while the end-to-end check already runs on our side.
- **`custom_command` backfill can't rescue every run.** `restore-command-backfill.ts`
  re-derives `metadata.restoreCommand` from the owning policy at boot, idempotently.
  A run whose policy was deleted (`SET NULL`, so history outlives the schedule) is
  unrecoverable; those ids are logged every boot rather than swallowed, because the
  alternative is the operator discovering it at the one moment it matters.
- **Mail policy retention still stores null-on-omission** (`mail.controller.ts`,
  ~1339, comment-flagged there). It's inert today because `prunePolicy` skips
  mail-server policies outright, but omitted and explicit-null have to be told apart
  before mail retention can run.

## Retention, and what NULL means now

`createPolicy` wrote `retainCount: null, retainDays: null` — the only two fields on
that insert with neither an API nor a column default — so `prunePolicy` short-circuited
on "no retention configured" and every API- or MCP-created policy kept everything
forever, while the same policy created in the dashboard (whose form defaults to 7)
pruned normally. Now: `DEFAULT_RETAIN_COUNT` (7, shared with the form) is a **column**
default plus an API default, and migration `0096` backfilled rows where both were
NULL. `retainDays` alone is still a complete config and does not get a count bolted on.

That backfill is what makes both-NULL unambiguous: it can only mean *the operator
asked for unlimited*. So there is deliberately **no** `DEFAULT_RETAIN_COUNT` fallback
inside `prunePolicy` — it would override an explicit choice, and it is unreachable
from the sweep anyway, because `iterateEnabledForRetention` filters those rows out
(they aren't visited, so there's no daily warning about a deliberate choice).

The sweep used to walk `listEnabledScheduled()` (`cron_expression IS NOT NULL`) on
the theory that a cron-less policy is manual-only. But `trigger_on_pre_deploy` and
the inbound webhook both produce runs automatically with no cron, so those policies
grew without a ceiling *even with `retain_count` explicitly set* — the one case where
the operator had asked for one. Retention now selects on "enabled + retention
configured", cron irrelevant; `listEnabledScheduled` stays the scheduler's query.
Every skip is logged.

---

## What the tests actually prove

Unit suites under `../../test/modules/backups/` fake the storage backend and the
executor, which is precisely why #434 survived a green run: neither fake could hang,
and neither had a container to miss. So the guarantees above are pinned by one
real-daemon test, `../../test/e2e/backup-volume-roundtrip.e2e.test.ts` — capture a
volume, empty the volume, restore, assert the tree and the bytes. It runs in the
opt-in suite (`bun run --cwd apps/api test:e2e`, `RUN_DOCKER_E2E=1` in CI's
`e2e-docker` job) and it is the only test that drives `backupOrchestrator.execute`
and `restoreOrchestrator.beginPrepare`/`apply` through real archives, a real
`alpine:3` helper and a real destination on disk. It asserts the sha256 recorded at
capture is the one prepare recomputes from the destination's bytes
(`meta.integrity === "sha256"`), restores #434's exact shape (a service row with no
container: nothing stopped, nothing started), and diffs `listContainers({all:true})`
across the run so a leaked helper fails the test.

It initializes the real global platform (`initPlatform(resolvePlatformConfig())`),
unlike the rollback E2Es beside it which fake that seam — the orchestrators resolve
their executor through it, and a stand-in would decide the thing under test. Its
destination is a tmpdir rather than the default `BACKUP_LOCAL_ROOT`; the root and
deny-list rules are create-time gates in `destination.service.ts`, covered by
`test/modules/backups/local-destination-path.test.ts`.

The timeout behaviour itself can't be proven against a real daemon — you cannot ask
one to hang on demand — so it is pinned by a matched pair of fake-timer suites in
`packages/adapters/test/`: `backup-receive-stream-timeout.test.ts` (restore, 11 cases)
and `backup-stream-path-timeout.test.ts` (capture, 10 cases), over one shared
scriptable helper double (`test/helpers/docker-helper-harness.ts`). Both assert the
same four properties from their own direction — silence bounded at the caller's
window *and* at the shared 10-minute default, traffic explicitly **not** bounded (a
40s transfer against a 5s idle window must survive), the ceiling still enforced while
bytes flow, and the helper reaped on every path including a throw before hand-off.
That the capture suite passes `idleTimeoutMs`/`timeoutMs` as plain `StreamPathOpts` is
itself the regression test for the removed cast.

**CI triggers, split by cost.** `e2e-docker` is a two-scope matrix (`E2E_SCOPE` in
`apps/api/vitest.e2e.config.ts`): `fast` — every daemon-level and full-cycle case,
~5 min — runs on every PR and push; `heavy` — `rollback-build-restore` alone, ~225s
cold because it pulls a Node base image and runs a real build, with
`fileParallelism: false` holding the suite up meanwhile — runs on `workflow_dispatch`,
the nightly `schedule`, and `v*` tags, so a release is proven restorable before it
ships. `ci.yml` also gained a `concurrency` group (PR pushes cancel their
predecessor; main and tags run to completion) and a Docker Hub login guarded on a
secret that does not exist yet — hosted runners share outbound IPs, so anonymous
pulls hit `toomanyrequests` as a function of strangers' traffic and it reads as a
flaky rollback test. There is deliberately **no** `paths:` filter: these are required
checks, and a path-filtered required check never reports on a PR it excluded, leaving
it unmergeable with no visible reason.

---

## Migrations from this pass

- `0094_backup_restore_meta`
- `0095_backup_restore_cancel` — `cancel_requested`, `cancel_requested_at`, `cancelled_at`
- `0096_backup_policy_retention_defaults` — column default + both-NULL backfill

`bun run db:generate` is unusable in this repo (the drizzle snapshots stop at
`0060_snapshot.json`), so these are hand-authored SQL with a hand-edited
`_journal.json`, and every statement is separated by `--> statement-breakpoint` —
PGlite rejects multi-command prepared statements (`42601`), which is how the test
suite catches a missing breakpoint immediately.

---

## Reference

- Backup orchestrator: `backup.orchestrator.ts` · restore: `restore.orchestrator.ts`
- Retention sweep: `retention-prune.ts` · D5 backfill: `restore-command-backfill.ts`
- Executors: `packages/adapters/src/backup/executors/{docker,bare}.ts`
- Producers: `packages/adapters/src/backup/producers/{volume,custom-command,...}.ts`
- Destination path rules: `../backup-destinations/destination.service.ts`
- Schema: `packages/db/src/schema/backup.ts`
