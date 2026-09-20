# Server clusters and private networking

Infrastructure lives under **Servers → Cluster / Networking**, with independent
organization-owned resources. Project environments retain their existing service
placements; a compute cluster is not yet a deployment target.

**Cluster** manages server pools and membership. A cluster references one existing
private network and selects 1–16 servers already attached to it. Multiple clusters
can share a network, and a server can attach to multiple networks while belonging
to one compute cluster. Cluster creation and edits never configure a host.

**Networking** owns network creation/adoption, server attachments, firewall review,
preparation, operations, recovery, topology, and diagnostics. Each network appears
as its own expandable group, even when no compute cluster uses it. Sharing a
provider never merges networks or creates a connection between them. Network
pages show their dependent clusters and link to creating a cluster on that network.
Server detail pages show their own cluster and network references; users without
fleet read access see names without links to inaccessible fleet pages.

Both tabs share one overview subscription and have separate empty states. Create
cluster / Create network and Refresh sit in the page header above the tabs.
Deleting a cluster preserves every server and network attachment. A network cannot
be deleted, or a server detached from it, while a compute cluster depends on that
relationship. These checks happen before managed host work and are backed by
deferred database foreign keys. Network recovery also prevents a new cluster from
acquiring a dependency until the operation is settled.

## Cluster workflow

`/servers/clusters/new` selects an existing network and its connected servers, with
an optional `networkId` query to carry context from Networking. The form uses shared
filled inputs, checkboxes and the network selector, plus a sticky right summary.
Create network opens the shared network wizard. `/servers/clusters/:clusterId` shows
membership and a link to the network; `/edit` changes the pool with a captured
revision. No firewall setup, probes, host provisioning or cleanup is duplicated in
these routes.

## Available workflow

Name the network and choose native adoption or managed WireGuard, then configure 2–16
existing servers. Managed WireGuard works across providers and does not ask for
provider selection. Native adoption chooses a provider and optional actual network
reference once (for example, a specific vSwitch or VPC), then collects only private
address/interface settings per server. **Custom** adopts an existing routed LAN,
VLAN or VPN, including mixed providers. A provider selection is not network discovery;
the operator must attach the servers and establish routes before adoption.
The wizard
runs inline at `/servers/networks/new`; edits use
`/servers/networks/:networkId/edit`. Both routes share the same stepper, validation,
and review/verification flow. The form uses the standard page width, with steps and
Continue/Back/Cancel controls in a sticky right column. Narrow layouts stack the
controls below the form. Both columns share the normal page scroll, with no
floating footer or independently scrolling panels. Direct access checks
self-hosted capabilities and fleet management permission. Active verification and
unsettled managed operations block competing edits.

Setup and editing respect the normal sidebar preference. Automatic collapse is
reserved for canvas views.

The native adoption wizard reuses the add-server modal and the existing network inspection
endpoint. **Detect network settings** reads selected servers through the shared
SSH executor, with at most three inspections in flight. It fills private IPs,
interfaces, and exact subnets from observed masks, preserves valid routed ranges,
and lowers verification MTU when needed. A single server can also be inspected
or retried. Multiple private interfaces remain an explicit choice; missing
networks and failed inspections are explained on the affected server's card.
Host-only masks require the operator's real routed range, rather than an invented
subnet. Detection updates only the draft and never configures a host or claims
connectivity. Review saves the network and starts a persisted connectivity check.

Form fields, checkboxes, and actions use the shared UI components. Provider
selection uses the shared searchable selector with local brand logos and network
descriptions from capabilities. Setup fields and the selector share the filled
Input variant: theme-based backgrounds without resting borders, with keyboard
focus rings. Containers retain the theme's borderless surfaces.

Profiles cover Hetzner Dedicated vSwitch, Hetzner Cloud Networks, AWS, Azure,
Google Cloud, DigitalOcean, OVHcloud, Scaleway, and Custom. Capabilities explicitly
advertise adoption only. Provider references are metadata, not proof of network
membership. Native configuration stores this context in `network.source`, containing
`providerId` and optional `networkRef`. Shared validation, detection and host checks
use the network's provider constraints, including the vSwitch MTU limit of 1400,
even when server provider metadata is unknown. Legacy member provider/reference
fields remain available for compatibility and custom routed setups.

