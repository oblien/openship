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
Commit: pending
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
