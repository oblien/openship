# Rollback — pending work + known limits

State as of 2026-08-05. This file lives next to the orchestrator so anyone
working on rollback sees the open questions before they pick up new work. The
backup/restore half has its own file: `../../backups/PENDING.md`.

---

## Shipped (the current state)

**The restore model.** `planRestore` (restore-plan.ts) decides at ROLLBACK time
how a release comes back, from what's actually still on the host — never from a
flag frozen onto the deployment:

- `redeploy-pinned` — the artifact is there, so ONE `triggerDeployment` call
  replays the target's frozen snapshot + env with the artifact PINNED. No build,
  no clone, no git token (`snapshotNeedsGitSource`). The artifact is an image
  (server apps, per compose service) or a release DIRECTORY (static sites).
- `unit-swap` — bare/cloud only (capability `unitRestore`), where the artifact is
  a durable per-deployment unit that survived the redeploy: `makeActive`, a
  health probe, then the pointer, with a compensating swap-back on DB failure.
- `rebuild` — nothing retained, but the commit is known. Same deploy call minus
  the pins.

A restore is a REAL deployment (forward-only pointer), so it inherits the deploy
pipeline's env/ports/volumes/labels/network/routing, health gate, stabilization
watch, logs, SSE and notifications; `onSuccess` reuses the version number per
commit, so rolling back to v2 reads as v2. A failed restore leaves the current
release serving.

**Invariant: rollback never dead-ends.** If the commit is known, the release is
restorable — instantly when the artifact is there, by rebuild when it isn't. The
dashboard therefore has ONE rollback action whose confirm names the resolved mode.

**Retention.**

- `artifact_retained_at` is set on EVERY successful deploy (both rows), so the
  affordance is honest for every project. Nulled when retention purges.
- `resolveRollbackWindow` is the single resolver: explicit `rollback_window` →
  the disk-sized `rollback_window_computed` (NULL window = auto) → the instance
  default. Sized by `computeAutoRollbackWindow` in `@repo/core` from free disk on
  the daemon's data root (25%, capped, clamped 2–20), measured once per deploy
  inside the image reap and persisted, so prune/GC/UI do no I/O.
