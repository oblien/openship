# Docker Swarm progress

Base commit: `50c04d6763f35f3654f8c765f2772e83d8b599a2` (`upstream/main`)

Branch: `feat/docker-swarm`

## S0.1: Pin the baseline, feature guardrails, and disposable test topology

Status: done
Commit: `7fe2af41`
Tests run:

- `bun install --frozen-lockfile` — passed with Bun `1.3.3`.
- `bun run build` — passed.
- `bun run test` — pre-existing failure: dashboard i18n parity reports
  `deploy: 90 missing (baseline 18)`. Turbo cancelled the remaining API and
  adapter tasks after that failure, so their aggregate result is not evidence
  for this feature.
- `docker version --format '{{.Server.Version}}'` — `29.5.3`.
- `docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}'`
  — `active true`.
- `scripts/swarm-lab.sh up && scripts/swarm-lab.sh deploy && scripts/swarm-lab.sh status`
  — passed; manager and worker converged the replicated, global, stateful, and
  externally routed fixture services.
- `scripts/swarm-lab.sh cleanup && scripts/swarm-lab.sh down` — passed; only
  test-namespaced resources were removed.
- `bun --cwd apps/api vitest run test/modules/health-env-authmode.test.ts` —
  passed (6 tests; test process reports an unrelated local Redis connection
  warning).
- `bun --cwd packages/adapters vitest run src/runtime/swarm/test-helpers.test.ts`
  — passed (2 tests).
- `bun run --cwd apps/api lint`, `bun run --cwd packages/adapters lint`, and
  `bunx tsc --noEmit -p apps/dashboard/tsconfig.json` — passed.

Evidence:

- `OPENSHIP_EXPERIMENTAL_SWARM` is centrally parsed, defaults off, and its
  resolved value is returned to the dashboard boot capability response.
- The disposable nested-Docker lab, read-only task helpers, and a
  namespace-scoped cleanup command are available under `fixtures/swarm/`,
  `packages/adapters/src/runtime/swarm/`, and `scripts/swarm-lab.sh`.

Blockers:

- The dashboard's existing locale-parity failure must remain distinguishable
  from Swarm regressions. It is outside this story's scope.

Next:

- Prevent container-level adoption and Edge takeover actions on Swarm task
  containers (S0.2).

## S0.2: Make container migration and Edge takeover Swarm-aware

