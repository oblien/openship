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
