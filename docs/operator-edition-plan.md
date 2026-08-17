# OpenShip Operator — implementation design

Turn this fork into **OpenShip Operator**: a local-first deployment cockpit.
The browser is the main interface. The desktop app hosts the local control
plane. A tiny server agent keeps production healthy when the desktop sleeps.

This is **not** a miniature OpenShip Cloud.

## Already done (do not redo)

- Fork work is on `origin/feat/operator-edition` and `origin/main` at
  `f3b57867` (mounted releases, isolated builders, prebuilt mode, desktop
  profiles, BuildKit/Desktop fixes).
- Upstream v0.6.6 is already merged, including the unified credential store
  (`feat/credential-store`) and the service-identity migration fix (`#584`).
- Mounted releases are already **opt-in** via `project.mountedRelease.enabled`.
  Keep that invariant until Wave 5 recipes opt specific projects in.

## Core model

Five concepts:

- **Control plane** — the local OpenShip installation.
- **Project** — Austin’s Elite, Dashwood, Lake Forest.
- **Environment** — Production, Staging, Preview.
- **Service** — Staff, Public, Mail.
- **Release** — the exact runtime and application code currently serving.

Defining split:

```text
Runtime
  OS, PHP/Node, extensions, process manager, mounts
  Rebuilt rarely

Application release
  Exact Git SHA or uploaded artifact
  Deployed constantly

Persistent state
  SQLite, uploads, storage
  Never replaced or pruned with releases
```

Operator actions:

1. **Deploy code**
2. **Refresh configuration**
3. **Rebuild runtime**

Mail may keep a fourth strategy — **immutable image release** — without making
that the default for everything.

Code-release sources:

- **Prebuilt in Git** — fetch exact SHA, extract, switch, reload.
- **Build locally and upload** — deterministic compressed artifact.
- **Prepare on server** — constrained disposable builder with persistent caches.

Migrations, cache warming, and queue restarts are **named release phases**, not
additional deployment modes.

## Scope of this execution

Implement **all six waves** as the PR DAG below.

Wave 5 does **not** cut over live Contabo production. It ships recipes, export
format, and a runbook. Production moves stay a human-operated rehearsal.

Wave 6 deletes SaaS surfaces only after Operator settings, credentials, GitHub,
desktop host, and MCP cover the retained paths.

## Invariants

- Runtime deploys (existing image pipeline) keep working for projects that have
  not opted into mounted/code releases.
- A Public change must never rebuild Staff or Mail.
- Secrets and physical server paths stay local; they are not committed.
- Focused tests around the engine contract being changed. One typecheck/build
  per PR. No 25-check doom loop.
- Do not invent a second credential store. Reuse the unified org-scoped store.
- Do not invent a second service-identity scheme. Use existing service row IDs.
- Comments explain non-obvious constraints only. No design-history narration.

## Current defects this DAG must close

### Release engine

- GitHub auto-deploy calls `triggerDeployment` in
  `apps/api/src/modules/github/webhook-push.ts` and never consults
  `mountedReleaseConfig` / `triggerMountedRelease`.
- `getProjectDrift` / `GET /projects/:id/commit-status` compare against
  `activeDeploymentId` (runtime), so a successful code release still looks
  outdated (`apps/api/src/modules/updates/updates.service.ts`).
- Compose mounts match `service.name` (`withMountedReleaseServiceVolume` in
  `mounted-release.config.ts`), not stable service IDs.
- Reload/health use `livePrimaryContainerId` of the runtime deployment, not
  the configured compose service.
- `checkNoActiveBuild` is SELECT-then-throw, not an atomic per-service lease
  (`build.service.ts`).
- Cancellation marks the row cancelled; `runMountedRelease` is fire-and-forget
  (`void runMountedRelease(...)`) and can still activate.
- Session logs/phases live in `session-manager` memory and die on API restart.
- `restoreMountedRelease` re-runs the full fetch/prepare for a retained SHA.
- First failed release has no previous pointer; catch path can delete `current`.
- `imageRef` is set to the host filesystem path (`releaseDir`); image GC treats
  it like a Docker image.
