# Rollback — open work

Only what is NOT done. The shipped model — the three restore modes, the retention
resolver, the never-dead-end invariant — lives in the code and its comments
(`rollback-orchestrator.ts`, `restore-plan.ts`, `release-retention.ts`) and in git
history; nothing is restated here. The backup/restore half has its own file:
`../../backups/PENDING.md`.

Every item below was re-verified against the working tree on 2026-08-20, including
uncommitted changes. Line numbers are from that check.

---

## Cloud (Oblien)

### Inline workspace model — one workspace per project, not per deployment

We still run **one Oblien workspace per deployment**, so 5 retained deployments = 5
workspaces (1 running + 4 stopped) plus their archives, each billing a slot.
`CloudRuntime.deploy` takes the BUILD workspace as the unit (`cloud.ts:1626`,
`workspaceId = config.imageRef`), promotes it with `ws.lifecycle.makePermanent()`
(`cloud.ts:1651`), and returns `containerId: workspaceId` (`cloud.ts:1859`) — so a
deployment's container id IS its own workspace id. The capability comment says it
outright at `cloud.ts:451-454`.

The proposed model: one workspace per project, releases as folders inside, with
`working_dir` pointing at `/app/current`. Rollback = `ln -sfn … current` +
`workload.restart`. Instant, one slot per project, the same Capistrano shape bare
already uses (`bare.ts:207`, `bare.ts:256`).

```
/app/
  releases/<depId-1>/  <depId-2>/  <depId-3>/
  current  →  releases/<depId-3>/
```

Nothing of it has shipped. What it needs:

- The provision-once refactor of `CloudRuntime.deploy` (`cloud.ts:1625-1860`). Today
  staging is a one-shot in-place `mv /app/.staging /app/production`
  (`cloud.ts:1737-1765`) and `workDir` is `/app/production` or `/app`
  (`cloud.ts:1702-1705`, applied at `cloud.ts:1789-1795`) — never a release dir.
- Symlink-swap `makeActive`, plus a slimmed `archive`/`purge` (`cloud.ts:2124-2216`).
  All three are still workspace-lifecycle calls: `stop(from)` then `start(to)`,
  `createArchive + stop`, `deleteAllArchives + destroy`.
- Cloud consumption of `previousDeploymentId`. It IS on the shared `DeployConfig` and
  set for every runtime (`build-pipeline.ts:1740`), but only bare reads it
  (`bare.ts:642`, `bare.ts:688`); `adapters/src/types.ts:344-352` documents
  "Docker/Cloud ignore the field".

**The migration path in the old plan no longer works, and this is the trap.**
`project.cloudWorkspaceId` now exists — but it is the cloud LINK marker, not an
inline hook. It is stamped after every successful cloud deploy from the workspace
that deploy just created (`deployment-lifecycle.ts:759-767`) and read only to derive
the target (`build.service.ts:411`, `core/types.ts:65`). So it is **already non-null
for every existing cloud project**, and "if set → inline path, if not → provision and
stamp" would route every legacy per-deployment project into the inline path on its
next deploy. A separate inline-vs-legacy marker is needed. Note also that the
`BuildConfig.cloudWorkspaceId` consumed at `cloud.ts:663-672` is a DIFFERENT value —
the browser folder-upload session workspace (`build-pipeline.ts:829-831` ←
`build.service.ts:1224`).

**Why the obvious alternative is not available.** "Kill the workspace and recreate it
from an archive" is not buildable against the current Oblien API, verified against
their docs: archive endpoints are workspace-scoped (`/workspace/{wsId}/archives/*`)
with no account-level store; `workspaces.create` has no `restore_from`,
`from_archive`, `archive_id`, `seed`, `hydrate`, `from`, `source`, `template` or
`clone_from` — `image` (a read-only catalog id) is the only source identifier;
`GET /workspace/images` is the only images endpoint, so there is no
commit-workspace-to-custom-image flow; and `POST /workspace/{wsId}/restore` only
restores to the last snapshot of THAT workspace. It would need a new Oblien endpoint
(open question with their team) or external durable storage, which was explored and
reverted as the wrong call for Openship Cloud. The inline model sidesteps the
requirement entirely, which is why it is the path.

