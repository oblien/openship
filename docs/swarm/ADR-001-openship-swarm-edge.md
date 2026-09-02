# ADR-001: OpenShip Swarm Edge topology

## Decision

OpenShip-managed Swarm routes use an opt-in cluster singleton named
`openship-edge`, not the existing host-network edge container and not a router
inside an application stack.

The singleton has one replica initially and is constrained to a deliberately
labelled ingress node (`openship.edge.ingress=true`). It publishes host ports
80 and 443 only on that node, joins the cluster-scoped `openship-edge` overlay,
and owns stable named volumes for site state, ACME webroot, and certificates.
Application stacks join that overlay only when an operator opts a service into
OpenShip routing; they never own or delete it.

## Consequences

- The API discovers the edge by service name from current manager state after
  every reschedule. It never caches or `docker exec`s a task ID as an identity.
- Route/config changes use Docker configs or a service update, which replaces
  the task safely. This is the reload mechanism for a task that may be on any
  worker. The initial one-replica topology intentionally uses `stop-first` so
  the ingress host port has exactly one owner.
- Certificate and route state remains on named volumes tied to the labelled
  ingress node. If that node is lost, Edge is unavailable until the operator
  restores/migrates its state; OpenShip must report that rather than claim HA.
- Later HA may add labelled ingress nodes and shared certificate/config storage
  without changing application stack network names or service DNS targets.

## Rejected alternatives

The current standalone Docker Edge uses host networking and a local
`docker exec` control path; a Swarm task cannot safely inherit either. Attaching
that container to an overlay would also not make it a scheduler-managed service.
OpenShip does not automatically replace Traefik, Caddy, Nginx Proxy Manager, or
another Swarm service holding 80/443. Cutover is a separate confirmed workflow.