Migration `0138` resolves older native sources only when every attachment agrees on
both provider and reference; ambiguous or mixed configurations remain Custom.
Managed networks have no native source. Existing member metadata, saved operation
plans and request hashes are preserved. Older create/update requests may omit the
source; persistence derives it without changing the old input's idempotency hash.

Native adoption needs Linux, Python 3, iproute2, a persistent machine identity, configured
private interfaces, and mutually reachable routes. Allow the selected verification
port (default 51821) for TCP and UDP between those private addresses. Verification
checks the selected addresses and port; it does not prove that service ports are
reachable or that traffic is encrypted.
The native review uses the shared firewall panel with private peer `/32` addresses,
TCP/UDP probe rules and explicit replies for stateless firewalls. It includes the
selected private interface when known. No public SSH or WireGuard endpoint is
substituted into native rules. Host/provider rules remain administrator-owned;
workload service ports need their own rules.

The controller inspects address ownership and MTU, detects duplicate physical
hosts, then checks TCP, UDP, and unfragmented MTU-sized packets for every directed
pair. Reports survive reloads. A check has a four-minute lease; expired workers
cannot publish success. Successful observations become stale after fifteen
minutes. Temporary authenticated listeners bind only the selected private
addresses and are closed after verification; they also expire locally after
270 seconds if controller cleanup cannot reach them.

Network details open on **Topology**, with a separate **Servers** tab for attached
server inventory. Select a server to focus its
connections, or select a connection to inspect both directions. The map separates
interface checks from connection health and labels saved results with their test
time. It does not imply continuous monitoring.

Each directed check measures three UDP round trips, packet loss, and jitter in
addition to TCP, UDP, and MTU reachability. Round-trip timing excludes SSH setup,
TCP connection time, and the MTU probe. Older reports without the RTT marker keep
their reachability results but do not display their combined probe duration as
latency. Managed networks also record each WireGuard peer's handshake time,
transport endpoint, and UDP port. An isolated server can cause every host's
all-peers check to fail; retaining individual results identifies which links need
attention. Failed apply reports remain visible after rollback and are explicitly
marked as historical results from the restored attempt.

**Test speed** runs only on request for the selected pair, one direction at a
time, with a maximum payload of 32 MiB or three seconds per direction. It uses
receiver-confirmed bytes over the private connection, not the controller's SSH
connection. The existing authenticated listeners accept one bulk sample from the
selected counterpart; ordinary verification does not enable bulk transfers.
No additional package or permanent service is installed. Speed tests use the
existing durable verification job, authorization, revision checks, cleanup, and
SSE progress. Repeating the same active request reuses its job, while a different
test conflicts. Transfer failures remain distinct from successful reachability
checks and do not reconfigure or roll back a network.

The native list and detail views provide retry, edit, and inventory removal. Edits use a
captured revision and invalidate older observations. Active checks block edits and
removal. Removing an adopted network only removes its inventory after all cluster references
are cleared. Servers and provider networking stay in place. Server deletion requires
removing its compute membership and network attachments first.
Enrollment and server teardown share the existing mutex/advisory-lock mechanism,
so a concurrent enrollment cannot occur halfway through workload removal. This
lock is scoped to an organization and uses one database connection per operation.

## Managed WireGuard

Managed setup uses **prepare servers → inspect → plan → review → apply → verify → commit**.
The wizard starts a durable preparation at `/servers/networks/preparations/:preparationId`.
It checks SSH, machine identity, Linux/systemd, privilege and firewall support,
then uses the shared toolchain to install missing Python 3.8+, iproute2, and WireGuard
tools. Kernel support and JSON network inspection are checked separately. Inspection
and planning remain read-only. Transport endpoints default to resolved IPv4 SSH addresses and can
be overridden. OpenShip allocates a free subnet and private addresses; advanced
settings allow a subnet, tunnel MTU, and verification port. The review shows the
exact hosts, endpoints, private addresses, required packages, and network changes.
IP addresses respect demo-mode masking throughout setup, review, and progress.
Both preparation and installation show the shared topology above server details.
Nodes show the current saved step before connectivity results exist. Server cards
start collapsed, retain manual choices through SSE updates, and open when their
node is selected. Collapsed failures retain a short error summary. Connection
details stay compact until selected or a connection fails.