- Failed trees, builders, temp creds, and caches are only partly cleaned.
- Live `project.mountedRelease` is re-read during execution instead of a
  frozen contract snapshot on the deployment row.
- Activated release trees stay writable.

### Desktop and MCP

- No `app.requestSingleInstanceLock()`.
- Window close quits the app on Windows/Linux (`window-all-closed` →
  `app.quit()` → `stopLocalServices()`).
- Dynamic port fallback discards `switched`; MCP OAuth audience stays stale.
- Profiles sit in the Account UI but share one PGlite DB.
- `config.json` / `profiles.json` / `ports.json` use non-atomic `writeFileSync`.
- MCP `handleMcpMessage` / `dispatchTool` have no outer deadline.
- Tool names are generated REST paths (`post_deployments_build_access`).

### Migration, edge, continuity

- Jobs (`ssl:renew`, backups, health-watch, image GC) run inside the API
  process. Packaged desktop is that process. Close the window and production
  maintenance stops.
- Migration/rollback can report success when stop/restart failed.
- Scans are heavyweight.
- Imports can create placeholder + real service rows.
- Existing bind mounts can collide with the generated release mount.
- Edge takeover does not adequately protect existing management routes.
- Manual/external routes can escape certificate tracking.
- Edge image lacks a meaningful Docker health check.
- Mounted-release health probes container localhost only.
- Git tokens can appear in process arguments via clone URL / argv.

---

## Wave 0 — Preserve and reconcile

Establish the Operator edition boundary and export today’s project config.
Do not delete SaaS code yet.

Edition contract (`packages/core`):

```ts
type Edition = "operator" | "cloud";
// operator := !CLOUD_MODE  (docker | bare | desktop)
// cloud    := CLOUD_MODE
```

Expose `edition` + `features` on `/health/env`. Drive dashboard nav from
features, not ad-hoc `selfHosted && !localOnly`. Generalize desktop
`localOnly` to Operator: hide Cloud tab, billing, public register/OAuth,
waitlist, cloud deploy target, Cloud GitHub App row, migrate-to-cloud.
Keep orgs/invites/credentials/MCP/audit/GitHub local methods.

Keep `CLOUD_MODE` code compiling. Wave 6 deletes it.

---

## Wave 1 — Make releases truthful

One planner serves UI, webhook, CLI, and MCP.

Classification:

```text
Dockerfile / Compose / PHP extensions changed  → rebuild runtime
composer.lock changed                          → prepare Composer layer, then deploy code
application / Blade / tracked assets changed   → deploy code
environment or route changed                   → configuration refresh
unrelated monorepo app or docs changed         → skip
```

AE monorepo:

- `apps/staff/**` → Staff
- `apps/public/**` → Public
- `apps/mail/**` → Mail
- Shared integration-contract changes may target affected consumers explicitly
- A Public change must never rebuild Staff or Mail

Deployment records store **decision + why**.

Combined live state:

```text
Code      <sha>   <strategy>   <age>
Runtime   <image digest>       <built at>
Server    <name>
Public    HTTPS <passed|failed>
```

Engine fixes in this wave: planner routing, live-state, stable service IDs,
atomic leases, real cancellation, persisted phases, restart recovery, instant
retained rollback, typed FS cleanup, immutable contract snapshot, read-only
finalized trees.

Public HTTPS health can land here as part of activation, not wait for the
agent.

---

## Wave 2 — Server agent

Tiny signed daemon/container on each server. Deliberately boring.

- Maintains a signed relationship with the local control plane
- Executes release manifests
- Keeps a durable operation journal
- Renews certificates
- Runs scheduled backups and health checks
- Recovers interrupted pointer swaps / builders
- Reports capabilities, version, disk, container state
- Runs only one resource-heavy build at a time

The browser/desktop remains where intent and configuration live.

Also close migration/edge honesty bugs and stop putting git tokens in argv.

---

## Wave 3 — Artifact engine

Replace the “mounted release config pile” internals with versioned manifests.

Sources: Git-prebuilt, local-upload tar/zstd, server-prepared builder.

