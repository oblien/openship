# Docker Swarm failure and recovery guide

OpenShip reports manager observations; it does not attempt to second-guess the
Swarm scheduler. In particular, it never removes services, volumes, configs,
or secrets as a reaction to a failed or uncertain deployment. A connection
loss after a command may mean Docker accepted the command, so OpenShip keeps
the deployment `reconciling` and reads the manager before an operator decides
what to do next.

Task error text is Docker-provided diagnostic data. It is shown in bounded,
redacted deployment and task-log views; registry credentials, source secrets,
and manager connection credentials are not included.

| Failure mode                                        | OpenShip state                                                                                                                  | Operator recovery                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Manager unreachable before apply                    | The request fails before `docker stack deploy` with a safe manager-unreachable error.                                           | Restore manager/SSH/Docker access, confirm the target is a manager, then retry the same reviewed deployment.                              |
| Connection lost after apply                         | `reconciling` / manager `unreachable`; the apply outcome is unknown.                                                            | Restore access and allow reconciliation to read the original stack. Do not retry blindly; redeploy only after the live revision is clear. |
| Worker down                                         | `deploying` while Swarm schedules a replacement, then `partial_failure` or `failed` if the desired replica count cannot be met. | Restore or replace the worker, check placement/storage prerequisites, and let Swarm reschedule.                                           |
| Worker drained                                      | The same scheduler state as a pending replacement or a replica deficit.                                                         | Make an eligible node active, un-drain deliberately if appropriate, or update the placement policy and deploy a reviewed revision.        |
| Impossible placement constraint                     | `failed` with Docker's `no suitable node` diagnostic.                                                                           | Correct node labels/constraints or capacity, validate the preview again, then deploy.                                                     |
| Public image missing                                | `failed` with the image-pull diagnostic.                                                                                        | Publish or select the immutable image digest, then deploy a new reviewed revision.                                                        |
| Private-registry authentication failure             | `failed` with Docker's pull-authentication diagnostic.                                                                          | Correct the registry credential/worker access, keep the credential out of logs, and deploy a new revision.                                |
| Registry unavailable during a source build/push     | The build phase fails before stack apply.                                                                                       | Restore registry availability and retry the build; no stack cleanup is attempted.                                                         |
| Missing external network, volume, config, or secret | A preflight compatibility blocker; no apply is issued.                                                                          | Create or bind the named external resource on the manager, then refresh and validate again.                                               |
| Health-check or process failure                     | `failed` or `partial_failure`, retaining the current task diagnostic.                                                           | Inspect redacted service/task logs, correct the workload, then redeploy or explicitly roll back.                                          |
| Update paused                                       | `partial_failure`, with the service marked `paused`.                                                                            | Inspect the update message/task errors and choose an explicit rollback or corrected redeploy.                                             |
| Automatic Swarm rollback                            | `failed`; the manager's rollback state remains visible.                                                                         | Verify the manager's resulting service spec, then retain it, roll back to an OpenShip revision, or deploy a corrected revision.           |
| API restart during build, apply, or convergence     | Durable phase/revision records are resumed as `reconciling` where the manager outcome was unknown.                              | Wait for reconciliation to inspect live state. It reads only; it never reissues the original stack apply.                                 |
| Portainer or CLI change while claiming              | The claim is rejected when its live-state digest or source version is stale; no Docker write occurs.                            | Refresh the preview, resolve the external change with its owner, and confirm a new claim deliberately.                                    |
| Task rescheduled while following logs               | Service logs continue to follow the service; a task-specific stream remains tied to the selected task.                          | Reopen the task stream for a replacement task, or use the service stream to follow scheduler replacements.                                |
| Bound manager unavailable                           | Manager health is `unreachable`; the binding remains unchanged.                                                                 | Use validated manual rebinding only to another manager in the same cluster, then refresh/reconcile.                                       |

## Executable coverage

The failure matrix is deterministic and does not require a production manager:

- [health.test.ts](../../packages/adapters/src/runtime/swarm/health.test.ts)
  exercises worker loss/drain, placement, image and registry errors, missing
  resources, health failures, paused updates, and automatic rollback states.
- [runtime.test.ts](../../packages/adapters/src/runtime/swarm/runtime.test.ts)
  verifies credential-safe manager failures, bounded operations, and
  caller-cancellable service/task log streams.
- [deploy.service.test.ts](../../apps/api/src/modules/deployments/swarm/deploy.service.test.ts),
  [convergence.service.test.ts](../../apps/api/src/modules/deployments/swarm/convergence.service.test.ts),
  and [reconcile.service.test.ts](../../apps/api/src/modules/deployments/swarm/reconcile.service.test.ts)
  prove that response loss remains reconciling and later resolves from a
  manager read without a second apply.
- [swarm-compatibility.test.ts](../../apps/api/src/modules/swarm/swarm-compatibility.test.ts)
  blocks missing external resources before mutation;
  [swarm-management.service.test.ts](../../apps/api/src/modules/swarm/swarm-management.service.test.ts)
  rejects stale claims; and
  [swarm-connection.service.test.ts](../../apps/api/src/modules/swarm/swarm-connection.service.test.ts)
  proves same-cluster manager rebinding.

For a disposable manager-and-worker integration proof, see
[TEST-MATRIX.md](TEST-MATRIX.md). Never inject these faults into a production
manager merely to test recovery.