Local inspection does not establish UDP reachability. Preparation focuses on server
readiness and topology; firewall rules lead the final review, with the
confirmation directly beneath them. The shared list shows every server's inbound
and outbound rules together, without server selectors or direction tabs. Managed
rules allow incoming UDP from each connected peer `/32` to that server's listen port, and
outgoing UDP to each peer's actual port, with unrestricted source ports. Outgoing
rules are needed when egress is restricted. Individual values, a server template,
or all server templates can be copied; these are provider-neutral TSV blocks, not
provider API payloads. Only transport endpoints are included, never private service
or probe ports. Preparation publishes resolved DNS endpoints and inherited cluster
ports through its existing SSE stream; incomplete values disable full-template
copying. OpenShip manages supported host firewall rules, while provider firewalls,
upstream routing and NAT forwarding remain administrator configuration. SSH access
is never presented as proof of peer UDP access.
The panel uses restrained warning and direction icons. Failed connection diagnostics
reuse the same list; managed recovery shows it above progress, with renewed
confirmation, rather than repeating it inside the topology. Both network modes
require explicit firewall confirmation before creating/verifying or applying a network. Native
confirmation is scoped to the draft's network settings and members; managed
confirmation is scoped to the operation, plan hash, generation and status, so a
failed attempt needs confirmation again before resume. Cleanup/removal stays
available without firewall confirmation. A managed policy with no enabled
connections has no provider UDP rules to confirm; review shows the isolated
members instead. This is a UI acknowledgment, not proof of
connectivity or an authorization boundary; the existing server checks still decide
whether the network is ready.

### Connection access

The managed network topology is editable during server selection and preparation.
Click a connection to choose either initiation direction, remove the connection,
or restore it from the connection selector. A one-way connection has an arrow;
two-way connections retain the existing line. Removing a connection keeps both
servers. Directions apply to all private ports, and permitted connections include
their replies. Provider/native networks remain adopted, externally configured
networks; this editor does not claim to enforce provider-side access controls.

`NetworkAccessPolicy` is a versioned directed allowlist shared by the wizard,
contracts, planner, database, firewall compiler and diagnostics. Omitted policies
preserve existing full meshes; an explicit empty policy isolates every member.
Membership removal filters the existing rules, and never widens access. Private
network addresses are retained when a reviewed setup is revised.

Preparation edits are local until **Save and review**. The revision endpoint locks
the existing preparation and unapplied operation, atomically supersedes them with
a new request, and starts the existing preparation worker. Original inputs and
plan hashes remain immutable. Replays reuse the same request, old approval cannot
be applied, and a running attempt must settle before a revision can be saved.
Changes after host application use network settings and the existing recovery flow.

WireGuard peer entries and provider UDP templates include only connected pairs.
Transport is bidirectional even when private initiation is one-way. Owned stateful
host rules enforce both directions ahead of general established-connection rules,
cover published container ports through FORWARD, and prohibit forwarding between
WireGuard peers. They do not change public access or other private networks. The
owned subnet route prevents removed peers from falling through to the public
default route. Canonical firewall snapshots are checked before commit and recovery;
drift keeps rollback armed. Verification probes every directed pair, including
denied directions; missing SSH results are never accepted as proof of isolation.
Latency and speed measurements apply only to permitted directions.

Plans expire after fifteen minutes. Apply requires the reviewed plan hash and
unchanged cluster revision, host identity, and network fingerprint. Allocation
avoids host/Docker/VPN routes, DNS addresses, management and transport endpoints,
and other networks' ranges. Database claims prevent concurrent ownership of the
same server or physical host. Only one unsettled operation may own a cluster.