Manifest contains: commit SHA, artifact checksum + provenance, runtime
fingerprint, stable service identity, shared paths, lock hashes, migration
policy, reload/restart policy, internal + public health checks, rollback
policy.

Presets: Laravel, static Next, Node, Compose.

---

## Wave 4 — Operator UI and MCP

Recipe wizard (what runs / how runtime is installed / how code ships / what
persists / how it activates). Advanced: UID/GID, absolute paths, cache
mounts, builder image, limits.

Project header shows combined live state + Deploy latest + More
(commit, rebuild runtime, restart, roll back, terminal).

Release spine visualization: Runtime and Code converging into the live site.

Desktop: single-instance lock, close-to-tray, stable gateway port, Open in
browser, control-plane fingerprint, data path + API endpoint, connected MCP
clients, restart engine / repair endpoint / backup control plane / open data
folder. Rename profiles to **Browser sessions** or remove them.

MCP curated tools:

- `projects.list`
- `projects.live_state`
- `releases.plan`
- `releases.deploy_code`
- `releases.rebuild_runtime`
- `releases.rollback`
- `deployments.status`
- `deployments.logs`
- `services.restart`
- `services.shell`
- `servers.health`
- `activity.recent`

Long operations return an operation ID. Reads get hard timeouts. Generated
REST tools remain as advanced access.

---

## Wave 5 — Move our apps (recipes, not live cutover)

Ship first-class recipes and a runbook:

| Application | Normal deployment |
|---|---|
| Dashwood | Git-prebuilt static release |
| AE Staff | PHP code release; compiled assets from Git; Composer only when lock changes |
| AE Public | Same as Staff |
| Lake Forest | Local artifact initially; optionally Git-prebuilt later |
| Mail | Immutable image release |

Do not SSH into production or flip live pointers in this PR.

---

## Wave 6 — Delete the SaaS product

After Operator paths cover settings, credentials, GitHub, and local auth,
delete rather than hide:

- Cloud connection + workspace promotion
- Billing, subscriptions, metering, promo codes, plan guards
- Hosted namespace/workspace concepts
- SaaS registration + waitlist/marketing surfaces that exist only for Cloud
- Cloud-forwarded GitHub App chain
- Desktop org/account switching that only exists for Cloud

Retain: credential providers, scoped MCP auth, audit, local GitHub methods,
local permissions, projects/servers/deployments/routes/certs/backups/
terminals/migrations/jobs, Better Auth orgs for local invites.

---

## PR Plan

### PR 1: Establish Operator edition boundary and config export

- **Description:** Add `edition` (`operator` | `cloud`) and a `features` map
  in `@repo/core`. `CLOUD_MODE` maps to `cloud`; everything else is
  `operator`. Expose both on `GET /health/env`. On operator, do not mount
  `cloudLocalRoutes` / `billingLocalRoutes` (same as desktop today). Make
  `requireCloud()` fail-closed. Generalize dashboard `localOnly` from
  `deployMode === "desktop"` to `edition === "operator"` so Cloud tab,
  billing nav, public register/OAuth, waitlist, cloud deploy target, Cloud
  GitHub App row, and migrate-to-cloud are hidden. Keep Team invites and org
  tables. Hide org *create* / Cloud workspace switching in the desktop
  chrome. Add a local project-config export (JSON) covering servers,
  projects, routes, release recipes, and non-secret connection metadata so
  Dashwood / Lake Forest can be backed up before later waves. Keep mounted
  releases opt-in. Do not delete SaaS modules.
- **Files/components affected:** packages/core/src/runtime-config.ts, packages/core/src/edition.ts, apps/api/src/app.ts, apps/api/src/modules/health/health.routes.ts, apps/api/src/lib/cloud/require-cloud.ts, apps/dashboard/src/context/PlatformContext.tsx, apps/dashboard/src/components/sidebar.tsx, apps/dashboard/src/app/(dashboard)/settings, apps/api/src/modules/projects, apps/cli/src/commands
- **Dependencies:** None

### PR 2: Route deploys through a release planner