Status: done
Commit: recorded in repository history
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/ownership.test.ts test/docker-container-status.test.ts src/system/proxy/detect.test.ts` — passed (30 tests).
- `bun --cwd apps/api vitest run test/modules/migration/docker-inspect.test.ts` — passed (9 tests).
- `bun run --cwd packages/adapters lint`, `bun run --cwd apps/api lint`, and
  `bunx tsc --noEmit -p apps/dashboard/tsconfig.json` — passed.
- `scripts/swarm-lab.sh up && scripts/swarm-lab.sh deploy && scripts/swarm-lab.sh compose-proxy && scripts/swarm-lab.sh status && scripts/swarm-lab.sh cleanup && scripts/swarm-lab.sh down` — passed. The nested manager ran a Swarm Traefik task on `*:80->80/tcp` and a separate ordinary Compose Traefik on `:18080`; cleanup removed only fixture resources.

Evidence:

- Docker task labels become a typed ownership discriminator on container
  summaries and inspections. Migration discovery reports them separately and
  prevents them entering the standalone adoption path before inspection or
  image reads.
- Edge port probing recognizes Swarm ingress ownership from the manager's
  service table, names the owning stack/service, and refuses the legacy
  container-level takeover with `SWARM_SERVICE_OWNED` before any executor
  command is issued.
- A read-only check against the local Docker daemon classified an existing
  Swarm task with live service and task IDs, without changing it.

Next:

- Publish the tracker and draft review slice (S0.3), then begin the durable
  orchestration domain model.

## S0.3: Publish implementation intent

Status: done

- Tracking issue: [#316 — Docker Swarm stack-native deployment support](https://github.com/oblien/openship/issues/316)
- Draft review slice: [#317 — feat(swarm): establish safe stack-native foundation](https://github.com/oblien/openship/pull/317)
- Related operator safety issue: [#311](https://github.com/oblien/openship/issues/311)
- Related clustering/storage roadmap context: [#163](https://github.com/oblien/openship/issues/163)

The draft contains the tested S0.1–S0.2 foundation. Work continues without
waiting for review.

## S1.1: Orchestrator discriminator and typed workload identities

Status: done
Commit: `2a3ad566`
Tests run:

- `bun run --cwd packages/core lint && bun run --cwd packages/core test -- runtime-identity.test.ts` — passed (4 tests).
- `bun run --cwd apps/api lint` and `bunx tsc --noEmit -p apps/dashboard/tsconfig.json` — passed.
- `bun --cwd apps/api vitest run src/lib/deployment-runtime-read.test.ts src/modules/deployments/build-execution-plan.test.ts src/modules/projects/project.schema.test.ts` — passed (21 tests).

Evidence:

- `RuntimeMode` remains `bare | docker`; `OrchestratorMode` is threaded through
  projects, deployment snapshots, platform resolution, API payloads, and the
  dashboard.
- Invalid Swarm/bare and Swarm/cloud combinations fail before runtime resolution.
- Typed workload/service refs parse complete Swarm identities and preserve the
  legacy Docker, bare, and cloud `containerId` conventions.

Next:

- Persist stack/revision/registry state and complete the container-ID
  compatibility audit.

## S1.2: Swarm stack, revision, and registry persistence

Status: done
Commit: `ec9fa4e3` (schema/repositories), `32448914` (service projections)
Tests run:

- `bun run --cwd packages/db lint` — passed.
- `bun --cwd packages/db vitest run src/repos/swarm-persistence.repo.test.ts src/migrations-additive.test.ts src/dump.test.ts` — passed (17 tests).

Evidence:

- Migration `0073_add_swarm_persistence.sql` adds project orchestration,
  typed runtime refs, stack/revision/registry tables, indexes, ownership FKs,
  and dump redaction.
- Stack and registry repositories are organization-scoped. Revisions are
  immutable/monotonic; registry credentials and source/rendered YAML use only
  encrypted fields.

Next:

- Finish every container-only lifecycle guard (S1.3), then begin the manager
  adapter probe.

## S1.3: Compatibility-safe runtime reference usage

Status: done
Commit: `4142f26c`
Tests run:

- `bun --cwd apps/api vitest run src/lib/deployment-runtime-read.test.ts` — passed (8 tests).

Evidence:

- `docs/swarm/CONTAINER-ID-AUDIT.md` classifies the legacy-ID surface.
- Runtime and service lifecycle resolution reject Swarm before any container
  runtime or fallback provisioning path is selected.
- Project/deployment cleanup represents a Swarm stack as an inert manifest
  entry; record deletion cannot remove a live stack.

Next:

- Complete Swarm service projections, then begin the manager adapter probe.

## S1.4: Swarm service projections

Status: done
Commit: `32448914`
Tests run:

- `bun --cwd packages/db vitest run src/repos/swarm-persistence.repo.test.ts` — passed (3 tests).

Evidence:

- A Swarm service is keyed by its source service name, not an observed Docker
  service ID. Recreate updates that observed state in place, while source
  removal marks the projection removed without erasing history.

Next:

- Implement the manager adapter probe and discovery read models (S2.1–S2.4).

## S2.1: Swarm manager adapter probe

Status: done
Commit: `4ab7fdd7`
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/runtime.test.ts` — passed.

Evidence:

- `SwarmRuntime` verifies Engine/cluster identity through bounded manager probes
  and returns stable inactive, worker-required, invalid-info, and unavailable
  failures without leaking connection credentials.

## S2.2: Resolve a manager-backed Swarm platform

Status: done
Commit: `d701da3b`
Tests run:

- `bun --cwd packages/adapters vitest run src/platform.swarm.test.ts` — passed.

Evidence:

- Local and SSH targets retain Docker for image builds while exposing a verified
  `stackRuntime`; Swarm status avoids Edge/system provisioning by default.

## S2.3: Read-only normalized manager discovery

Status: done
Commit: `404175f0`
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/normalize.test.ts src/runtime/swarm/runtime.test.ts` — passed.

Evidence:

- Discovery returns bounded nodes, stacks, services, tasks, overlay networks,
  volumes, config metadata, and secret metadata. It intentionally never runs
  `docker secret inspect` or otherwise reads secret contents.

## S2.4: Service and stack convergence semantics

Status: done
Commit: `cc720896`
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/health.test.ts` — passed.

Evidence:

- Health picks current tasks rather than historical attempts, handles global
  services and zero replicas, and distinguishes scheduler failures from an
  unreachable manager.

## S2.5: Authorized read-only Swarm API

Status: done
Commit: current milestone
Tests run:

- `bun run --cwd apps/api lint` and `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd apps/api vitest run src/modules/swarm/swarm.service.test.ts` — passed (4 tests).

Evidence:

- Self-hosted `/api/swarm/:serverId/*` routes require `server:read`, resolve the
  server within the caller organization, are unavailable when the experimental
  flag is off, and return stable manager failure codes.
- The endpoints expose only probe/discovery views, cache repeated dashboard
  polling briefly, avoid MCP registration, and never fetch secret payloads or
  expose a generic Docker command endpoint.

Next:

- Model authoritative repository, inline, and observed stack sources (S3.1).

## S3.1: Authoritative repository, inline, and observed sources

Status: done
Commit: pending
Tests run:

- `bun run --cwd packages/db lint`, `bun run --cwd apps/api lint`, and
  `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd packages/db vitest run src/repos/swarm-persistence.repo.test.ts src/migrations-additive.test.ts` — passed (6 tests).
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-source.model.test.ts` — passed (3 tests).

Evidence:

- Stack sources distinguish repository, encrypted inline, and adopted observed
  variants. Repository source preserves compose-file order plus branch/commit;
  adopted state remains non-deployable.
- `source_version` provides organization-scoped optimistic editing, and normal
  API DTOs expose only source presence/digest metadata—not inline YAML.
- `GET/POST/PUT /api/projects/:id/swarm/source` is project-authorized,
  feature-gated, and validates/records source without invoking Docker.

Next:

- Build a lossless source projection and Swarm compatibility parser (S3.2).

## S3.2: Lossless source document projection

Status: done
Commit: pending
Tests run:

- `bun run --cwd packages/core lint`, `bun run --cwd apps/api lint`, and
  `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd apps/api vitest run test/lib/compose-parser.test.ts src/modules/swarm/swarm-stack-projection.test.ts` — passed (44 tests).

Evidence:

- The Swarm projection extracts service image/build, deploy mode/replicas,
  placement/resources/update/restart policy, endpoint, labels, ports,
  networks, volumes, configs, and secret references from ordered source files.
- It is a read-only derived view; extensions and all other original YAML remain
  in the untouched source document. Inline edits synchronize projection rows
  by source service name without regenerating source YAML.
- The compatibility report identifies build/registry requirements and Compose
  settings whose behavior does not carry into Swarm, with remediation text.

Next:

- Constrain every source-side file reference to a staging root (S3.3).

## S3.3: Confined stack source file access

Status: done
Commit: pending
Tests run:

- `bun run --cwd apps/api lint` and `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-source-confinement.test.ts` — passed (3 tests).

Evidence:

- One reviewed helper resolves compose documents, build contexts/Dockerfiles,
  env files, config/secret files, and permitted bind sources below a realpath
  staging root. Traversal, absolute paths, control characters, missing files,
  and symlink escapes fail before any Docker operation.
- Per-file, aggregate, YAML, and resource-count limits bound parsing and source
  reads. Errors identify only the bad field/path class, never file contents.

Next:

- Render ordered documents through `docker stack config` with explicit
  interpolation controls (S3.4).

## S3.4: Manager-side stack render and validation

Status: done
Commit: pending
Tests run:

- `bun run --cwd packages/adapters lint`, `bun run --cwd apps/api lint`, and
  `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd packages/adapters vitest run src/runtime/swarm/runtime.test.ts` — passed (7 tests).

Evidence:

- `StackRuntimeAdapter.renderStack()` stages a bounded file set in a 0700
  manager temp directory, invokes `docker stack config` with ordered files plus
  generated ownership labels, uses an explicit `env -i` interpolation map, and
  removes the directory on success and failure.
- Rendered YAML receives deterministic newline canonicalization and SHA-256
  digesting; Docker warnings are captured separately from hard typed errors.
- The project source render endpoint currently validates encrypted inline
  documents and returns only digest/warnings. It does not return raw rendered
  YAML before redaction is implemented, and repository source is safely held
  pending full-tree staging.

Next:

- Redact rendered material and compute semantic live-state previews (S3.5).

## S3.5: Redacted semantic stack previews

Status: done
Commit: pending
Tests run:

- `bun run --cwd packages/adapters lint`, `bun run --cwd apps/api lint`, and
  `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-preview.test.ts` — passed (3 tests).

Evidence:

- Render previews structurally redact sensitive environment values, token/key
  labels, inline config/secret content, private-key material, and interpolation
  values in warnings while retaining safe reference names.
- Desired projections compare to live service state and classify stack create,
  service add/remove, image, mode/replica, placement/resource, network/port,
  config/secret reference, and label/routing changes.
- A preview emits redacted rendered YAML, stable digest metadata, explicit
  non-comparable notices, and a deterministic no-op only when both desired and
  observed state digests are unchanged.

Next:

- Expand compatibility and storage preflight into hard blockers and
  remediation-bearing warnings (S3.6).

## S3.6: Swarm compatibility and storage preflight

Status: done
Commit: pending
Tests run:

- `bun run --cwd apps/api lint` and `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-compatibility.test.ts src/modules/swarm/swarm-preview.test.ts` — passed (5 tests).

Evidence:

- Missing external networks, volumes, configs, and secrets are apply blockers;
  source-built services without a configured OCI registry are blocked too.
- Local named-volume movability, unsupported service-log drivers, job modes,
  and Compose-to-Swarm behavior gaps are remediation-bearing warnings. Existing
  manager metadata is used by name only—no config/secret content is read.
- The render preview endpoint returns this typed compatibility report alongside
  redacted output and never mutates a stack.

Next:

- Deliver side-by-side stack discovery and observe-mode import (Phase 4).

## S4.1: Stack-first discovery namespaces

Status: done
Commit: pending
Tests run:

- `bun run --cwd apps/api lint` and `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-discovery-view.test.ts` — passed.

Evidence:

- `/api/swarm/:serverId/stacks` returns deterministic stack cards built from
  Docker's namespace labels, with current service health/tasks/nodes and safe
  network/config/secret metadata. Standalone Swarm services are separate.
- Portainer labels are display-only metadata; OpenShip does not rely on them to
  operate a workload. Explicitly marked OpenShip control-plane services are
  excluded from browse results.

Next:

- Import live stacks as organization-scoped observe-only projects (S4.2).

## S4.2: Observe-only live stack import

Status: done
Commit: pending
Tests run:

- `bun run --cwd packages/db lint`, `bun run --cwd apps/api lint`, and
  `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd packages/db vitest run src/repos/swarm-persistence.repo.test.ts src/migrations-additive.test.ts` — passed (6 tests).
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-observe.service.test.ts` — passed (3 tests).

