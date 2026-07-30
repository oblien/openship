# Docker Swarm requirements audit

This is a current-state index for the implementation plan. It maps every
story-level deliverable to source, deterministic tests, or a disposable
manager/worker proof. It is deliberately not a replacement for operator review:
the manager connection remains root-equivalent authority and a production stack
must be claimed by its operator.

| Plan requirement     | Current implementation evidence                                                                                                                              | Primary verification                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| S0.1                 | `OPENSHIP_EXPERIMENTAL_SWARM`, the feature capability, fixtures, test helpers, and `scripts/swarm-lab.sh`.                                                   | `health-env-authmode.test.ts`, `test-helpers.test.ts`, lab `up/deploy`.                                            |
| S0.2–S0.3            | Task ownership discrimination and proxy/migration guards; issue/PR references in `PROGRESS.md`.                                                              | `ownership.test.ts`, `docker-container-status.test.ts`, proxy detection tests.                                     |
| S1.1–S1.4            | Typed `OrchestratorMode`/workload refs, additive stack/revision schema, compatibility reads, and source-keyed service projections.                           | `runtime-identity.test.ts`, `deployment-runtime-read.test.ts`, `swarm-persistence.repo.test.ts`.                   |
| S2.1–S2.5            | Manager probe, platform resolution, bounded normalized discovery, health derivation, and authorized read-only API.                                           | `runtime.test.ts`, `platform.swarm.test.ts`, `normalize.test.ts`, `health.test.ts`, `swarm.service.test.ts`.       |
| S3.1–S3.6            | Repository/inline/observed source, lossless projection, staging confinement, Docker-native rendering, redacted preview, and compatibility/storage preflight. | `swarm-source*.test.ts`, `swarm-stack-projection.test.ts`, `swarm-preview.test.ts`, `swarm-compatibility.test.ts`. |
| S4.1–S4.5 and Gate A | Stack-first discovery, idempotent observe import, observed drift, read-only dashboard, and mutation-event harness.                                           | `swarm-observe.service.test.ts`, `swarm-observation.service.test.ts`, `swarm-observe-harness.ts`.                  |
| S5.1–S5.4            | Stack deploy lifecycle, revision/service records, managed claim, and labeled safe prune.                                                                     | `deploy.service.test.ts`, `swarm-management.service.test.ts`, managed lab proof.                                   |
| S6.1–S6.4            | Convergence, restart-safe reconciliation, drift classification, and grouped periodic/on-demand refresh.                                                      | `convergence.service.test.ts`, `reconcile.service.test.ts`, `swarm-drift.test.ts`.                                 |
| S7.1–S7.5            | Managed service scale/restart/log/remove APIs and task-aware dashboard operations.                                                                           | `swarm-operations.service.test.ts`, managed operations proof.                                                      |
| S8.1–S8.4            | Observe adoption, fresh source/live comparison, stale-safe claim, handoff export, and reversible release.                                                    | `swarm-source.service.test.ts`, `swarm-management.service.test.ts`, `swarm-operations.service.test.ts`.            |
| S9.1–S9.5            | Encrypted OCI credentials, digest publication, scoped manager auth, source build records, and build selection.                                               | `registry.service.test.ts`, `docker-registry.test.ts`, deploy/source tests, registry lab proof.                    |
| S10.1–S10.5          | External routing preservation, explicit Edge topology/overlay, service-DNS routes, and reversible cutover.                                                   | `swarm-edge*.test.ts`, `edge-routes.test.ts`, `cutover.test.ts`, Edge/cutover lab proofs.                          |
| S11.1–S11.3          | Immutable revision reapply, content-addressed configs/secrets, and retention/pinning.                                                                        | `resource-retention.service.test.ts`, rollback/resource lab proofs.                                                |
| S12.1–S12.4          | External object prerequisites, encrypted managed inputs, local-volume warnings, and preserved volume/network identity.                                       | `swarm-managed-input.service.test.ts`, `swarm-resource-identities.test.ts`, input/resource-identity lab proofs.    |
| S13.1–S13.4          | Project/deployment/rebinding UX, permission boundaries, locale coverage, and accessibility semantics.                                                        | `SwarmObservedProject.tsx`, `SwarmReadOnlyViews.tsx`, `swarm-route-permissions.test.ts`, dashboard tests.          |
| S14.1                | Safe YAML parsing, rendered-size limits, and stale confirmation tokens.                                                                                      | `swarm-yaml.test.ts`, source confinement/management/operations tests.                                              |
| S14.2                | Scheduler/manager failure state and operator recovery procedures.                                                                                            | `health.test.ts`, `FAILURE-RECOVERY.md`.                                                                           |
| S14.3                | Batched inventory, task pagination, cache coalescing, and response bounds.                                                                                   | `runtime.test.ts`, `swarm.service.test.ts`, `TEST-MATRIX.md`.                                                      |
| S14.4                | Docker/bare/cloud/desktop/migration/routing/SSL/rollback regression and feature-off behavior.                                                                | root `bun run test`, root build, `build-execution-plan.test.ts`, PGlite persistence test.                          |
| S14.5                | Manager authority, Portainer handoff, source/registry/routing/storage/operations/recovery documentation.                                                     | `OPERATOR-GUIDE.md`, `FAILURE-RECOVERY.md`.                                                                        |
| S14.6 and Gate C     | Rebased review units, PR description, compatibility matrix, and current integration evidence.                                                                | `UPSTREAM-HANDOFF.md`, `COMPATIBILITY-MATRIX.md`, this audit.                                                      |

## Cross-cutting acceptance criteria

- **Backward compatibility:** `RuntimeMode` remains Docker/bare while Swarm is
  explicit orchestration; standalone Compose is asserted to retain DockerRuntime
  per-container behavior in `build-execution-plan.test.ts`.
- **Source fidelity and secrets:** the source models retain original documents,
  confinement and YAML tests reject unsafe inputs, and encrypted fields are
  registered in `secret-registry.ts` for safe transfer.
- **No dual writer or task-container control:** observe mode is read-only,
  claim binds fresh live/source tokens, and task ownership guards exclude task
  containers from ordinary Docker migration/proxy paths.
- **Operational safety:** uncertain manager outcomes remain reconciling,
  destructive removal requires exact-name/current-version confirmation, and
  volume/config/secret preconditions fail before mutation.

## Latest executable evidence

After rebasing onto `upstream/main` at `6a677363`, the branch passed `bun run
test`, `bun run build`, API/adapters/CLI TypeScript checks, and documentation
format/diff checks. The disposable nested-Docker lab then completed:

1. manager/worker initialization and fixture deployment;
2. an observe-only event capture with no workload mutation;
3. managed prebuilt apply; service scale `2 → 0 → 1`, force restart, service
   and task logs/follow cancellation, exact-version safe removal; and private
   registry digest pull on the worker;
4. revision rollback, immutable resource, encrypted managed-input, and
   volume/network identity harnesses;
5. Edge task replacement with persistent certificate state and immutable route
   config update; and reversible router cutover; and
6. fixed-namespace `cleanup` and `down` with no lab containers left behind.