- **Description:** Add a single planner used by webhook, UI, CLI, and MCP.
  Input: project, changed paths, current recipe/opt-in flag. Output: skip |
  deploy_code | refresh_config | rebuild_runtime, plus target service IDs
  and a human-readable reason. Persist decision + why on the deployment
  record. GitHub `webhook-push.ts` must call the planner and, when the
  project has mounted releases enabled, `triggerMountedRelease` (or the
  successor code-release entry) instead of always calling
  `triggerDeployment`. Monorepo path prefixes (`apps/staff/**`,
  `apps/public/**`, `apps/mail/**`) must not cross-deploy. Unrelated docs
  changes skip. Existing runtime-only projects keep today’s
  `triggerDeployment` path when the planner says rebuild or when mounted
  releases are off. Add focused unit tests for classification.
- **Files/components affected:** apps/api/src/modules/deployments/release-planner.ts, apps/api/src/modules/github/webhook-push.ts, apps/api/src/modules/deployments/build.service.ts, apps/api/src/modules/deployments/mounted-release.service.ts, apps/api/src/modules/deployments/deployment.controller.ts, packages/db/src/schema/deployment.ts
- **Dependencies:** None

### PR 3: Resolve combined runtime and code live state

- **Description:** Add a live-state resolver that returns runtime pointer
  (`activeDeploymentId`, image digest, built-at) and code pointer
  (`activeReleaseDeploymentId`, SHA, strategy, activated-at) plus server
  name. Change `getProjectDrift` / commit-status to compare code SHA against
  `activeReleaseDeploymentId` when mounted releases are enabled, otherwise
  keep runtime comparison. Do not mark a project outdated solely because
  the runtime deployment’s commit is stale after a successful code release.
  Expose `GET` live-state for the project header (Wave 4 will skin it).
  Tests: code release updates drift; runtime-only projects unchanged.
- **Files/components affected:** apps/api/src/modules/updates/updates.service.ts, apps/api/src/modules/projects/project.controller.ts, apps/api/src/modules/projects/project.routes.ts, apps/api/src/modules/deployments/deployment.service.ts, apps/dashboard/src/app/(dashboard)/projects/[id]/components/Deployments.tsx
- **Dependencies:** None

### PR 4: Target compose releases by stable service IDs

- **Description:** Store `serviceId` (the `service` row id) on the mounted
  release config instead of matching `service.name`. Update
  `withMountedReleaseServiceVolume` to attach the release mount only to that
  ID. Resolve reload and health-check containers from that service’s live
  container, not `livePrimaryContainerId` of the runtime deployment. Keep
  `serviceName` as a display fallback when reading old rows; migrate writes
  to IDs. Refuse activation if the service ID is missing or disabled.
  Tests: rename of compose service does not retarget the mount; health/reload
  hit the configured service.
- **Files/components affected:** apps/api/src/modules/deployments/mounted-release.config.ts, apps/api/src/modules/deployments/mounted-release.service.ts, packages/db/src/schema/project.ts, apps/api/src/modules/projects/project-crud.service.ts, apps/dashboard/src/app/(dashboard)/projects
- **Dependencies:** None

### PR 5: Add atomic deploy leases, cancellation, and recovery

- **Description:** Replace `checkNoActiveBuild`’s TOCTOU with an atomic
  per-service (or per-project for single-app) deploy lease in the database
  (advisory lock or unique lease row). Same-SHA code deploys against the
  already-active release must dedupe and return the existing deployment.
  Cancellation must be cooperative and real: `runMountedRelease` (and the
  runtime path it shares) checks cancelled status before fetch, prepare,
  activate, and reload; a cancelled run must not flip `current` or set
  `activeReleaseDeploymentId`. Persist release phases and logs on the
  deployment/build-session rows, not only `session-manager` memory. On API
  boot, recover interrupted releases from persisted phase (resume or fail
  closed and restore previous pointer if activation was incomplete). Tests:
  two concurrent triggers, cancel-before-activate, restart-mid-prepare.
