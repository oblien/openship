# Container-ID compatibility audit

Swarm task containers are scheduler output, not OpenShip workload identities.
This inventory records every category that still reads a legacy
`deployment.containerId` or `serviceDeployment.containerId`, and its Swarm
policy. It is deliberately maintained alongside the runtime-reference bridge
while legacy rows remain supported.

## Boundary and policy

- New Swarm rows use `deployment.runtimeRef.kind = "swarm-stack"` and
  `serviceDeployment.runtimeRef.kind = "swarm-service"`; no new Swarm code
  writes a service or stack ID to `containerId`.
- `deploymentWorkloadRef` and `serviceWorkloadRef` read typed references first,
  then translate old `containerId` conventions for existing bare, Docker, and
  cloud rows.
- `resolveDeploymentRuntime` and `resolveDeploymentRuntimeForRead` reject a
  Swarm stack with `SWARM_CONTAINER_OPERATION_UNSUPPORTED` before a Docker
  runtime can issue a container command.
- `resolveServicePlatform` and the service lifecycle resolver make the same
  refusal for Swarm services. The eventual stack APIs must use
  `Platform.stackRuntime`, never these container adapters.

## Direct-consumer classification

| Area | Files | Legacy use | Swarm handling |
|---|---|---|---|
| Compatibility and persistence | `packages/core/src/runtime-identity.ts`, `packages/db/src/repos/deployment.repo.ts`, `packages/db/src/repos/service.repo.ts` | Translate/read or write the compatibility fields. | Typed ref wins; future Swarm writers use the JSONB refs and leave container IDs empty. |
| Ordinary deploy and compose pipelines | `apps/api/src/modules/deployments/build-pipeline.ts`, `apps/api/src/modules/deployments/compose/*`, `deployment-lifecycle.ts` | Start, replace, inspect, and destroy standalone containers. | The pipeline rejects `orchestratorMode: swarm` before this branch; a stack pipeline is required. |
| Project lifecycle | `apps/api/src/modules/projects/project-runtime.service.ts`, `project-cleanup.service.ts`, `port-check.service.ts`, `output-check.service.ts` | Logs, enable/disable, cleanup, port and output inspection. | Runtime resolver fails closed. Project/deployment cleanup emits an inert `swarm_stack` manifest marker and never removes the live stack. |
| Service lifecycle and terminal | `apps/api/src/modules/services/service.service.ts`, `service-container.ts`, `apps/api/src/modules/service-terminal/service-terminal.controller.ts` | Container start/stop/restart, logs, shell, volume inspection, per-service deletion. | Service/stack refs return `SWARM_CONTAINER_OPERATION_UNSUPPORTED`; no fallback provisioning or shell is attempted. |
| Observability and routing | `apps/api/src/modules/analytics/*`, `apps/api/src/modules/domains/project-route.service.ts`, `routing-apply.service.ts`, `apps/api/src/lib/upstream-url.ts` | Container stats, IP/host-port lookup, and upstream routing. | Runtime resolver fails closed. Swarm uses external routing until its explicit Edge integration exists. |
| Reconcile, rollback, retention, image cleanup | `apps/api/src/modules/deployments/reconcile.service.ts`, `rollback/*`, `release-retention.ts`, `image-gc.ts` | Container inspection/destroy and image/archive cleanup. | Runtime resolver fails closed. Swarm reconciliation and rollback are stack-revision operations, not these paths. |
| Backup and restore | `apps/api/src/modules/backups/*`, `packages/adapters/src/backup/*` | Resolve a service container for dump/restore or stop/start. | No Swarm task is supplied through a runtime ref. Stack-aware backup support remains a separate future operation. |
| Migration and startup | `apps/api/src/modules/migration/*`, `apps/api/src/lib/startup/*` | Discover/adopt standalone containers or the OpenShip control-plane containers. | Swarm tasks were excluded in S0.2 before adoption; startup applies only to the standalone control plane. |
| Dashboard and CLI compatibility | `apps/dashboard/src/**`, `apps/cli/src/commands/service.ts` | Render legacy container IDs and receive status events. | Existing fields stay readable. New records expose `runtimeRef`; task IDs are not presented as a managed container. |
| Adapter implementations | `packages/adapters/src/runtime/{docker,bare,cloud}.ts`, `runtime/types.ts`, `deploy-pipeline.ts` | The low-level container/process API itself. | It accepts only a container/process identifier. Swarm calls belong exclusively in `runtime/swarm/` through `StackRuntimeAdapter`. |

## Guard evidence

- `apps/api/src/lib/deployment-runtime-read.test.ts` proves a Swarm snapshot
  fails before server/local Docker runtime selection.
- `packages/core/src/runtime-identity.test.ts` proves complete Swarm refs parse,
  incomplete refs are rejected, and old container IDs retain their historic
  Docker/bare/cloud translation.

## Remaining migration contract

The legacy columns remain response-compatible until all dashboard consumers
read `runtimeRef`. Their use is intentionally limited to existing non-Swarm
rows. Any new code that adds a direct `containerId` operation must be added to
this table and either consume the typed helper or explicitly reject a Swarm
reference first.
