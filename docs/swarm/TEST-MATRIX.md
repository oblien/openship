# Docker Swarm test matrix

The Swarm lab is disposable and isolated. It runs a manager and worker as
privileged Docker-in-Docker containers, with the manager API published only at
`127.0.0.1:23750`. It needs Docker Engine with nested privileged containers,
approximately 4 GB free RAM, and outbound access to pull public fixture images.

| Scenario | Command | Evidence |
| --- | --- | --- |
| Create manager + worker | `scripts/swarm-lab.sh up` | `docker node ls` reports a manager and worker |
| Deploy replicated/global/stateful/routed fixture | `scripts/swarm-lab.sh deploy` | `docker stack services` and `docker stack ps` converge |
| Start ordinary Compose Traefik | `scripts/swarm-lab.sh compose-proxy` | a non-Swarm Traefik container runs on the nested manager's `:18080` |
| Read task state | `scripts/swarm-lab.sh status` | service/task table shows the fixture stack only |
| Capture mutations | `scripts/swarm-lab.sh events` | Docker events filtered to `com.openship.swarm.fixture=true` |
| Remove fixture only | `scripts/swarm-lab.sh cleanup` | only `openship-swarm-fixture` is removed |
| Destroy nested lab | `scripts/swarm-lab.sh down` | only `openship-swarm-lab` Compose resources are removed |

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