**What it costs until then.** Retention archives the previous release
(`rollback-orchestrator.ts:96-105`) whenever the runtime advertises `unitRestore`,
which cloud does (`cloud.ts:454`); `archive` keeps the workspace claimed by design
(`cloud.ts:2099-2117` — a stopped workspace is what makes rollback work), and only
`purge` frees a slot, when the release falls out of the window. The restore side
needs that survivor: `restore-plan.ts:188-190` only returns `unit-swap` when the
target still has a container id and a retained artifact, and `cloud.ts:2131-2136`
throws "workspace is gone" without it. So a cloud project's rollback window is a
direct multiplier on Oblien workspace slots.

### `cloud_archive_strategy: 'offload'` persists and then does nothing

The column accepts `'inplace' | 'offload'` (`schema/project.ts:393`), the API takes it
(`project.schema.ts:403-405`), and it is persisted and echoed back
(`project-crud.service.ts:600`, `:1218-1219`, `:1746`). It has **zero readers** — no
`=== "offload"` comparison anywhere, and the one consumer of the archive decision,
`cloud.ts:2141-2179`, never receives the project row, so it cannot vary by strategy.

Reserved for a future self-hosted-to-external-S3 path (shipping archives off-host).
Not buildable for Openship Cloud, which would need the Oblien support the item above
establishes we don't have. Either wire it or stop accepting the value.

*(Correction to the old reference list: `0022_cloud_archive_offload.sql` does not
exist — 0022 is `0022_version_on_success_backfill.sql`. The column ships in
`0000_init.sql:362`.)*

### A failed archive delete on purge is still only a warning

`CloudRuntime.purge` now propagates the WORKSPACE deletion, so a slot we still pay for
can no longer be recorded as reclaimed. `snapshots.deleteAllArchives` stays warn-only,
because a workspace that never archived has nothing to delete and Oblien's response for
that case is not one this code can tell apart from a real failure — making it fatal
would break every cloud purge to report a leak that may not exist. Distinguishing the
two needs a confirmed answer from Oblien (or an archive listing before the delete);
until then a genuinely stuck archive blob keeps billing storage and only shows up in a
log line.

---

## Retention and core

### Per-environment rollback window

`rollbackWindow` is per-project and the resolver is environment-blind:
`RollbackWindowProject` carries four project-level fields
(`release-retention.ts:7-12`) and `resolveRollbackWindowDetail` has the three
documented branches with no env parameter (`release-retention.ts:39-70`, `:72-74`).
The columns are project-scoped (`schema/project.ts:298`, `:305`) and the instance
default is one scalar (`schema/settings.ts:71`). There is no per-environment table at
all — the only `environment` columns are project identity
(`schema/project.ts:89-93`), env-var scoping (`:534`), and `deployment.environment`
(`schema/deployment.ts:56`). Enforcement confirms the gap: `prune` resolves ONE
window and walks every ready deployment with no environment filter
(`rollback-orchestrator.ts:524-537`), while a release's environment is a
per-deployment attribute (`:346`).

Worth knowing before picking this up: a **separately created** environment is its own
project row and therefore gets its own copy of the column, seeded from the parent at
create (`project-crud.service.ts:1745`). The uncovered case is narrower than "per
environment" suggests — preview deployments living inside ONE project row share that
row's single window, which is exactly when production wants longer retention than
preview.

Either move the column to a per-environment table, or resolve at runtime via
`instance_settings` with an env-specific override. Not urgent until preview deploys
get heavy.

### Hot-rollback for Docker (no container churn)

The main remaining latency win, and fully unbuilt. Every Docker restore recreates the
container from the retained image (`rollback-orchestrator.ts:339-355`); the only
in-place path is `restoreViaUnitSwap` (`:359-465`), which is bare/cloud `makeActive`
plus a probe and a pointer flip, and it ends in a full route **re-sync**
(`syncProjectManagedEdge`, `:455-462`) rather than an upstream flip. The route layer
has no endpoint-swap primitive: `upstream-url.ts:1-80` is a pure resolver, one target
per container, and `routing-apply.service.ts` re-applies routing for the project's
single `activeDeploymentId`.

**The "second loopback port" premise is impossible on the default strategy**, which is
the part that has to be solved first: `canOverlap = runtime.name !== "bare" &&
routeStrategy !== "loopback-port"` (`build-pipeline.ts:1540`, rationale at
`:1537-1539` and `:1834-1841`) — a pinned loopback port cannot be double-bound, so
loopback-port deploys stop-first. The only overlap that exists today is deploy-time
run-new-then-swap under the advanced `container-ip` strategy
(`upstream-url.ts:13-15`, `project.schema.ts:441-444`), and it still creates a new
container.

