# Project topology

`/projects/:id/topology` is the operational view of one project environment.
An environment is an existing project record; the project environment switcher
chooses the record. The canvas uses saved services, observed containers, public
routes, and shared project connections. `/scale` redirects to the project list.

## Existing systems used

| Topology action                                       | Existing implementation                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Add a service                                         | `AddServiceModal`, the local/cloud image catalogs, and `servicesApi.create`                        |
| Configure a service                                   | `ServiceSettingsForm` and `servicesApi.update`                                                     |
| Start an added image service                          | `servicesApi.start`, as in the Services page                                                       |
| Start, stop, restart, logs, and environment variables | Existing per-service actions and routes                                                            |
| Change CPU and memory                                 | Project resource capacity rules; `advanced.resources` for a service or project production defaults |
| Apply configuration to a running workload             | Existing deployment refresh with the affected service IDs and retained images                      |
| Update from source                                    | Existing deployment trigger, progress, and history                                                 |
| Initial deployment                                    | Existing environment deployment setup                                                              |
| Clone a service to another server                     | `ProjectMigrationCard` with explicit `serviceNames`, then `ServerMigrationWizard`                  |
| Clone or move an environment                          | The same project migration flow and its existing cutover/rollback controls                         |

There is no second provisioning engine, deployment queue, or migration model.
The canvas does not call mutation APIs when a node is moved or selected.

## Scope and truthfulness

- One logical service is one overview node. Its runtime view shows observed
  container identity and provides a back button. Extra containers reported by
  the host are flagged for attention; they are not counted as managed replicas.
- A materialized application service or migrated stack does not also receive a
  synthetic main application node. An active deployment is a release record,
  not proof that a container is currently healthy.
- Public route edges come from the existing exposed-service/domain settings.
  Routing is presented as **OpenShip Edge**.
- Dragging between service handles edits only the source service's `dependsOn`.
  The edge is labeled **Starts after**. It does not provision a network or inject
  credentials. Duplicates, self-dependencies, and cycles are rejected.
- Shared project bindings currently apply to the whole target environment.
  They are drawn once from an environment node to the owning project's service,
  preserving `sourceServiceId` where present. Removing one uses the existing
  connection API and redeploys the environment to apply the variable change.
- A migration clone is an independent copy with its own data and deployments.
  It is not a synchronized application replica or a database replica. Moves
  apply to the whole environment because the existing project has one server.
- Database clustering, replica synchronization, traffic distribution across
  copies, and autoscaling need additional backend orchestration. The planning
  catalog in `@repo/core/scale` does not enable these in production.

## Review and apply

Configuration changes remain in memory until review. The review identifies the
affected service(s), source choice, and resource values. Image-only additions
use the existing independent service launch path; they do not redeploy the
parent application. Source changes use the deployment pipeline. An undeployed
environment saves configuration and continues to the existing setup wizard.

The apply adapter re-reads saved services and resources before writing, rejecting
conflicting edits. It records each successful write and service launch so a
retry does not create another service or repeat a completed launch. Partial
saves stay visible; the UI does not pretend they were rolled back. Environment
refreshes explicitly request all enabled services, while a service refresh
keeps the supplied service IDs even if another service has dirty variables.

Navigation warns about pending edits, environment switching is disabled while
changes are pending, and deployment/migration activity blocks conflicting
actions. Runtime polling keeps host errors visible instead of converting an
unreachable host into zero running services. Canvas positions alone are saved
locally, keyed by project and view. Service configuration and secrets are never
stored with the layout.

## Verification

The tests cover real graph projection, connection scope, application identity,
dependency validation, service launch order, partial-save retries, explicit
migration selection, and deployment refresh scope.

```sh
bun run --cwd apps/dashboard test src/components/topology src/components/migration/service-scope.test.ts src/components/migration/project-migration-card.render.test.tsx src/components/scale/ScaleDetailsPanel.test.tsx src/lib/sidebar-nav.test.ts
bun run --cwd apps/dashboard lint
bun run --cwd apps/api test test/modules/deployments/build.service.test.ts
```

Browser checks should include a new service's automatically expanded settings,
the compact connection inspector, instance navigation, selected-service clone
scope, failed-apply retry, and the narrow-screen layout. Live migration and
deployment still require an actual connected server and configured project.