Evidence:

- `POST /api/swarm/:serverId/stacks/:stackName/observe` re-discovers manager
  truth, then records a Docker-runtime/Swarm-orchestrator project, `observe`
  stack binding, redacted live-state digest, and service projections only.
- Repeating import is idempotent. A global cluster/name uniqueness constraint
  and an IDOR-safe conflict prevent a different organization from binding the
  same live stack.
- The import has no source revision or stack apply path, writes an audit event
  only for OpenShip metadata, and exposes no Swarm mutation capability.

Next:

- Refresh observed bindings and surface source-link/drift status (S4.3).

## S4.3: Observed drift and source-link status

Status: done
Commit: pending
Tests run:

- `bun run --cwd packages/core lint`, `bun run --cwd packages/db lint`,
  `bun run --cwd apps/api lint`, and `bunx tsc --noEmit -p apps/api/tsconfig.json` — passed.
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-observation.service.test.ts` — passed (3 tests).
- `bun --cwd packages/db vitest run src/repos/swarm-persistence.repo.test.ts src/migrations-additive.test.ts` — passed (6 tests).

Evidence:

- Source bindings now communicate `missing`, `linked-unvalidated`, `valid`, or
  `invalid`; rendering advances a linked source to valid without entering
  managed mode.
- Project observation endpoints report the state and refresh manager truth on
  demand. Refresh stores only redacted state/digest metadata and updates
  projections, marking external changes as drift and connection loss as
  unreachable.
- A manager that now identifies a different cluster causes a stable mismatch
  error rather than silently rebinding a project.

Next:

- Build the feature-gated observe-mode dashboard flow (S4.4).

## S4.4: Observe-mode dashboard flow

Status: done
Commit: 12a1a682
Tests run:

- `bunx tsc --noEmit -p apps/api/tsconfig.json` and
  `bunx tsc --noEmit -p apps/dashboard/tsconfig.json` — passed.
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-observation.service.test.ts`
  — passed (3 tests).
- `bun --cwd apps/dashboard vitest run src/i18n/i18n-parity.test.ts` — known
  pre-existing failure: `deploy` reports 90 missing locale keys against a
  baseline of 18; this change adds no locale keys.

Evidence:

- The server page shows a Docker Swarm capability tab only when the API's
  experimental feature flag is enabled. It presents manager identity, health,
  node and stack counts, stack-first discovery, standalone services, and
  service/task/node detail from read-only discovery endpoints.
- Import has an explicit confirmation that it saves only OpenShip observation
  metadata and makes no Docker or Portainer workload changes. Imported stacks
  open in a dedicated observed-project page instead of the standard deployment
  shell.
- The observed-project view labels the stack read-only, presents source and
  drift status, offers a safe refresh, and deliberately omits workload,
  source, routing, and deletion mutations while explaining why an external
  controller remains the writer.

Next:

- Record reproducible Docker-event evidence for repeated observe-mode polling,
  import, refresh, and source validation (S4.5).

## S4.5: Zero-mutation coexistence proof

Status: done
Commit: 58df87d0
Tests run:

- `sh -n scripts/swarm-lab.sh` and TypeScript checks for `apps/api` and
  `packages/adapters` — passed.
- `scripts/swarm-lab.sh up`, `scripts/swarm-lab.sh deploy`, and
  `scripts/swarm-lab.sh observe-proof` — passed against the disposable nested
  manager and worker on July 30, 2026.