- **Files/components affected:** apps/api/src/modules/deployments/build.service.ts, apps/api/src/modules/deployments/mounted-release.service.ts, apps/api/src/modules/deployments/session-manager.ts, packages/db/src/schema/deployment.ts, packages/db/src/advisory-lock.ts, apps/api/src/index.ts
- **Dependencies:** PR 4

### PR 6: Instant retained rollback and first-release fallback

- **Description:** If a retained release tree for the target SHA still exists
  on disk, rollback is a pointer flip + reload + health, not another
  fetch/prepare. `restoreMountedRelease` must use that path. Keep
  fetch/prepare only when the tree is gone. First failed release must not
  delete `current` into a hole: refuse activation (or leave previous
  runtime-only state) when there is no known-good code pointer. Health
  failure after activate must restore the previous pointer and verify
  health again. Record rollback reason on the deployment. Tests: retained
  SHA flips without git fetch; first failure leaves previous serving.
- **Files/components affected:** apps/api/src/modules/deployments/mounted-release.service.ts, apps/api/src/modules/deployments/deployment.controller.ts, apps/api/src/modules/deployments/rollback
- **Dependencies:** PR 5

### PR 7: Type release filesystem resources and snapshot contracts

- **Description:** Stop storing host paths in `deployment.imageRef`. Add a
  typed release-resource field (or meta) distinguishing docker image vs
  filesystem release tree vs builder cache vs temp creds. Image GC must
  ignore filesystem paths. Cleanup must remove failed incoming trees,
  leftover builders (`openship-release-*`), temp auth dirs, and expired
  caches without touching `shared/` or the active/retained set. Snapshot
  the immutable release contract (config, service ID, shared paths, health,
  reload, SHA, runtime deployment id) onto the deployment at queue time;
  execution reads only the snapshot. After successful activation, mark the
  release tree read-only (`chmod -R a-w` or remount) except `shared/`
  targets. Tests: GC does not `docker rmi` a path; snapshot ignores later
  project config edits; shared paths remain writable.
- **Files/components affected:** apps/api/src/modules/deployments/mounted-release.service.ts, apps/api/src/modules/deployments/image-gc.ts, apps/api/src/modules/deployments/release-retention.ts, packages/db/src/schema/deployment.ts
- **Dependencies:** PR 4

### PR 8: Add signed OpenShip server agent

- **Description:** Introduce a tiny agent (container or daemon) that
  maintains a signed relationship with the local control plane, accepts
  release manifests, writes a durable operation journal, recovers
  interrupted pointer swaps/builders after agent restart, reports
  capabilities/version/disk/container state, and serializes resource-heavy
  builds (one at a time). Desktop/API remain the source of intent; the
  agent is the always-on executor on the server so cert renewal, backups,
  and health continue when the desktop is closed. Reuse existing job
  actions (`ssl:renew`, backup producers, health-watch, image GC) as
  agent-callable operations rather than inventing a second control plane.
  Include an enrollment/pairing flow and reject unsigned or replayed
  operations. Focused protocol tests; no production install required.
- **Files/components affected:** apps/agent, packages/adapters/src/runtime, apps/api/src/modules/jobs/job.registry.ts, apps/api/src/modules/servers, packages/db/src/schema
- **Dependencies:** PR 5, PR 7

### PR 9: Run certs, backups, and health on the agent

- **Description:** Move or dual-dispatch `ssl:renew`, scheduled backups,
  health-watch, and edge health so they execute on the agent journal when
  an agent is enrolled. Add public HTTPS health verification in addition to
  container-localhost probes (used by both code-release activation and the
  agent). Resource-controlled builder execution (memory/CPU already on
  config) must go through the agent’s single-build gate. First-class
  external/legacy upstream routes: mark them so cert tracking and edge
  health include them. If no agent is enrolled, keep today’s API-process
  jobs so self-hosted always-on installs do not regress.
- **Files/components affected:** apps/api/src/lib/ssl-scheduler.ts, apps/api/src/modules/jobs/job.registry.ts, apps/api/src/modules/deployments/mounted-release.service.ts, apps/api/src/modules/monitoring, apps/api/src/modules/domains, apps/agent
- **Dependencies:** PR 8