The operation page at `/servers/networks/operations/:operationId` retains per-host
steps, installation logs, verification results, errors, and recovery actions.
Failures remain in the step history after rollback. Preparation and apply pages
survive reloads; unfinished preparations also appear in the Servers cluster/network tabs.
Preparation retries recheck every prerequisite and skip healthy installed tools.
Each attempt is marked in the retained logs. Command failures identify the failed
action and distinguish SSH, permission, timeout, and host-command failures. Failed
host commands retain their command or check name, exit status, and bounded, redacted
stderr. Shell configuration, stdin, private keys, and credentials are not included.
Timeouts, missing executables, and invalid JSON identify the failing check too.
A transient failure during read-only network
inspection uses the shared SSH manager's single reconnect; it does not replay the
prerequisite stage. Network changes continue through the durable recovery workflow.
The wizard keeps the same request ID if an unchanged submission loses its HTTP
response. Selection, membership, and authority checks run under the shared inventory
lock before starting; each host step rechecks membership and authority.
The saved draft can be reopened for editing without reentering its settings. Workers use a
renewable 90-second lease and recheck authority, generation, and physical host
identity before host work. Provisioning and inventory work reuse existing locks.

API shutdown marks its own preparation, apply/recovery, and verification
runs `interrupted` before cancelling further host work, including dev hot reloads.
On boot, the exclusive PGlite owner immediately interrupts abandoned runs even if
their leases have not expired. A shared PostgreSQL controller only recovers expired
or missing leases so another live owner's work is preserved. Native exclusive
recovery uses the same path. Interrupted steps display **Stopped** and saved progress
remains available; only an explicit Retry, Resume, Restore, or verification request
starts work again. Recovery retains host receipts, rollback timers, reservations,
and logs, and never assumes remote changes have already been restored.

Preparation, apply, and overview progress use read-only SSE subscriptions through
the shared operation stream adapter and dashboard SSE reader. Each connection
replays current database state, then emits changed snapshots with a durable sequence.
Late responses cannot overwrite newer progress and replayed logs replace previous
snapshots. Subscriptions attach before reading, coalesce slow-consumer updates, and
release listeners and timers on disconnect. Notifications follow committed writes;
a fifteen-second server-side reconciliation handles other controllers, lost
notifications, and expired leases. Lease heartbeats do not advance progress sequence.
The dashboard reconnects with bounded exponential backoff, stops on terminal results
or denied access, and shows connection loss separately from setup failure.
Reconnecting the progress stream never starts/resumes host work; Retry and Resume remain explicit actions.

Ready, failed, and interrupted preparations expose **Discard setup** in the three-dot
menu on their overview card and preparation page. Saved, paused selections also offer
it on their preparation page; pending cleanup keeps its recovery flow. The same confirmation
names the selected setup and uses its current sequence; failed requests leave it
actionable and reconnect saved progress. The review page offers **Discard plan**.
Both use a shared transactional discard helper, retain diagnostics,
and leave servers, services, and installed tools in place. The `cancelled` preparation
state is hidden from pending lists and cannot be restarted with its old request ID.
Discard checks the current preparation sequence or reviewed plan hash, locks preparation
before plan, and closes both together. Plan publication checks the preparation lease
and generation inside its transaction, so an old worker cannot publish after discard.

Once apply has started, discard is blocked. An unfinished new cluster offers
**Clean up failed setup**, with confirmation, through the existing rollback operation.
The cluster detail page exposes this recovery action instead of disabling removal.
**Close setup** appears after rollback completes. Unreachable hosts keep their claims
and recovery actions until every host acknowledges cleanup. Restoring a failed edit
preserves the existing cluster; removing that cluster then uses the reviewed network
removal flow. Discarding a removal plan leaves its established network in place.

Stopped initial setup also offers **Remove from setup** on each server, with a
two-server minimum. `removeNetworkSetupMember` locks preparation before operation
and atomically creates a replacement preparation, cancels the old draft/unapplied
plan, and saves continuation links. Requests bind the removed server, source
sequence, reviewed plan hash (for operations), and a new stable request ID. The
original plan, diagnostics, and host receipts are not rewritten. Late apply/resume
requests against a replaced operation are rejected; rollback remains available.

