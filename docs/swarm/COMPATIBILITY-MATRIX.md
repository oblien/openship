# Runtime compatibility matrix

Docker Swarm is an explicit orchestrator mode layered on top of the existing
runtime choices. Enabling its feature gate does not convert an existing project
or change its deployment path.

| Capability                               | Standalone Docker / Compose         | Swarm                                                            | Bare                        | Cloud / static                   |
| ---------------------------------------- | ----------------------------------- | ---------------------------------------------------------------- | --------------------------- | -------------------------------- |
| Default behavior when the feature is off | Unchanged                           | Hidden and inactive                                              | Unchanged                   | Unchanged                        |
| Image build engine                       | Docker runtime                      | Docker runtime, then registry digest when a source build is used | Native/bare runtime         | Existing cloud/static build path |
| Workload identity                        | Container/service deployment        | Stack/service/task reference; never a task container             | Process/service             | Cloud deployment/static artifact |
| Project deployment                       | Per-container Docker lifecycle      | `docker stack` render/apply and convergence                      | Existing process lifecycle  | Existing cloud/static lifecycle  |
| Compose source                           | Existing current Compose flow       | Source-backed stack document, rendered by Docker                 | Not applicable              | Not applicable                   |
| Day-two scale/restart/logs               | Existing container/service controls | Managed services only; task-aware logs                           | Existing process controls   | Existing cloud controls          |
| Registry needed for source builds        | Existing Docker behavior            | Required; workers pull digest-pinned images                      | Existing behavior           | Existing cloud registry behavior |
| External routing                         | Existing proxy/port behavior        | Default; OpenShip does not mutate it                             | Existing proxy behavior     | Provider routing                 |
| OpenShip Edge integration                | Existing explicit Edge flow         | Explicit `openship-edge` topology/cutover only                   | Existing explicit Edge flow | Not applicable                   |
| Local named volumes                      | Docker-local semantics              | Still node-local; not portable/HA                                | Host-local semantics        | Provider-specific                |
| Observe/import view                      | Not a Swarm feature                 | Read-only by default; claim is explicit                          | Not applicable              | Not applicable                   |

## Guarantees and limits

- `RuntimeMode` remains `docker` for a Swarm target because Docker still builds
  images. `orchestratorMode: swarm` selects the separate stack lifecycle.
- A standalone Compose project remains `orchestratorMode: standalone` and uses
  DockerRuntime with per-container semantics. It does not issue Swarm commands.
- Bare, cloud, static, desktop, migration, routing, SSL, and rollback paths do
  not require a Swarm manager or Docker stack CLI commands.
- Swarm manager access is feature-gated and defaults off. With the gate off,
  the dashboard tab and available Swarm background jobs are absent.
- Swarm's scheduler does not make local named volumes portable. Pin stateful
  work to an appropriate node or use a tested shared-storage driver.

See [OPERATOR-GUIDE.md](OPERATOR-GUIDE.md) for the operating model and
[FAILURE-RECOVERY.md](FAILURE-RECOVERY.md) for failure-specific actions.