### PR 10: Fix migration honesty, edge takeover, and token leakage

- **Description:** Migration must not report success if stopping the old
  container failed. Rollback must not report success if restarting the
  source failed. Make scans incremental / cheaper (timeout-safe on a
  modest VPS). Imported services must not produce both placeholder and
  real rows — resolve by service identity (upstream `#584` already exists;
  close remaining import duplication). Detect bind-mount collisions with
  the generated release mount and fail with an actionable error. Edge
  takeover must protect existing management routes. Manually
  restored/external routes must stay in certificate tracking. Add a
  meaningful Docker health check to `apps/edge`. Stop putting git tokens
  in process arguments (GIT_ASKPASS / extraheader / env, never
  `https://x-access-token:TOKEN@...` in argv). Tests for success-gating
  and token-not-in-argv.
- **Files/components affected:** apps/api/src/modules/migration, packages/adapters/src/system/proxy, apps/edge/Dockerfile, packages/adapters/src/runtime, apps/api/src/modules/github/clone-auth.ts
- **Dependencies:** None

### PR 11: Build deterministic artifacts and release drivers

- **Description:** Add deterministic tar/zstd artifacts with SHA-256
  verification and provenance. Implement three drivers behind one
  interface: Git-prebuilt (current extract path), local-upload (build on
  the operator machine, upload, verify, switch), server-prepared
  (disposable builder + persistent caches). Finalize trees read-only.
  Lockfile-addressed dependency layers: when `composer.lock` (or
  equivalent) is unchanged, reuse the cached layer; when it changes,
  prepare then deploy code. Replace ad-hoc `mountedRelease` fields with a
  versioned release-manifest type stored on the deployment snapshot.
  Mounted-release remains the activation mechanism.
- **Files/components affected:** apps/api/src/modules/deployments, packages/adapters/src/archive.ts, packages/core/src/project-source.ts, packages/db/src/schema/project.ts
- **Dependencies:** PR 6, PR 7

### PR 12: Add Laravel, Next, Node, and Compose release presets

- **Description:** Presets that fill a release recipe: Laravel (PHP code
  release, Git-tracked compiled assets, Composer layer on lock change,
  migrate/optimize/reload as named phases), static Next (Git-prebuilt),
  Node (server-prepare or local artifact), Compose (stable service IDs +
  runtime rebuild when compose/Dockerfile changes). Wire presets into the
  planner so classification uses preset path prefixes and lockfiles.
  Advanced settings stay optional. Tests for each preset’s planner
  decisions.
- **Files/components affected:** packages/core/src/stacks.ts, apps/api/src/modules/deployments/release-planner.ts, apps/api/src/modules/deployments/presets, packages/core/src/openship-config
- **Dependencies:** PR 2, PR 11

### PR 13: Build operator release UI and recipe wizard

- **Description:** Replace the mounted-release settings pile with a short
  wizard: what runs, how runtime is installed, how code ships, what
  persists, how it is activated. Advanced settings (UID/GID, absolute
  paths, caches, builder, limits) stay collapsed. Project header shows
  combined live state (code SHA + strategy + age, runtime digest, server,
  public HTTPS) with Deploy latest and a More menu (specific commit,
  rebuild runtime, restart, roll back, terminal). Before deploy, show
  decision preview (code-only / runtime unchanged / no dependency install /
  expected interruption). Small release-spine visualization (Runtime +
  Code → live site). Activity timeline + actionable error summaries for
  failed releases. Operator edition only; do not add Cloud promotion
  chrome.
- **Files/components affected:** apps/dashboard/src/app/(dashboard)/projects, apps/dashboard/src/components/import-project, apps/dashboard/src/lib/api, apps/api/src/modules/deployments/deployment.routes.ts
- **Dependencies:** PR 3, PR 12

### PR 14: Make desktop a background control-plane host