If apply started, the replacement waits in `pending` with `cleanupOperationId`.
The existing rollback resets this attempt on all original hosts to remove stale
peer entries too. Inventory and claims remain until every host acknowledges reset.
The replacement stays in `pending` after removal and after cleanup. Only an explicit
**Retry preparation** starts the existing worker with its saved input, guarded by
completed cleanup and lineage. Removal, repeated removal requests, cleanup retries,
page reloads, and SSE reconnection never start preparation. Before network apply,
the paused selection can be edited, reduced again, or discarded. Pending SSE stays
open across explicit retries, and old pages link to the updated setup.
An unreachable host cannot be forgotten; services, disks, unrelated networks and
shared networking packages are preserved throughout recovery.

Host package installation is incremental, so successful prerequisite installations
remain available after failure. Network changes use per-host receipts, generation
fencing, verification, and compensating rollback; remote hosts do not change as one
atomic database transaction. Inventory success and release of claims remain an atomic
database transaction requiring every host acknowledgement. Uncertain outcomes keep
their claims until recovery confirms what is running on every host.

Prerequisites are installed across the fleet before rollback deadlines begin.
Every host then generates or reuses its own key, saves its prior owned config,
and arms a persistent twenty-minute systemd rollback timer. Only public keys leave
the host. Apply first stages the actual `oswg…` interface, reviewed UDP endpoints,
keys and owned firewall rules under that same receipt and timer. It waits up to
30 seconds per host for every encrypted handshake before assigning any private
addresses or routes. Failed transport retains every peer's endpoint/port and
restores the prior configuration. A successful transport is promoted without
recreating the interface or losing its handshakes; a transport-only receipt cannot
be committed. Default routes, DNS, management routes, and unrelated firewall
rules are preserved. All directed TCP/UDP/MTU probes must pass before commit; the
desired inventory changes only after every host acknowledges commit.

Committed networks restart through host-local systemd units without the
controller. Uncommitted changes restore through local timers, including missed
deadlines across reboot. A lost worker becomes **Interrupted**. Authorized users
can resume setup or restore the previous network from the operation page.
Unreachable hosts and external edits retain claims and require explicit recovery;
the controller never assumes an unreachable host restored successfully.

Managed edits support membership changes, endpoints/ports, MTU, and explicit key
rotation, retaining the allocated subnet and existing member addresses. Member
and cluster removal also require a reviewed cleanup operation. Native inventory
deletion cannot bypass managed cleanup. These operations do not drain or migrate
workloads; that remains a separate milestone.

Organization deletion also requires managed network cleanup. The shared engine
and database both refuse deletion while an Openship-owned network or an unresolved
host claim remains, so cascading inventory deletion cannot erase its recovery
history. Finish recovery and remove the managed network first. Native, externally
owned network inventory can still be removed with its organization.

Host state is root-only at `/root/.openship/networks/<managedId>`, with atomic writes
and generation-fenced receipts. Finalization removes obsolete staged keys and
backups. If SSH fails after commit, obsolete backups may remain root-only; the
live configuration and durable operation result are preserved. Private keys are
excluded from controller storage, API responses, browser state, and logs.

Managed networking requires Linux with WireGuard kernel support, Python 3.8+,
iproute2, systemd, persistent machine identity, and root or passwordless sudo.
Python 3.8+, iproute2 (4.15+), and `wireguard-tools` (1.0+) are checked and installed
through the shared toolchain before planning. Networking package recipes avoid
optional recommendations. Package output is bounded and credential-redacted before
persistence. The Linux/systemd base, persistent identity, root access, and WireGuard
kernel support must be available; preparation reports incompatible hosts with a
specific failed step. OpenShip does not replace kernels, reboot servers, change
their init system, or replace their firewall manager. Installed prerequisites remain
installed if a later network operation rolls back.
Custom connection policies additionally check conntrack support and install
iptables 1.8+ through the same toolchain on hosts without an nftables manager.

| Host firewall                          | Managed support                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| None                                   | Supported; directed policies install owned iptables rules; provider-side UDP access is still required |
| Raw iptables                           | Dedicated INPUT/OUTPUT chains and tagged jumps; custom policies also protect FORWARD                  |
| nftables                               | Standard `inet filter input/output` chains, without additional filtering IPv4 input/output base chains |
| UFW, firewalld, other nftables layouts | Refused during inspection pending an owned-rule adapter                                                |

