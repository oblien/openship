# Server clusters and private networking

The initial implementation lives under **Servers → Cluster / Networking**. An
organization owns its clusters; project environments keep their existing server
targets and topology. A cluster is not yet a deployment target.

**Cluster** manages server groups and membership. **Networking** lists their
private address ranges, connected servers, and verification results, with links
to each network's details. Each cluster currently has one primary private network,
registered during cluster setup. The views share inventory loading but have
separate empty states, using the existing server-group and network illustrations.
Cluster offers creation; Networking directs users to Cluster for initial setup.

## Available workflow

Create a cluster, select 2–16 existing servers, choose a provider profile per
member, and enter the existing private IPv4 ranges and addresses. The wizard
runs inline at `/servers/clusters/new`; edits use
`/servers/clusters/:clusterId/edit`. Both routes share the same stepper, validation,
and save/verification flow. The form uses the standard page width, with steps and
Continue/Back/Cancel controls in a sticky right column. Narrow layouts stack the
controls below the form. Both columns share the normal page scroll, with no
floating footer or independently scrolling panels. Direct access checks
self-hosted capabilities and fleet management permission; an active verification
blocks editing.

Setup and editing respect the normal sidebar preference. Automatic collapse is
reserved for canvas views.

The wizard reuses the add-server modal and can inspect each server through the
shared SSH executor. Review saves the cluster and starts a persisted connectivity
check.

Form fields, checkboxes, and actions use the shared UI components. Provider
selection uses the shared searchable selector with local brand logos and network
descriptions from capabilities. Setup fields and the selector share the filled
Input variant: theme-based backgrounds without resting borders, with keyboard
focus rings. Containers retain the theme's borderless surfaces.

Profiles cover Hetzner Dedicated vSwitch, Hetzner Cloud Networks, AWS, Azure,
Google Cloud, DigitalOcean, OVHcloud, Scaleway, and Custom. Capabilities explicitly
advertise adoption only. Provider references are metadata, not proof of network
membership. Hetzner Dedicated checks enforce the vSwitch MTU limit of 1400.

Servers need Linux, Python 3, iproute2, a persistent machine identity, configured
private interfaces, and mutually reachable routes. Allow the selected verification
port (default 51821) for TCP and UDP between those private addresses. Verification
checks the selected addresses and port; it does not prove that service ports are
reachable or that traffic is encrypted.

The controller inspects address ownership and MTU, detects duplicate physical
hosts, then checks TCP, UDP, and unfragmented MTU-sized packets for every directed
pair. Reports survive reloads. A check has a four-minute lease; expired workers
cannot publish success. Successful observations become stale after fifteen
minutes. Temporary authenticated listeners bind only the selected private
addresses and are closed after verification; they also expire locally after
270 seconds if controller cleanup cannot reach them.

The list and detail views provide retry, edit, and inventory removal. Edits use a
captured revision and invalidate older observations. Active checks block edits and
removal. Removing a cluster leaves its servers and externally owned networking in
place. A member must leave its cluster before its server entry can be deleted.
Enrollment and server teardown share the existing mutex/advisory-lock mechanism,
so a concurrent enrollment cannot occur halfway through workload removal. This
lock is scoped to an organization and uses one database connection per operation.

## Shared implementation

- `packages/core/src/infrastructure.ts`: provider catalog, network types,
  validation, interface selection, verification limits, and report evaluation.
- `packages/contracts/src/server-clusters.ts`: schemas consumed by the engine,
  HTTP controllers, SDK, and dashboard. Cluster actions use the existing server
  operation surface and require fleet-wide read/admin access.
- `packages/db/src/schema/server-cluster.ts` and migration `0129`: cluster,
  primary network, compute membership, separate server network attachments, and
  verification records. Server foreign keys are deferred in SQL so organization
  cascades can remove both parent trees in one transaction. Direct server removal
  still fails while membership exists.
- `packages/platform/src/engine/modules/system/server-cluster.operations.ts`:
  orchestration over existing authorization, server access, SSH pooling, physical
  identity, audit, and background-work facilities. Workers recheck authority and
  their persisted lease before host work.
- `packages/adapters/src/network/private-network.ts`: reusable Linux inspection
  and authenticated temporary probes, also usable by a future overlay driver.
- `apps/api/src/modules/system/server-clusters.controller.ts` and
  `packages/sdk/src/server-client.ts`: thin transports over the shared operations.

Server configuration records belong in whole-instance backups, not project or
organization transfer bundles. Transient verification reports are excluded from
backups. API/native operation guards reject Oblien-managed Cloud before host
execution; the dashboard also hides its controls. Local and desktop self-hosted
controllers support cluster inventory and manual network verification against
registered Linux servers. These bounded checks do not require an always-on
controller; future continuous reconciliation does.

## Scope of this increment

This adopts **already configured** networks. It does not create provider networks,
attach vSwitches, configure VLANs/routes/firewalls, install WireGuard, connect
Docker bridges, allocate private service endpoints, place replicas, or provide
shared storage. Those operations need the plan/review/apply and recovery lifecycle
described in
[the architecture plan](../../../../../../docs/self-hosted-clusters-and-private-networking.md).
No unavailable provisioning choice is presented as a working action.

## Validation

Focused suites cover shared validation, organization isolation, retries,
verification expiry and revision fencing, physical host aliases, membership
constraints, migration upgrades, backup coverage, authorization/revocation,
Cloud rejection, desktop access, HTTP/native parity, SDK transport, and observation
age. The Servers page also covers tab visibility, capability loading/errors, and
retry. Browser checks include navigation through the local desktop dashboard.

Run real Linux probes in disposable containers on an explicitly selected Docker
context:

```sh
bun packages/adapters/scripts/verify-private-network.ts <docker-context>
```

The script exercises private binding, bidirectional TCP/UDP/MTU, occupied ports,
invalid tokens, MTU failure, blocked UDP, cleanup, and the 16-member / 240-directed-
connection limit. Its containers and network use no host ports or mounts, and it
removes the resources it created. These checks do not replace validation on each
provider's real network.