Evidence:

- `observe-proof` records manager Docker events around two probe/discovery
  passes, initial and idempotent observe import, two observation refreshes,
  inline source validation, and Docker-native `stack config` rendering.
- The run completed with no create, update, remove, or task lifecycle event
  for services, task containers, networks, configs, secrets, or volumes. Its
  JSON event capture was retained in the system temporary directory by the
  harness for immediate inspection.
- The proof uses the labelled Docker-in-Docker fixture and in-memory OpenShip
  persistence only. It does not contact a non-lab manager or a developer DB.

Next:

- Complete Gate A review, then begin the prebuilt-image managed stack apply
  path (Phase 5).

## Gate A: Safe read-only evaluation

Status: passed

The manager probe rejects inactive and worker endpoints; Swarm task ownership
is excluded from container migration and proxy takeover; labeled stack
discovery and observed import are feature-gated; authoritative source can be
linked, rendered, redacted, and compared; and the disposable lab has recorded
an event-clean repeated-observation run. The next slice is the managed,
prebuilt-image stack apply path. Portainer remains an external writer until a
future explicit claim flow is implemented.

## S5.1–S5.4: Managed prebuilt stack deployment

Status: done
Commit: 7b405091
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/normalize.test.ts src/runtime/swarm/runtime.test.ts` — passed (11 tests).
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-stack-projection.test.ts src/modules/deployments/swarm/deploy.service.test.ts src/modules/swarm/swarm-management.service.test.ts src/modules/swarm/swarm-stack.service.test.ts` — passed (13 tests).
- TypeScript checks for `packages/core`, `packages/adapters`, `packages/db`, and `apps/api` — passed.
- `scripts/swarm-lab.sh up`, `scripts/swarm-lab.sh managed-proof`,
  `scripts/swarm-lab.sh cleanup`, and `scripts/swarm-lab.sh down` — passed
  against the disposable nested manager and worker on July 30, 2026.

Evidence:

- The normal deployment lifecycle now branches into a stack-specific executor
  before any container/Compose cleanup path. It persists an encrypted,
  redacted pre-apply revision, applies only the Docker-rendered document with
  `--resolve-image always`, reconciles manager truth, and stores stack and
  per-service runtime references in normal deployment history.
- Connection loss during or after Docker's command produces `reconciling` and
  leaves the cluster untouched. A deterministic CLI failure is persisted as a
  useful failed deployment and revision state.
- New bindings prove the namespace is absent. Existing stacks remain observe
  only until a typed-name, current-live-digest claim; the first accepted apply
  verifies OpenShip labels before setting `managed`. Release Management returns
  to observe-only without stopping workloads.
- Prune requires a managed, labeled candidate in the same stack namespace.
  Its removal intent is recorded in logs and sanitized revision metadata;
  unlabelled services block the deploy. Service rows stay keyed by source name,
  retain history on removal, and carry secret-safe environment-key,
  healthcheck, and rendered-source-digest metadata.
- The two-service lab harness completed two real applies with stable current
  task IDs on the second one. It created two immutable revision records and
  stack/service refs in its in-memory persistence, exercising the production
  manager adapter rather than a mocked Docker command.

Next:

- Build durable convergence polling, reconciliation pickup, and structured
  managed-stack drift classification (Phase 6).

## S6.1–S6.4: Convergence, reconciliation, and drift