Needs all four: the swap primitive, a dual-version model, a rollback caller for it,
and a policy for how long two versions may coexist.

---

## UX

### The deployments list never says instant vs rebuild

Half of the cheap approximation already ships: `DeploymentCard.tsx:217-225` renders a
`Snapshotted` chip gated on `!pinned && artifactRetainedAt && !isActive`, beside
`Active` (`:199`) and `Pinned` (`:208`).

What's missing is the mode itself. `instant`/`rebuild`/`mixed` exists only on the
confirm path — `DeploymentMenu.tsx:140-150` builds `modeLine` from the restore plan
and `RollbackConfirmDialog.tsx:57` renders it. No row-level badge names the mode, no
row uses age, and the **rebuild-only case renders no chip at all** (no artifact, commit
present) — that state is visible only in the menu item's tooltip
(`DeploymentMenu.tsx:267-277`). Resolving it truly per row costs a presence check (an
SSH round trip) per row, which is why it's on demand today; `artifact_retained_at` +
age is the approximation worth trying.

### Rollback diff preview — commit range and per-service image diff

Everything else in the dialog is done. Still absent, both because the restore-plan
payload doesn't carry them:

- **Commit range.** `RestorePlanUI` (`dashboard/src/lib/api/deploy.ts:7-43`) and the
  server payload (`deployment.service.ts:223-243`, served at
  `deployment.controller.ts:200-206` / `deployment.routes.ts:140-151`) carry
  mode / needsRepository / rebuildServices / env / untouchedServices / code / reason
  and no commit fields; the dialog renders no compare link. The orchestrator already
  resolves `prevSha` internally — the preview just never exposes it.
- **Per-service image diff.** `rebuildServices` is service NAMES only.
  `resolveEffectiveServiceImages` (`rollback-orchestrator.ts:212-240`) resolves the
  old/new image refs internally and the preview drops them.

Both want new payload fields, matching `RestorePlanUI` entries, dialog sections, and
locale keys.

### Bulk pin and bulk delete

Pin and delete are one-at-a-time per row, top to bottom. `DeploymentsList.tsx` is 38
lines and just maps rows — no selection state, no header row, no checkbox. The
actions are single-row menu items (`DeploymentMenu.tsx:152-166`, `:168-177`) over
per-id routes (`deployment.routes.ts:157` `POST /:id/pin`, `:178` `DELETE /:id`) and a
per-id client (`deploy.ts` `deleteDeployment(id)`, `pin(id, pinned)`). Nothing bulk
exists on any layer.

Wants row selection, a bulk action bar, and collection-scoped routes with their
permission tags — the use case is retention cleanup.

---

## Not on the near-term roadmap

### Content-addressable artifact store

Two builds producing byte-identical output pay 2× storage. A store keyed by SHA with
ref counting would dedupe across deployments and projects. Nothing like it exists:
the only digest in the model is `service_deployment.image_digest`
(`schema/service.ts:271-276`, migration 0050) and its purpose is update-scanner drift
detection on mutable tags. Retention keeps by a row-derived tag set
(`computeKeepSet`, `image-gc.ts:49-61`) — a keep set, not ref counting — and bare
dedupe is filesystem hard-links (`bare.ts:311`), not content addressing. Real win at
scale; large new subsystem.

### Bare runtime: full Capistrano (per-project supervisor unit)

Still one unit per deployment. Unit identity is the deployment id
(`supervisor/systemd.ts:5`, `:12`, `:56-61`), release dirs are per deployment
(`bare.ts:206-208`), and `makeActive` is `stop(from)` then `start(to)`
(`bare.ts:835-853`, rationale `:819-833`). There is no `current` release pointer — the
one `ln -sfn` (`bare.ts:256`) links shared persistent paths into a release dir.

Full Capistrano would run one unit per project pointing at `current`, making rollback
a symlink swap plus `systemctl reload` — faster than today's stop/start. Bigger
refactor; the current model works.

### Filesystem-native snapshots on bare (zfs/btrfs)

Block-level dedup beyond rsync hard-links. Entirely unbuilt: no filesystem detection
and no snapshot/clone path. Bare release dedup is `rsync -a --delete --link-dest`
(`bare.ts:283-329`, the call at `:311`) with a plain `mv` fallback (`:322-328`). Ties
us to a filesystem; not portable.