The driver uses direct IPv4 UDP between selected peers, with 2–16 servers and a
full mesh by default. Connections may be restricted or removed. It has no
relay or automatic NAT traversal. Provider firewalls/security groups must permit
the reviewed UDP transport ports (default 51820). Subnets must be RFC1918
`/16`–`/27`. Tunnel MTU is derived from transport routes, capped at 1420, and verified.
Managed verification defaults to TCP/UDP port 45876 on private tunnel addresses.
It reuses the native authenticated temporary listeners and observation TTL.
There is no continuous controller reconciliation or automatic workload failover.

## Shared implementation

- `packages/core/src/infrastructure.ts`: provider catalog, network types,
  validation, interface selection, verification limits, and report evaluation.
- `packages/core/src/managed-network.ts`: allocation, managed configuration and
  operation types. `host-firewall.ts` owns firewall rule generation; package/init
  commands remain in the shared environment operations adapter.
- `packages/core/src/network-firewall.ts`: shared native/WireGuard guidance and
  provider-neutral copy templates, separate from host firewall mutations.
- `packages/contracts/src/server-clusters.ts`: schemas consumed by the engine,
  HTTP controllers, SDK, and dashboard. Cluster actions use the existing server
  operation surface and require fleet-wide read/admin access.
- `packages/db/src/schema/server-cluster.ts` and migrations `0129`/`0130`: network,
  network configuration, network membership, separate server network attachments, and
  verification records. Server foreign keys are deferred in SQL so organization
  cascades can remove both parent trees in one transaction after managed cleanup.
  Migration `0136` enforces that cleanup requirement at the database boundary. Direct server removal
  still fails while membership or managed claims exist. Durable managed journals,
  revision/lease fencing, claims, and commit barriers share the repository.
- `packages/platform/src/engine/modules/system/server-cluster.operations.ts`:
  orchestration over existing authorization, server access, SSH pooling, physical
  identity, audit, and background-work facilities. Workers recheck authority and
  their persisted lease before host work.
- `managed-network.operations.ts` in the same engine module coordinates managed
  plans, apply, recovery, and cleanup through those shared facilities.
- `packages/adapters/src/network/private-network.ts`: reusable Linux inspection
  and authenticated temporary probes shared by both network modes. Adjacent
  `managed-network.ts` and `managed-network-host.ts` implement the host lifecycle,
  generation receipts, persistent units, and rollback timers.
- `apps/api/src/modules/system/server-clusters.controller.ts` and
  `packages/sdk/src/server-client.ts`: thin transports over the shared operations.

Network and compute-cluster inventory, managed journals, and claims belong in whole-instance backups,
not project or organization transfer bundles. Transient verification rows are
excluded. Host keys remain with their servers and require host backups.
API/native operation guards and managed workers reject Oblien-managed Cloud before host
execution; the dashboard also hides its controls. Local and desktop self-hosted
controllers support cluster inventory and manual network verification against
registered Linux servers. These bounded checks do not require an always-on
controller; future continuous reconciliation does.

## Resource contracts and upgrades

`packages/contracts/src/infrastructure-resources.ts` defines canonical network and
compute-cluster operations on the existing server authorization surface.
`infrastructure-resources.operations.ts` delegates network work to the existing
network engine and implements compute-only membership through
`packages/db/src/repos/compute-cluster.repo.ts`. Native SDK and HTTP use the same
validation, organization checks, idempotency and revision checks.

Canonical HTTP paths are `/system/networks` (including `/preparations`, `/plans`,
`/operations`, and `/stream`) and `/system/compute-clusters`.
`/system/servers/:id/infrastructure` exposes only that server's associations.
The single overview SSE includes `networks`, `computeClusters`, and `preparations`.
Legacy `/system/clusters` API paths and its `clusters` snapshot field still refer to
networks for compatibility. Old setup/progress page URLs redirect into Networking.