Status: done
Commit: `e8bc3cb6`
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/health.test.ts src/runtime/swarm/normalize.test.ts` — passed (6 tests).
- `bun --cwd apps/api vitest run src/modules/deployments/swarm/convergence.service.test.ts src/modules/deployments/swarm/reconcile.service.test.ts src/modules/deployments/swarm/deploy.service.test.ts src/modules/swarm/swarm-drift.test.ts src/modules/swarm/swarm-observation.service.test.ts` — passed (20 tests).
- TypeScript checks for `apps/api`, `packages/adapters`, and `packages/db` — passed.
- `scripts/swarm-lab.sh up`, `scripts/swarm-lab.sh managed-proof`,
  `scripts/swarm-lab.sh cleanup`, and `scripts/swarm-lab.sh down` — passed
  against the disposable nested manager and worker on July 30, 2026.

Evidence:

- Managed applies now poll structured service/task health with configured
  timeout and cadence. Replicated, global, and job state account for current
  tasks only, scheduler updates/rollbacks, and completed jobs; the bounded
  timeout leaves a live stack `reconciling` for later observation.
- `reconciling` Swarm deployments bypass every container operation. The durable
  stack revision, labels, normalized service specs, service IDs, task health,
  and image references determine the final result without reissuing a deploy.
  Manager loss stays pending; externally changed specs become explicit drift.
- Managed refresh compares sanitized canonical revision projections rather
  than task history and classifies image, replica/mode, environment-key, mount,
  network, port, label, placement/resource, config/secret, and service-set
  changes. Docker-generated labels, implicit default networks, resolved image
  digests, and generated placement fields are ignored.
- The `swarm:refresh` system job groups bound managed stacks by manager,
  discovers each group once, backs off unavailable managers, and retains the
  last successful timestamp. The existing on-demand refresh uses the same
  comparator and remains read-only.
- The disposable proof now performs two identical real applies, then executes
  a third real apply whose accepted response is deliberately withheld. Its
  recovery path settles `ready` from manager state alone and confirms task IDs
  were unchanged.

Next:

- Implement routine managed service and stack operations (Phase 7).

## S7.1–S7.5: Managed day-two operations and dashboard

Status: done
Commit: pending
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/runtime.test.ts src/runtime/swarm/normalize.test.ts src/runtime/swarm/health.test.ts` — passed (17 tests).
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-operations.service.test.ts src/modules/swarm/swarm-observation.service.test.ts` — passed (18 tests).
- TypeScript checks for `packages/adapters`, `apps/api`, and `apps/dashboard` — passed.
- `scripts/swarm-lab.sh up`, `scripts/swarm-lab.sh managed-proof`, and
  `scripts/swarm-lab.sh operations-proof` — passed against the disposable
  nested manager and worker on July 30, 2026.

Evidence:

- Managed, organization-scoped endpoints scale owned replicated services from
  zero to 10,000 replicas, optionally persist a valid inline-source replica
  target, and reject global/job/unowned services before a Docker command.
  Force restart retains the service ID and existing Swarm update policy while
  convergence reports a terminal or reconciling result.
- Service and task logs are manager-scoped and bounded. They support tail,
  since, timestamps, task scope, and cancellable SSE follow; Docker log-driver
  limitations are actionable. Source-known sensitive environment values and
  common credential-shaped output are redacted before browser delivery.
- Removal requires the exact stack name, managed labels on every service, and
  manager cluster identity. `docker stack rm` is used only after refusing
  stack-owned configs/secrets that Docker would delete; volumes and external
  resources are never coupled to cleanup. An accepted removal with a lost
  response records `reconciling` and later observation settles absence without
  repeating the destructive command.
- The project dashboard now exposes service/task logs, task scope, follow/stop,
  inspect detail, scale, restart, and guarded removal. It retains read-only
  log/inspect access for observed stacks and hides all writers there.
- The disposable proof observed the worker heartbeat through service and task
  logs, cancelled a live follow stream, and confirmed its external config and
  secret remained after managed-stack removal.

Next:

- Begin observed-stack adoption and deliberate claim comparison (Phase 8).

## S8.1–S8.4: Side-by-side adoption, claim, and reversible handoff

Status: done
Commit: pending
Tests run:

- `bun --cwd apps/api vitest run src/modules/swarm/swarm-source.service.test.ts src/modules/swarm/swarm-management.service.test.ts src/modules/deployments/swarm/deploy.service.test.ts` — passed (12 tests).
- `bunx tsc --noEmit -p apps/api/tsconfig.json` and
  `bunx tsc --noEmit -p apps/dashboard/tsconfig.json` — passed.

Evidence:

- Observed projects now have a source-and-management panel beside their live
  health/log views. It makes Docker's lossy source limitation explicit, accepts
  encrypted inline YAML or selects a GitHub repository plus bounded paths, and
  renders only on an explicit review request. Linking source on a Swarm project
  forces `autoDeploy` off and registers no deploy webhook, preserving the
  explicit claim as the first-writer gate.
- Repository render/apply reads only the configured project repository at the
  selected commit or branch. Compose paths and referenced config, secret, and
  environment files are confined to the declared source root, byte/file-count
  bounded, copied only to the manager's private render stage, and never
  persisted or logged as plaintext.
- The review shows redacted rendered YAML, semantic change classes, warnings,
  blockers, and a fresh live digest. Claim requires a typed stack name, refuses
  a stale digest, calls out deletion/storage/network risks, and queues the
  standard stack deployment path. First claim still suppresses prune and only
  flips to `managed` after label and convergence verification.
- A managed stack can export a secret-safe controller handoff before a typed
  release action. Release stops all future OpenShip writes without stopping
  workloads or stripping labels; the export includes inline source only in the
  admin response, redacted override metadata, revision digest, and explicit
  external config/secret handoff notes. Handoff export and release both audit
  metadata only.

Next:

- Add encrypted OCI registry credentials and the source-build image
  publish/digest workflow (Phase 9).

## S9.1: Encrypted OCI registry credentials

Status: done
Commit: pending registry/source-build milestone
Tests run:

- `bun --cwd apps/api vitest run src/modules/registries/registry.service.test.ts` — passed (2 tests).
- TypeScript checks for `apps/api` and `apps/dashboard` — passed.

Evidence:

- The existing organization-scoped registry table now has a complete safe API:
  list/create/update/delete/test. Credential writes use the established
  encryption envelope; every read returns a `hasCredentials` flag only.
- Registry hosts and repository prefixes are normalized before persistence.
  Connection checks use a bounded V2 request and the standard bearer-token
  challenge where needed. Tokens and credential responses stay in-process and
  generic outcomes only reach API/audit/dashboard surfaces.
- The observed-stack dashboard now supports creating, editing, testing,
  selecting, and detaching an organization registry. Credentials are write-only
  and never rendered after save. Registry attachment validates complete login
  pairs and does not touch running services.

Next:

- Complete per-service build-record status fan-out for source-build failures.

## S9.2–S9.5: Digest publication, manager auth, source builds, and smart selection

Status: done
Commit: pending registry/source-build milestone
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/runtime.test.ts src/runtime/docker-registry.test.ts` — passed (13 tests).
- `bun --cwd apps/api vitest run src/modules/deployments/swarm/deploy.service.test.ts src/modules/swarm/swarm-source.service.test.ts` — passed (12 tests).
- `bun --cwd packages/db vitest run src/repos/swarm-persistence.repo.test.ts src/migrations-additive.test.ts` — passed (7 tests).
- TypeScript checks for `packages/adapters`, `packages/db`, `apps/api`, and `apps/dashboard` — passed.
- `scripts/swarm-lab.sh up`, `scripts/swarm-lab.sh registry-proof`,
  `scripts/swarm-lab.sh cleanup`, and `scripts/swarm-lab.sh down` — the proof
  worker was observed running the manager-published private-registry digest on
  July 30, 2026. The command-stream wrapper dropped its final nested-BuildKit
  cell, so this is retained as task-state evidence rather than a clean shell
  transcript.

