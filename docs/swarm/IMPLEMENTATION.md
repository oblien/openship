# Docker Swarm implementation

Docker Swarm is a stack-native deployment target. OpenShip retains the source
stack document as desired state and uses Docker's stack commands to render and
apply it. The existing Docker runtime remains the build engine; a separate
Swarm stack runtime owns stack and service operations.

The implementation is gated by `OPENSHIP_EXPERIMENTAL_SWARM=true`. It is off by
default, and the API exposes the resolved capability as
`swarmSupportEnabled` from `GET /api/health/env`. No Swarm endpoint or dashboard
control may be exposed while this gate is off.

## Safety model

- Imported stacks begin in `observe` mode. Read-only inspection never claims or
  mutates a live stack.
- A stack moves to `managed` only after explicit operator claim and preflight.
- A Swarm task/container is scheduler output, never a durable OpenShip workload
  identity. Task containers must not enter container adoption, takeover,
  `stop`, `rm`, `exec`, or network-attach paths.
- Source files are staged in a private directory and rendered with
  `docker stack config`; OpenShip does not reimplement Compose or Swarm
  semantics.
- A Docker socket or SSH target with Swarm manager control is **cluster-admin,
  root-equivalent authority**: it can create services, mount host resources,
  distribute registry credentials, and read manager-visible metadata. Bind
  OpenShip only to a manager and organization you trust; do not share that
  target with untrusted tenants or expose its Docker socket to the network.
- A managed apply persists an encrypted immutable rendered revision before
  `docker stack deploy`. UI previews and audit output are redacted.
- External routing is the initial default. Existing Portainer, Traefik, Nginx
  Proxy Manager, labels, networks, and port bindings remain untouched until a
  later explicit Edge cutover.

## Supported target shape

The first release supports a Docker runtime connected to a local or SSH-reached
Swarm manager. Workers must be able to pull any image deployed by OpenShip.
Source-backed services therefore require an OCI registry and are deployed by
digest, not mutable tags.

See [OPERATOR-GUIDE.md](OPERATOR-GUIDE.md) for a production operating runbook,
[COMPATIBILITY-MATRIX.md](COMPATIBILITY-MATRIX.md) for cross-runtime behavior,
[UPSTREAM-HANDOFF.md](UPSTREAM-HANDOFF.md) for the review packet,
[REQUIREMENTS-AUDIT.md](REQUIREMENTS-AUDIT.md) for the plan-to-evidence index,
[TEST-MATRIX.md](TEST-MATRIX.md) for the disposable test topology,
[FAILURE-RECOVERY.md](FAILURE-RECOVERY.md) for operator recovery decisions, and
[PROGRESS.md](PROGRESS.md) for current implementation evidence.
