# Docker Swarm test matrix

The Swarm lab is disposable and isolated. It runs a manager and worker as
privileged Docker-in-Docker containers, with the manager API published only at
`127.0.0.1:23750`. It needs Docker Engine with nested privileged containers,
approximately 4 GB free RAM, and outbound access to pull public fixture images.

| Scenario                                         | Command                              | Evidence                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create manager + worker                          | `scripts/swarm-lab.sh up`            | `docker node ls` reports a manager and worker                                                                                                                                                                                                                   |
| Deploy replicated/global/stateful/routed fixture | `scripts/swarm-lab.sh deploy`        | `docker stack services` and `docker stack ps` converge                                                                                                                                                                                                          |
| Start ordinary Compose Traefik                   | `scripts/swarm-lab.sh compose-proxy` | a non-Swarm Traefik container runs on the nested manager's `:18080`                                                                                                                                                                                             |
| Read task state                                  | `scripts/swarm-lab.sh status`        | service/task table shows the fixture stack only                                                                                                                                                                                                                 |
| Prove observe-mode coexistence                   | `scripts/swarm-lab.sh observe-proof` | runs repeated probe/discover/import/refresh plus Docker-native source validation while recording manager events; exits non-zero for any workload mutation                                                                                                       |
| Prove managed prebuilt deploy and recovery       | `scripts/swarm-lab.sh managed-proof` | deploys a two-service inline stack through the production manager adapter twice; verifies revisions, stack/service refs, ownership labels, unchanged task IDs, then withholds an accepted Docker response and proves observation-only reconciliation settles it |
| Prove managed service and stack operations       | `scripts/swarm-lab.sh operations-proof` | after `managed-proof`, scales the owned replicated `web` service to 2, then 0, then 1; force-restarts it; reads/follows service and task logs; and removes only the managed stack while confirming its external config and secret remain |
| Resolve a linked repository source safely        | `bun --cwd apps/api vitest run src/modules/swarm/swarm-source.service.test.ts` | fetches only the configured project repository's compose/config source at its selected ref; unsafe persisted paths fail before any source read |
| Capture mutations                                | `scripts/swarm-lab.sh events`        | Docker events filtered to `com.openship.swarm.fixture=true`                                                                                                                                                                                                     |
| Remove fixtures only                             | `scripts/swarm-lab.sh cleanup`       | only the fixed observe and managed fixture stacks are removed                                                                                                                                                                                                   |
| Destroy nested lab                               | `scripts/swarm-lab.sh down`          | only `openship-swarm-lab` Compose resources are removed                                                                                                                                                                                                         |

The fixture has:

- a replicated public-image service;
- a global service;
- a manager-pinned local-volume service (to make node-local storage risk
  observable); and
- a Traefik-labelled service that models externally owned routing without
  changing its routes;
- a manager-pinned, ingress-published Swarm Traefik task; and
- an ordinary Compose Traefik container, deliberately published on a different
  nested-manager port so the two ownership cases can coexist.

`cleanup` and `down` reject any target other than the fixed OpenShip test
namespace. They must never be repurposed for operator workloads.

## Observe-only event proof

Run `up` and `deploy` first, then wait for the fixture services to converge
before running `observe-proof`. The proof uses only the disposable nested
manager at `127.0.0.1:23750`; its persistence layer is in-memory so it does
not require, read, or modify the developer's OpenShip database.

The harness calls the production probe, discovery, observe-import, observed
refresh, inline source validation, and `docker stack config` rendering paths.
It repeats manager polling and import/refresh, captures Docker events for the
entire interval, and fails if it sees a create/update/remove or task lifecycle
event for a service, network, config, secret, volume, or task container. A
successful output and its retained temporary JSON event file are the evidence
to attach to the pilot record. Do not point this command at a production
manager.

Verified locally on July 30, 2026: the manager-and-worker fixture converged,
then `observe-proof` completed the full sequence with no relevant Docker
mutation events.

## Managed prebuilt-image proof

Run `up`, then `managed-proof`. It deploys the separate
`openship-swarm-managed-fixture` namespace from
`fixtures/swarm/managed-stack.yml`; it never reuses the observe-mode fixture.
The harness holds only in-memory persistence, but invokes the production
render, ownership-label, `docker stack deploy --resolve-image always`, manager
discovery, health, revision, and service-reference paths. It applies the same
source twice and fails if current task IDs change. It then applies the same
source a third time while deliberately withholding Docker's accepted response;
the production reconciliation service must settle that deployment by reading
the live manager without another apply. The fixture's short update monitor
keeps this proof bounded; it is not a production rollout default.

Verified locally on July 30, 2026: both prebuilt services converged, three
revision records and service deployment references were produced, the second
apply retained the two running task IDs, and the lost-response recovery settled
ready without changing them. `cleanup` and `down` were then run successfully.

## Managed operations proof

Run `managed-proof` first, then `operations-proof`. The managed fixture creates
an external config and secret inside the disposable manager; their payloads are
never inspected or printed. The operations harness exercises production scale,
restart, log-read, task-log, and follow/cancellation paths before invoking the
typed-name managed removal. It verifies replacement task IDs after restart,
the worker's heartbeat through both service and task logs, and the continued
metadata presence of the external config and secret after stack removal.

`docker stack rm` deletes stack-owned secrets (and may remove stack-owned
configs), so OpenShip refuses removal while either is owned by the stack. Mark
them external first; named volumes and external networks are left alone. The
lab cleanup removes only its fixed external config and secret after all fixture
services are absent.

Verified locally on July 30, 2026: the scale sequence converged, a force update
changed the web task ID without changing its service ID, service/task log reads
and a cancelled follow stream saw the worker heartbeat, and removal retained
the external config and secret.