Evidence:

- Docker publication tags a built image deterministically under
  `<registry>/<namespace>/<project>/<service>:<deployment>`, pushes using
  Dockerode in-memory credentials where available, retries only transient
  transport/rate-limit failures, resolves `repo@sha256`, and removes only the
  temporary tag after that digest is known. Registry output is reduced to safe
  progress milestones.
- The Swarm adapter writes a standard Docker `config.json` only under its
  `umask 077` manager stage, prefixes the deploy with its temporary
  `DOCKER_CONFIG`, adds `--with-registry-auth` only for a complete configured
  login, and removes the stage on success or failure. No permanent manager
  Docker config is changed.
- Repository-backed `build:` services are built on the selected manager’s
  Docker runtime through its shared clone/transfer batch, published, and
  supplied to `docker stack config` through a generated digest-image override.
  Per-service rows record building, skipped, publication failure, and eventual
  live Swarm runtime states without duplicate inserts. Prebuilt services are
  retained unchanged. Inline source with `build:` is refused because it cannot
  supply a bounded cloneable build context.
- Webhook deployments with an exact, non-truncated changed-path set reuse a
  previous digest only for source-built services whose independent contexts are
  unchanged. Compose edits, shared/unknown paths, missing digests, force-all,
  and truncated path sets rebuild conservatively.

Next:

- Define and validate the explicit OpenShip Edge topology (S10.2–S10.5).

## S10.1: External routing is explicit and non-mutating

Status: done
Commit: pending Phase 10.1 milestone
Tests run:

- `bun --cwd apps/api vitest run src/modules/swarm/swarm-routing-labels.test.ts src/modules/swarm/swarm-source.model.test.ts src/modules/swarm/swarm.service.test.ts` — passed (10 tests).
- `bun --cwd packages/adapters vitest run src/platform.swarm.test.ts` — passed (1 test).
- TypeScript checks for `apps/api` and `apps/dashboard` — passed.

Evidence:

- New bindings and imported stacks persist `routingMode = external`; the safe
  source DTO now makes that mode visible to the dashboard.
- Swarm platform resolution uses a no-op routing/TLS provider, so ordinary
  stack inspection, claim, deploy, and service lifecycle work do not bind
  ports 80/443, provision an Edge, or change router/TLS state.
- Live-stack detail strips general service labels and returns only recognised
  router labels, with credential-shaped values redacted and bounded. The
  dashboard identifies external routing, shows those labels as read-only
  inspection metadata, and offers only syntactically safe inferred HTTPS URLs.

## S10.2: Explicit OpenShip Swarm Edge topology