Migration `0139` renames network inventory tables, adds compute pool tables, and
converts established legacy groups into compute pools referencing their original
networks. In-flight or unresolved managed setups remain independent networks so
rollback can complete. Network IDs, attachment IDs, verification history, signed
plans, hashes, leases and host receipts are preserved. Legacy TypeScript exports
and serialized `clusterId` fields in approved plans still identify the network;
rewriting them would invalidate recovery. Whole-instance imports accept the old
network table names and the new ones. Infrastructure does not travel in project
or organization transfer bundles.

## Scope of this increment

This delivers independent network and compute-cluster lifecycles, shared network
setup, expandable network groups, native adoption and managed WireGuard. Live connections between whole networks are deferred: they
need explicit gateway selection, route/return-route management, subnet overlap
validation, access policy, verification and an independent recovery flow. No
inter-group connections are drawn or exposed as working actions.
Provider API
provisioning, vSwitch attachment, guest VLAN configuration, cross-server Docker
and service endpoints, private service DNS, workload drain/placement/replicas,
shared storage, additional firewall managers, and larger meshes remain in
[the architecture plan](../../../../../../docs/self-hosted-clusters-and-private-networking.md).
No unavailable provisioning choice is presented as a working action.

## Validation

Focused suites cover shared validation, organization isolation, retries,
verification expiry and revision fencing, physical host aliases, membership
constraints, migration upgrades, backup coverage, authorization/revocation,
Cloud rejection, desktop access, HTTP/native parity, SDK transport, and observation
age. The Servers page also covers tab visibility, capability loading/errors, and
retry. Browser checks include navigation through the local desktop dashboard.
Managed tests also cover review-before-apply, SSE replay/reconnection, expired
reviews, claim conflicts, exact plan hashes, revoked authority, partial failures,
and generation fencing. Browser checks cover light/dim/dark themes, provider
logos, IP masking, progress, recovery, removal review, and narrow layouts.
Stream tests cover dropped connections, repeated short connections, idle timeouts,
revoked access, slow consumers, controller reconciliation, out-of-order responses,
terminal replay, and subscription cleanup without starting work.
Discard tests cover stale views, cancelled retries, late plan publication, discard
racing apply, linked and orphaned preparation plans, retained diagnostics, and
preservation of established networks. Cleanup tests require every host acknowledgement
before releasing server reservations; UI checks cover confirmation and closing setup.
Diagnostic tests execute the Python TCP/UDP and bounded transfer probes over local
loopback sockets, including lost packets, receiver receipts, and ordinary listeners
rejecting bulk traffic. WireGuard report fixtures cover isolated peers and interface
drift; operation tests verify those results survive rollback. Browser fixtures cover
connection selection, explicit speed requests, SSE completion after reload, and
read-only access.
Transport lifecycle tests execute the complete Python host program with real
temporary receipts and substituted OS commands. They cover promotion without
interface replacement, refusing premature commit, partial failures, configuration
drift, reboot behaviour and timer-driven restoration. Browser fixtures also check
that preparation steps update above collapsed cards, node selection opens details,
manual choices survive SSE, and narrow viewports refit the topology.

Run real Linux probes in disposable containers on an explicitly selected Docker
context:

```sh
bun packages/adapters/scripts/verify-private-network.ts <docker-context>
bun packages/adapters/scripts/verify-managed-network.ts <docker-context>
```

The script exercises private binding, bidirectional TCP/UDP/MTU, occupied ports,
invalid tokens, MTU failure, blocked UDP, cleanup, and the 16-member / 240-directed-
connection limit. Its containers and network use no host ports or mounts, and it
removes the resources it created. These checks do not replace validation on each
provider's real network.

The managed fixture uses three Linux/systemd hosts across supported firewall
drivers. It removes Python, iproute2, and WireGuard tools from one host, verifies
automatic installation from its package repositories, and checks that a second
preparation reuses the installed tools. It needs outbound access to the package
repositories. It also checks encrypted handshakes before private addresses exist,
preservation of the verified interface during promotion, Docker inspection failures,
real keys, all directed TCP/UDP/MTU paths, blocked transport,
committed reboots, key rotation, stale generations, controller-free local rollback,
missed deadlines across reboot, membership changes, and removal while preserving
unrelated firewall rules. It also uses no host mounts or published ports and
removes only its own resources. Registered customer servers are never used by
these fixtures.