- `project.defaultRollbackStrategy` is a RETENTION preference read LIVE ("hold
  artifacts" vs "rebuild"), not a per-deployment decision — flipping it applies
  to existing history.
- Pins (`deployment.pinned`) are exempt and don't consume the window budget;
  capped at `MAX_PINNED_PER_PROJECT` (10).
- Purging NEVER removes an artifact another retained release still references
  (`computeKeepSet` gates both `prune` and the compose per-service reclaim) — a
  restore shares its source release's tag, so this is load-bearing.
- Per-service images resolve through `effectiveImagesAsOf`: a deploy only
  rebuilds what changed, so an untouched service's image comes from the newest
  row at-or-before the target that recorded one.

**Surfaces.** `GET /deployments/:id/restore-plan` serves the confirm copy and
gates the GitHub-access check (an instant restore needs no repo access). Retention
controls live in the project's Backup tab and in the deploy wizard's target panel,
both rendering one `RollbackRetentionCards`.

**Also shipped:** hard-link release-dir dedup on bare (`rsync --link-dest`);
`project.cloudArchiveStrategy` exists (default `'inplace'`; `'offload'` is a
forward-compatibility placeholder).

**Tests.** Unit: `restore-plan.test.ts` (every mode incl. static + partial compose
+ the no-snapshot guard), `pinned-artifacts.test.ts`, `rollback-prune.test.ts`
(window/pin math + the shared-artifact guard), `@repo/core/rollback-window.test.ts`,
`effectiveImagesAsOf` against a real PGlite.

Real-daemon E2Es under `apps/api/test/e2e/`. They run only in the opt-in suite
(`bun run --cwd apps/api test:e2e`) — `bun run test` excludes the directory — and
CI runs them in the `e2e-docker` job with `RUN_DOCKER_E2E=1`, which turns "no
daemon" into a FAILURE instead of a skip. Locally the socket is resolved the way
the product resolves it (explicit → `DOCKER_HOST` → active `docker context` →
`/var/run/docker.sock`), so Colima / Rancher / Podman need no env at all; a skip
prints the reason. See `apps/api/test/helpers/docker-e2e.ts`.

CI splits them by cost through `E2E_SCOPE` (`apps/api/vitest.e2e.config.ts`): every
file below except `rollback-build-restore` runs on each PR and push (`fast`, ~5 min);
that one runs on `workflow_dispatch`, the nightly schedule and `v*` tags (`heavy`).
A bare `bun run --cwd apps/api test:e2e` with no `E2E_SCOPE` still runs everything,
so the local command is unchanged. Rationale in `../../backups/PENDING.md`.

- `rollback-docker.e2e.test.ts` — daemon-level facts: a redeploy REMOVES the
  container while the image survives; a restored container is complete (env,
  pinned loopback publish, volume, labels, caps) and serves the old bytes; prune
  withholds a shared image.
- `rollback-full-cycle.e2e.test.ts` — `rollback()` itself, single-app: the whole
  chain (plan → triggerDeployment → pipeline → deploy → onSuccess →
  onDeploymentReady) with NO clone and NO build, forward-only pointer, version
  reuse, symmetric roll-forward.
- `rollback-compose-cycle.e2e.test.ts` — `rollback()` on a two-service stack where
  only ONE service changed: both services pinned (the untouched one resolved
  backwards via `effectiveImagesAsOf`), nothing rebuilt, the unchanged service
  never disturbed.
- `rollback-build-restore.e2e.test.ts` — the slowest one (it pulls a Node base
  image): a REAL build of `fixtures/deploy/node`, then a restore that reuses its
  image. Its build config comes from `buildConfigSnapshot` + `createBuildConfig`,
  the production pair — the hand-written literal it replaced was cast `as never`
  and silently omitted `runtimeImage`, so the recipe read `FROM undefined`.

The same suite carries one non-rollback file, `backup-volume-roundtrip.e2e.test.ts`
— the backup half's only real-daemon proof (see `../../backups/PENDING.md`).

The cycle tests fake exactly two seams — how the platform/runtime is LOCATED (so a
test box isn't handed OpenResty) and GitHub check emission. Everything else is
real: rows, orchestrator, planner, pipeline, containers.

**Bugs these tests found and fixed** (all pre-existing, all reachable outside
rollback too):

- `snapshot.productionPaths.length` crashed the pipeline on any release whose
  snapshot never set the field — un-restorable AND un-redeployable.
- Preflight judged a fully-pinned deploy by BUILD-config rules ("missing install
  command"), so adding a required field would retroactively break restores of
  every older release. Now exempt via `isFullyPinned`.
- `triggerDeployment` refused any project with no git URL and no localPath — which
  a registry-image-only adopted stack legitimately is. Now gated on whether the
  deploy actually needs source.
- Six of nine `service_deployment` write sites left `serviceName` NULL, so a
  restore of such a release could not key its per-service pins and rebuilt
  everything. All nine now record it.
- `normalizeRollbackWindow("")` returned 0 — a cleared form field meant "retain
  nothing".

---

## Pending — Cloud rollback architecture

### 1. Inline workspace model (one workspace per project, not per deployment)

Currently we run **one Oblien workspace per deployment**. 5 retained deployments = 5 stopped workspaces + their archives, each billing a workspace slot.

The proposed model: **one workspace per project**, releases as folders inside:

```
/app/
  releases/
    <depId-1>/
    <depId-2>/
    <depId-3>/
  current  →  releases/<depId-3>/       # symlink
```

Workload's `working_dir` points at `/app/current`. Rollback = `ln -sfn ... current` + `workload.restart`. Instant. One slot per project. Same Capistrano shape we use on bare.

**Why this isn't shipped:** ~300-500 line refactor of `CloudRuntime.deploy` (provision-once flow), `build.service.ts` (thread `previousDeploymentId` to cloud too, currently bare-only), `project` schema (add `cloudWorkspaceId`), and a slimmed `archive/makeActive/purge` for cloud. The user is going to address the static-compute path on Oblien's side first — once that lands, we revisit.

**Migration path** (no-breaking): add `project.cloudWorkspaceId`. On deploy, if set → inline path; if not → provision the project workspace and stamp the column. Old per-deployment workspaces stay addressable for rollback until they prune out. Models coexist; projects converge naturally.

### 2. Oblien "create workspace from archive" — not supported

We verified this against the docs (`/llms.mdx/docs/api/{snapshots,workspaces,images}` + concepts). Confirmed:

- Archive endpoints are workspace-scoped (`/workspace/{wsId}/archives/*`). No account-level store.
- `workspaces.create` has NO `restore_from`, `from_archive`, `archive_id`, `seed`, `hydrate`, `from`, `source`, `template`, or `clone_from` parameter. `image` (catalog ID) is the only source identifier.
- `GET /workspace/images` is the only images endpoint — catalog is read-only; no "commit workspace to custom image" flow.
- `POST /workspace/{wsId}/restore` only restores to the LAST snapshot of THAT workspace.

Conclusion: the "kill workspace + recreate from archive" pattern the user originally wanted is **not buildable** against the current Oblien API. We'd need either:
- A new Oblien endpoint we don't have (open question with their team), or
- External durable storage (R2/S3), which we explored and reverted because it's the wrong call for Openship Cloud (should be internal to the Oblien account).

The inline workspace model (item 1) sidesteps the requirement entirely.

### 3. `cloud_archive_strategy: 'offload'` is a placeholder

The DB column accepts `'inplace' | 'offload'`. Only `'inplace'` is wired. `'offload'` is reserved for a future self-hosted-to-external-S3 path — when self-hosted users want to ship their archives off-host. Not buildable for Openship Cloud (which would need internal Oblien support per item 2).

---

## Pending — orchestrator / data model

### 4. Atomic flip — RESOLVED for docker, narrowed for bare/cloud

A `redeploy-pinned` / `rebuild` restore is a normal deployment: the pointer only
advances on success, so there is no window to be inconsistent in. `unit-swap`
(bare/cloud) still swaps-then-writes, but now health-probes before committing and
swaps back on DB failure. The residual case — compensating swap ALSO fails — logs
a CRITICAL for manual reconciliation.

### 5. Per-environment rollback window

`rollbackWindow` is per-project. In practice production usually wants longer retention than preview. Either:
- Move the column to a per-environment table, or
- Resolve at runtime via `instance_settings` with an env-specific override.

Not urgent until preview deploys get heavy.

### 6. Multi-service compose rollback — RESOLVED

Compose restore no longer touches container ids at all (the dead
`DeploymentRef.serviceContainerIds` is gone). It pins per-service IMAGES —
resolved via `effectiveImagesAsOf`, so an unchanged service reuses the image
already on the host. A service whose image aged out simply falls into the
buildable set.

What the deploy path does with the service list is narrower than this section
used to claim. `build-pipeline.ts` hands the release's FROZEN list to
`syncFromCompose(..., { removeMissing: false })`: rows are created and updated,
never deleted. A frozen list is a snapshot, not an inventory — on a rollback it
predates every service added since, and deleting those rows would cascade
`service_deployment` (`onDelete: "cascade"`) across all of history and orphan
their running containers. So **services newer than the target keep running,
untouched, with their rows and history intact**, and the rollback confirm dialog
says so. Removing a de-listed service stays the job of the explicit compose
reconcile (`reconcileFromCompose`), which models a removal policy on purpose.

### 7. Health-check gate — RESOLVED

`redeploy-pinned`/`rebuild` inherit the deploy pipeline's health check and the
#335 stabilization watch, and never advance the pointer on failure. `unit-swap`
probes `getContainerInfo` until running (skipped on bare, which can't inspect)
and reverts if it doesn't come up.

### 8. Hot-rollback for Docker (no container churn)

Still open, and now the main remaining latency win. A restore recreates the
container from the retained image (seconds). A true hot swap would keep the old
container running on a second loopback port and flip only the edge upstream —
sub-100ms — which needs the route layer to support an endpoint swap without
container churn, plus a policy for how long two versions may coexist.

---

## Pending — UX

### 9. Restore-mode chip in the deployments LIST

The confirm dialog names the resolved mode, but the list rows don't: showing
"instant" vs "rebuild" per row would need a presence check per row (an SSH round
trip), so it's deliberately resolved on demand instead. A cheap approximation
(artifact_retained_at + age) could pre-badge rows.

### 10. Rollback diff preview — PARTIALLY SHIPPED

`RollbackConfirmDialog` now shows the resolved mode, which services rebuild, the
ENV diff (keys + direction, never values) and the "services newer than this release
keep running and are not touched" line, all from `GET /deployments/:id/restore-plan`.
Still open: commit range and per-service image diff.

### 11. Bulk delete + bulk pin

Right now pin/delete is one-at-a-time per deployment row. Bulk select for retention cleanup.

### 12. Cloud (Oblien) restore still costs a workspace per release

`unit-swap` keeps cloud working, but one workspace per retained deployment is the
model item 1 above replaces. Unchanged by this work.

---

## Pending — bigger architectural moves (not on the near-term roadmap)

### 13. Content-addressable artifact store

Two builds producing byte-identical output pay 2× storage. A content-addressable store (build output → SHA → ref count) would dedupe across deployments and projects. Real win at scale; large new subsystem.

### 14. Bare runtime: full Capistrano (symlink-swap supervisor)

Today bare runs one supervisor unit per deployment. Full Capistrano would run one unit per project pointing at `current` symlink. Rollback = symlink swap + `systemctl reload`. Even faster than today's `stop(from)+start(to)`. Bigger refactor; current model works.

### 15. Filesystem-native snapshots on bare (zfs/btrfs)

Block-level dedup beyond rsync hard-links. Ties us to a filesystem; not portable.

---

## Decision log

- **S3/R2 offload for Openship Cloud** — rejected. Should be internal to Oblien; S3 belongs to a future self-hosted-only path.
- **`pause` instead of `stop` on archive** — rejected. Paused workspaces keep memory billed; the archive semantic must stay cheap.
- **Custom Oblien images from workspaces** — not available (read-only catalog).
- **Hard-link release dedup on bare** — shipped (via `rsync --link-dest`).
- **Redeploy-from-commit as the purged-artifact fallback** — shipped, then FOLDED
  INTO rollback itself: the restore planner picks `rebuild` automatically, so the
  dashboard has one action instead of two CTAs.
- **`DockerRuntime.makeActive`** — DELETED. Recreating a container by hand there
  could only ever be a lesser copy of `deploy()` (it shipped no env, no published
  port, no volumes, no labels), and Docker's artifact is the image anyway.
- **Restore as a new deployment row** — shipped (forward-only pointer). History
  grows by one row per restore; `onSuccess` reuses the commit's version number.
- **A rollback's FROZEN env wins over live rows** — decided, shipped for compose
  (the single-app path always worked this way; compose was the anomaly, where the
  frozen layer beat live *project* env but lost to live *service* env). "The release
  runs what it ran" is the whole promise of rollback, and a merge that silently
  half-applies it is worse than either rule. The live layers stay as the base and
  the frozen map moves last, so it shadows exactly the keys it captured and leaves
  the rest — dropping them would delete keys the flat snapshot never recorded. The
  cost is real: a rollback reverts a rotated secret. The mitigation shipped in the
  same commit — `RollbackConfirmDialog` shows the env diff (keys and DIRECTION only,
  never values, because env is output-masked everywhere else and a confirm dialog is
  not the place to widen that).
- **Scope-aware env capture** — deferred, and marked rather than left implicit.
  `dep.envVars` is a flat `Record<string,string>` with no service scoping, so one
  case is genuinely unresolvable: a key that was project-scoped at capture and is
  now service-scoped with per-service values replays one value everywhere. Fixing it
  changes the column's shape (migration + capture + back-compat read for every
  existing row). Instead each row is stamped `meta.envCapture = "flat-v1"` so a
  future scoped capture is unambiguous, and the diff marks those keys
  `scopeAmbiguous` so the operator sees exactly the case the flat map can't decide.
- **`removeMissing: false` at deploy time** — the most consequential behavior change
  in this pass, and it is NOT rollback-only. A service genuinely deleted from a
  compose file now keeps its row and stays deployed until someone reconciles. The
  narrower `removeMissing: dep.trigger !== "rollback"` was rejected because it leaves
  the reaper-orphan bug live on ordinary deploys: the sync ran first and its cascade
  emptied the very `service_deployment` list `deployComposeServices` reaps de-listed
  containers from, so the container was orphaned and left running.
- **`advanced` deliberately NOT on the wire schema.** The compose `advanced` blob
  (healthcheck / readiness / generated files / resource caps / network alias) is now
  carried through storage AND the deployable snapshot, so a rollback replays it. It
  was NOT added to `BuildServiceInput` or the dashboard deploy body: nothing needs it
  there, and it would open an MCP-exposed write path for `readiness` and `files` that
  today exists only behind the merge-protected service-update route.
- **`defaultRollbackStrategy` now persisted at create.** It was in the request
  schema and the dashboard already sent it; only the persist side was missing, so it
  silently fell back to the column default. Only explicit senders change behavior.
- **The `git` strategy name is a misnomer** and stays one for now: Docker retains
  images regardless of strategy, so the real knob is the disk-sized window, not the
  strategy label.

---

## Reference

- Orchestrator: `apps/api/src/modules/deployments/rollback/rollback-orchestrator.ts`
- Restore planner: `apps/api/src/modules/deployments/rollback/restore-plan.ts`
- Pinned artifacts: `apps/api/src/modules/deployments/pinned-artifacts.ts`
- Window math: `packages/core/src/rollback-window.ts`
- Cloud primitives: `packages/adapters/src/runtime/cloud.ts`
- Bare primitives: `packages/adapters/src/runtime/bare.ts:528-576`
- Docker primitives: `packages/adapters/src/runtime/docker.ts:851-921`
- Schema: `packages/db/src/schema/deployment.ts` + `packages/db/src/schema/project.ts`
- Migration: `packages/db/drizzle/0021_deployment_rollback.sql` + `0022_cloud_archive_offload.sql`
- Dashboard menu: `apps/dashboard/src/app/(dashboard)/deployments/components/DeploymentMenu.tsx`