- **Description:** Add `requestSingleInstanceLock`; a second launch focuses
  the first window and exits. Closing the window hides to tray; the
  embedded API/MCP stay up. Quit only from tray/menu. Prefer a stable
  gateway port; if fallback is required, surface it in the UI and refresh
  advertised MCP origin (do not silently invalidate OAuth audience). Show
  control-plane fingerprint, data path, and API endpoint in desktop,
  dashboard, and MCP initialize. List connected MCP clients and recent
  activity. Actions: Open in browser, restart engine, repair endpoint,
  back up control plane, open data folder. Atomic JSON writes (`tmp` +
  rename) for config, profiles, ports. Rename profiles to Browser sessions
  and move them out of Account, or remove them if the UI is simpler
  without. Main is the control plane, not a login.
- **Files/components affected:** apps/desktop/src/main/index.ts, apps/desktop/src/main/services.ts, apps/desktop/src/main/profile-store.ts, apps/desktop/src/main/menu.ts, apps/dashboard/src/components/desktop-chrome.tsx, apps/dashboard/src/components/desktop-profile-menu.tsx, apps/dashboard/src/app/(dashboard)/settings
- **Dependencies:** PR 1

### PR 15: Curate operator MCP tools and GitHub credentials

- **Description:** Add curated operator tool names listed in Wave 4. Long
  ops return `{ operationId }` immediately. Reads get a hard timeout.
  Generated REST tools remain under an advanced flag/prefix. Allow
  `spec.mcp.name` overrides so prompts can use stable names. GitHub is a
  Connection: browse as the connected identity, show which credential will
  actually be used for clone (deploy key / SSH / device / PAT), and test
  server clone access on save. No Cloud-forwarded GitHub App in Operator.
  Add an outer MCP execution deadline distinct from per-tool timeouts.
- **Files/components affected:** apps/api/src/modules/mcp/mcp-tools.ts, apps/api/src/modules/mcp/mcp-server.ts, apps/api/src/modules/mcp/mcp-dispatch.ts, apps/api/src/modules/mcp/mcp-prompts.ts, apps/dashboard/src/app/(dashboard)/settings/_components/GitHubConnection.tsx, apps/dashboard/src/app/(dashboard)/settings/_components/McpConnection.tsx, apps/api/src/modules/github
- **Dependencies:** PR 2, PR 14

### PR 16: Add operator recipes for Dashwood, Lake Forest, and AE

- **Description:** Check in versioned release recipes (no secrets, no
  absolute host paths) plus a runbook for the real move order: Dashwood
  pilot → Lake Forest artifact + SQLite backup preset → AE Public staging
  then production → AE Staff separately → Mail stays on immutable images.
  Recipes use Wave 3 presets. Include monorepo path filters so Public
  never rebuilds Staff/Mail. Export/import must round-trip these recipes.
  Do not perform live deploys or SSH to Contabo.
- **Files/components affected:** docs/operator-runbook.md, fixtures/operator-recipes, apps/api/src/modules/deployments/presets, packages/core/src/openship-config
- **Dependencies:** PR 12, PR 13

### PR 17: Delete the SaaS cloud and billing product

- **Description:** Remove Cloud connection, workspace promotion, billing,
  subscriptions, metering, promo codes, plan guards, hosted
  namespace/workspace, SaaS registration, waitlist/marketing-only Cloud
  surfaces, and Cloud-forwarded GitHub. Unmount and delete
  `modules/billing`, `modules/cloud` (saas + local), Stripe/Oblien master
  client, `plan-guard`, migrate-to-cloud, dashboard billing/CloudContext/
  waitlist/cloud-authorize. Keep organizations for local invites, audit,
  credentials, MCP, local GitHub, projects/servers/deployments/routes/
  certs/backups/terminals/migrations/jobs. Update grants so `billing` is
  gone. Leave a compile that no longer references `CLOUD_MODE` true
  branches except a hard fail if someone sets it. Operator edition is the
  only product.
- **Files/components affected:** apps/api/src/app.ts, apps/api/src/modules/billing, apps/api/src/modules/cloud, apps/dashboard/src/app/(dashboard)/billing, apps/dashboard/src/components/billing, apps/dashboard/src/context/CloudContext.tsx, packages/core/src/pricing, packages/core/src/access-grants.ts
- **Dependencies:** PR 13, PR 14, PR 15