Status: done
Commit: pending Phase 10.2 milestone
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/edge.test.ts src/platform.swarm.test.ts` — passed (7 tests).
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-edge.service.test.ts src/modules/swarm/swarm.service.test.ts` — passed (7 tests).
- TypeScript checks for `packages/adapters` and `apps/api`, plus `sh -n scripts/swarm-lab.sh` — passed.
- `scripts/swarm-lab.sh up && scripts/swarm-lab.sh edge-proof` — the shell
  wrapper again omitted its final nested-Docker output, but direct manager
  inspection confirmed the Edge task running on the labelled manager, proxying
  through its overlay to the worker backend, and retaining a certificate-volume
  marker across a forced task replacement. `cleanup && down` then passed.

Evidence:

- `SwarmEdgeManager` creates a labelled, non-attachable cluster overlay and a
  one-replica Edge service with deliberate host 80/443 publication, an explicit
  `openship.edge.ingress=true` placement constraint, and persistent sites,
  ACME, and certificate volumes. It discovers current task IDs from manager
  truth after rescheduling rather than retaining a task container identity.
- Edge enablement is an explicit `server:write` API action, separate from every
  stack claim/deploy operation; its read endpoint exposes current service/task
  state. It rejects a missing ingress label, a foreign `openship-edge` service,
  and any other Swarm service already owning 80/443.
- [ADR-001](ADR-001-openship-swarm-edge.md) records the one-ingress-node
  persistence and failure behavior, plus the path to HA without app-stack
  rewrites.

Next:

- Attach only explicitly exposed managed services to the Edge overlay and
  compile their stable Swarm service-DNS routes (S10.3–S10.4).

## S10.3: Opt-in routing overlay attachments

Status: done
Commit: pending Phase 10.3 milestone
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/runtime.test.ts src/runtime/swarm/edge.test.ts` — passed (18 tests).
- `bun --cwd apps/api vitest run src/modules/swarm/swarm-edge-routing.test.ts src/modules/swarm/swarm-source.service.test.ts src/modules/deployments/swarm/deploy.service.test.ts` — passed (14 tests).
- TypeScript checks for `packages/adapters`, `apps/api`, and `apps/dashboard` — passed.

Evidence:

- `openship-edge` mode is a claim-gated, metadata-only project setting. Selecting
  it neither creates an Edge nor mutates another router; the dashboard makes
  the separate Edge-enable requirement clear.
- Stack rendering accepts generated network attachments and external network
  declarations in its immutable override. It leaves source files untouched and
  emits attachments only for enabled Swarm service rows explicitly marked
  exposed.
- Each exposed service gets the cluster-owned `openship-edge` network and its
  full `<stack>_<service>` Swarm DNS alias. Deployment verifies that an explicit
  Edge and its overlay exist before applying any such attachment, and rejects
  malformed/missing target ports before mutation.

## S10.4: Route OpenShip domains to Swarm service DNS

Status: done
Commit: `2f74f30a`
Tests run:

- `bun --filter @repo/adapters test src/runtime/swarm/edge-routes.test.ts` —
  passed (3 tests).
- `bun --filter @repo/api test src/modules/swarm/swarm-edge-routes.test.ts src/modules/swarm/swarm-edge-ssl.test.ts src/modules/deployments/swarm/deploy.service.test.ts`
  — passed (15 tests).
- `bun run --cwd packages/adapters lint` and `bun run --cwd apps/api lint` —
  passed.
- `scripts/swarm-lab.sh up && scripts/swarm-lab.sh edge-proof` — passed on
  July 30, 2026. The nested wrapper omitted its final line, so direct manager
  checks additionally verified both worker-proxied hostnames and the immutable
  config mount; `cleanup && down` passed afterward.

Evidence:

- A vhost is a bounded, immutable Docker config mounted into `openship-edge`.
  Route updates use `docker service update --config-add/--config-rm`, never
  `docker exec` against a scheduler-owned task. Replacement configs are
  removed only after the service update converges; foreign config mounts are
  refused.
- Route targets are derived solely from the validated `<stack>_<service>` DNS
  identity and explicit container port. Existing domain/service rows remain
  the ownership source of truth. A source service removal removes its retained
  route projection; a route failure leaves the healthy stack running and emits
  the existing routing-action-required deployment warning.
- The existing certificate workflow resolves a Swarm project/domain to that
  fixed route. ACME runs in a short-lived, ingress-pinned certbot task sharing
  only the Edge ACME/certificate volumes; a separate pinned inspection task
  reads certificate metadata. Manual certificate upload stays explicitly
  unsupported for Swarm Edge until a revision-safe secret/config transport is
  introduced.
- The lab additionally proves a route config update after an Edge task
  replacement: both the original and newly mounted hostnames reach the worker,
  while the persistent certificate marker remains available.

Next:

- Implement explicit reversible router cutover planning and verification
  (S10.5), then deterministic rollback revisions (S11.1).
