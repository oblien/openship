**Self-hosted clusters and private networking: proposed plan**

Status: architecture agreed, September 16, 2026. The first implementation adds
persisted server clusters and verification of already configured native private
networks. Host configuration, WireGuard, and cluster workload placement remain
subsequent stages. See the [implementation notes](../apps/dashboard/src/components/servers/clusters/README.md)
for the current capabilities and verification scope.

**Make server clusters a shared infrastructure resource, and keep project topology as the place to operate applications.** A cluster groups customer-managed servers, their private connectivity, and their available capacity. A project environment uses that infrastructure for its services. Adding a server increases capacity; scaling a service decides how that capacity is used.

OpenShip should provide one cluster model across providers, with two networking drivers: existing private networking and managed WireGuard. Provider integrations supply the appropriate discovery, forms, validation, and optional infrastructure operations. Custom servers use the same lifecycle and health checks.

Private networking comes first. Cross-server service connections follow, then coordinated placement and replicas. Shared storage has its own capabilities and lifecycle. Creating an infrastructure cluster alone does not establish database replication, workload failover, or storage availability.

**Scaling belongs to customer-managed infrastructure.**

“Self-hosted” describes management authority here. An AWS VM or Hetzner Cloud server controlled by the customer qualifies. An OpenShip Cloud workload managed by Oblien follows the cloud platform's controls, including when the dashboard accessing it is self-hosted.

| Context                                                | Cluster and private-network controls                        | Project scaling behavior                                       |
| ------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------- |
| Self-hosted OpenShip, customer-managed Linux servers   | Available according to permissions and runtime capabilities | OpenShip manages placement, resources, and eventually replicas |
| Self-hosted OpenShip, project targeting OpenShip Cloud | No infrastructure controls for that workload                | Existing Oblien-supported resource and deployment controls     |
| OpenShip Cloud installation                            | Self-hosted infrastructure module unavailable               | Oblien manages the underlying infrastructure                   |
| Project without a deployment target                    | Infrastructure can be prepared separately                   | Use the existing target-selection flow before enabling scaling |

The backend must derive this authority from canonical platform and deployment state. Frontend `selfHosted` state, presentation preferences, a submitted server ID, and stale deployment metadata cannot grant it. Intended placement and the location of the active release must remain distinct during migration.

Use a shared capability policy for dashboard, API, SDK, CLI, and background workers. Reject unavailable operations before reading infrastructure credentials, opening SSH connections, calling a provider API, or queuing work. Workers recheck ownership and authority before mutation. Cloud builds using host infrastructure do not grant cluster-management access.

The dashboard receives these capabilities and shows the relevant controls. Cloud project topology can retain its service graph, deployment actions, and supported settings. The new self-hosted scaling inspector and server-cluster actions are absent there. Local and desktop self-hosted controllers can manage cluster inventory and run manual network checks against registered Linux servers. Future continuous production reconciliation needs an always-on self-hosted controller; desktop clients can connect to it.

**Providers should be first-class integrations with shared mechanics.**

Use three layers:

1. **Provider profile:** product identity, typed configuration, supported capabilities, region/network references, setup instructions, and validation. Optional provider API adapters discover or create infrastructure.
2. **Network driver:** inspect and configure the actual host networking, verify connectivity, and remove configuration it owns. Initial drivers are native networking and WireGuard.
3. **Cluster coordinator:** membership, address allocation, permissions, operation history, readiness, retries, and reconciliation. This layer works across providers.

The initial provider catalog should target these adoption workflows:

| Provider profile  | Existing infrastructure to adopt                       | Profile-specific responsibility                                                                 |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Hetzner Dedicated | Robot vSwitch                                          | VLAN attachment, private addressing, persistent host configuration, and vSwitch MTU constraints |
| Hetzner Cloud     | Cloud Network and subnet                               | Existing private interface, assigned addresses, and routes; separate profile from Dedicated     |
| AWS               | VPC, subnet, and instance interfaces                   | Network references, private addresses, routes, security-group and network-ACL prerequisites     |
| Azure             | VNet, subnet, and VM interfaces                        | Network references, private addressing, routes, and network-security-group prerequisites        |
| Google Cloud      | VPC, subnet, and VM interfaces                         | Network references, private addressing, routes, and firewall prerequisites                      |
| DigitalOcean      | VPC                                                    | Private interface discovery and firewall/readiness checks                                       |
| OVHcloud          | vRack for supported server products                    | Product-specific attachment requirements and host network configuration                         |
| Scaleway          | Private Network                                        | Interface/address discovery and product-specific attachment prerequisites                       |
| Custom            | Existing LAN, VLAN, routed VPN, or public-only servers | Typed manual configuration, native adoption, or WireGuard setup                                 |

These are proposed integrations. Each profile becomes available only after its adoption flow and verification pass. “First-class” means usable configuration, accurate errors, documented prerequisites, and tested lifecycle behavior. Provider logos alone do not qualify.

Adopting an existing network should work without provider credentials. API discovery, network creation, server attachment, and server provisioning are separately advertised capabilities. A profile can support adoption before it supports creation. Show only implemented actions, and record whether a resource is externally owned or created by OpenShip.

Provider identity belongs to server and network attachments, allowing one cluster to contain several providers. Custom configuration gets the same review, progress, recovery, and health UI. It accepts validated fields; arbitrary shell scripts supplied through the dashboard are outside this model.

**Choose networking from verified reachability.**

| Network mode             | Recommended use                                                                                         | What OpenShip manages                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Existing private network | Members already have, or can be attached to, mutually reachable private networks                        | Adopt interfaces/routes; configure explicitly requested VLANs and addresses; verify connectivity |
| Managed WireGuard        | Public-only servers, disconnected provider networks, mixed infrastructure, or an encryption requirement | Host keys, peer configuration, overlay addresses, routes, firewall changes, and health           |

Native networking is selected only after connectivity is verified. Matching providers or private-looking addresses do not prove that servers can communicate. The contract is routed IP connectivity; servers do not need to share a Layer 2 network or one subnet.

For Hetzner Dedicated, the user can create the vSwitch and attach servers in Robot. OpenShip then configures the guest VLAN interface and private addresses, using the documented MTU of 1400. Existing provider-assigned addresses and DHCP remain authoritative on products that supply them. A provider-specific manual step should have a clear verification action before continuing.

For WireGuard, prefer reachable private transport addresses between peers when available, and public addresses where needed. Select transport endpoints per peer. Native networks can carry encrypted WireGuard traffic. The UI distinguishes private connectivity from encryption rather than implying all provider networks are encrypted.

Start with directly reachable UDP peers and a small-cluster full mesh. Detect unsupported NAT/firewall conditions during preflight. Publish a tested member limit before launch; larger meshes, automatic NAT traversal, and relays need separate validation or an established mesh implementation behind the same driver contract. Traffic flows directly between servers, independently of the OpenShip controller.

Joining a native cluster requires joining its verified private network. Changing a cluster to WireGuard is an explicit, reviewed operation. Network mode changes and address changes must account for existing service endpoints before application.

Every plan validates IP uniqueness, address ownership, routes, DNS conflicts, and overlap with Docker, host, VPN, and management networks. It records whether address allocation belongs to the provider, the administrator, or OpenShip. MTU is derived from the actual transport and verified across peers, including encapsulation overhead.

Keep the SSH management address separate from cluster addresses. Preserve management routes throughout setup. WireGuard private keys should be generated and retained on their servers; the controller stores public keys and references. Each server may have multiple network attachments, leaving room for a separate storage network later.

**Give infrastructure and workloads clear places in the UI.**

Use **Servers → Clusters** for membership, networking, capacity, health, and operations. Keep **Project → Environment → Topology** for services, connections, configuration, deployment, and scaling.

The cluster creation flow should be a short wizard:

1. Name the cluster and select existing servers. Adding a server reuses the current connection/setup flow.
2. Inspect their provider metadata and interfaces; suggest existing networking or WireGuard based on evidence.
3. Collect only missing information, such as a network reference, VLAN, address range, or transport endpoint.
4. Review the exact servers, interfaces, addresses, routes, firewall changes, and any provider-side actions.
5. Apply with per-server progress, verification results, and a recoverable operation record.

A cluster overview should show usable capacity, membership, network health, and active operations. Distinguish SSH reachability, network readiness, and runtime readiness. Provide clear join, retry, drain, and remove actions. An unreachable member retains its last observed state and is marked stale.

Project topology shows its placement and a link to the owning cluster. “Add capacity” opens the cluster flow with context; infrastructure remains organization-owned and can serve multiple projects. Offer cluster deployment targets only when the backend can actually place workloads there. Until then, projects retain their existing server targets.

Preserve the compact inspector, expandable settings, background overlay, automatic main-sidebar collapse, and back navigation already established in topology. Keep provider/service colors as useful identity cues. Use neutral surfaces for forms and choices. New strings, keyboard behavior, loading states, and narrow layouts follow existing dashboard conventions.

**Use explicit domain objects and ownership.**

The following names describe responsibilities; implementation should follow existing repository conventions.

| Object                                          | Responsibility                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Provider profile / optional provider connection | Versioned capability schema; organization-scoped account references and encrypted credential references                             |
| Cluster                                         | Organization, name, primary network, locality, desired revision, and observed status                                                |
| Cluster member                                  | Cluster/server relationship, join/drain state, verified host identity, and runtime capabilities                                     |
| Network                                         | Driver, address ranges, allocation authority, MTU, encryption, ownership, and desired configuration                                 |
| Server network attachment                       | Server/network relationship, provider references, interfaces, addresses, transport endpoints, owned configuration, and observations |
| Address lease                                   | Unique allocated address and reservation owner; coordinated allocation across concurrent operations                                 |
| Operation plan / run                            | Reviewed revision, ordered steps, execution receipts, redacted events, recovery state, and audit identity                           |
| Later: environment placement / service instance | Typed server-or-cluster target; logical service identity separated from its individual runtime instances                            |
| Later: private endpoint / connection policy     | Logical service destination, current private addresses and ports, and authorized consumers                                          |

Initially, one server belongs to one active compute cluster. Multiple network attachments remain possible. Use verified host identity to detect duplicate inventory entries pointing at the same machine, and prevent competing management ownership.

All references must remain within the authorized organization. Desired configuration and observed health are separate. Adopted provider networks retain external ownership: removing a cluster must not delete a customer's VPC or vSwitch.

Introduce cluster placement through explicit, versioned contracts and a deliberate database migration. The current environment is a project record with a server binding. A cluster target needs its own representation, and deployments must snapshot the actual placements. Choosing one member's server ID as a stand-in would make migrations and runtime operations ambiguous.

**Networking operations need durable recovery from the first release.**

Use inspect → plan → review → apply → verify → commit. Planning is read-only. Execution rejects stale plans, acquires server and network/address-allocation locks in a consistent order, and records each completed step. Retries resume from persisted receipts with idempotent operations.

Reuse existing SSH executors, provisioning locks, audit facilities, progress presentation, and server authorization. Add a durable network operation journal; existing setup progress alone is insufficient for recovering a partially configured cluster after a controller restart.

Before a change that can disrupt connectivity, prepare a host-local rollback timer and configuration backup. Cancel the timer only after verification succeeds. Recovery must work if the controller loses SSH. Write configuration persistently through supported host network managers, track ownership and prior hashes, and detect external edits before overwriting anything. Start with an explicit tested Linux/network-manager support matrix; unsupported hosts fail preflight.

Peer verification includes the required TCP/UDP paths and MTU behavior. ICMP success alone cannot establish readiness. A partially configured member receives no new workload placements. Draining evaluates running workloads and storage dependencies before removal. Restoring network files does not reverse a completed data migration; those recovery steps remain in the migration lifecycle.

Controller outages leave established networking and workloads running. New changes wait for the controller. Its database and configuration backups remain necessary for management recovery. Credentials, private keys, and secret outputs are excluded from browser persistence and operation logs.

**Cross-server service access is a separate delivery milestone.**

A private host network does not connect Docker bridges across hosts. Preserve the existing same-host service-network implementation and add a cross-server path with private endpoints and explicit policy.

Publish a service on the intended private interface through runtime adapters and the existing port-claim machinery. Allocate a stable private port for the logical endpoint within its network scope, and validate destination conflicts before a move. Never silently bind a private service to every host interface. Native-network firewall policy and provider-side rules also need verification.

Provide stable internal service names through a small private DNS component, with a namespace chosen to avoid existing DNS conflicts. A resolver such as CoreDNS is a candidate implementation, not an existing OpenShip capability. Configure workload resolution explicitly, preserve normal upstream DNS, and persist the last valid zone locally. DNS resolves addresses; endpoint outputs still include the actual port. Changes to ports or credentials use the existing connection-output and consumer-redeploy flow. DNS updates alone do not provide instant failover for cached addresses or existing connections.

The connection policy must identify allowed workloads. WireGuard authenticates hosts, and Docker can translate several environments to one host address. Enforce consumer policy before that translation and validate private ingress; a host-level allowlist alone cannot isolate projects on the same server. Host administrators remain trusted. Cross-server connections ship only after these enforcement paths are tested on supported runtimes.

The existing same-server restriction is replaced only for connections with a ready network, a verified endpoint, and enforceable policy. Existing project bindings apply to the whole consuming environment, and that scope remains explicit. Per-service credentials/access require an explicit contract extension. A topology “Starts after” wire continues to describe a startup dependency.

**Reuse migration execution when workload coordination is ready.**

Existing clone and move flows already provide valuable transfer, launch, cutover, and recovery behavior. Reuse those operations beneath cluster placement. A migration clone remains an independent copy until a managed instance model exists.

The first coordinated scaling release should target stateless application replicas. It needs desired replica counts, placement constraints, capacity checks, instance identity, health admission, routing updates, draining, and coordinated deployments. Start with explicit user-selected placement and reviewed changes. One update to a logical service must reach its managed instances through the existing deployment pipeline.

Route healthy instances through OpenShip Edge using the existing routing contracts, extended deliberately for multiple destinations. Scaling down drains traffic before stopping an instance. Automatic rescheduling needs fencing and stateful-workload rules before it can safely replace an unreachable instance; it is a later capability.

Database clustering remains a service-type capability. PostgreSQL replication, Redis replication/Sentinel/Cluster, and a standalone database have different operations and guarantees. Generic cloning cannot establish those guarantees. Database workflows should come from typed, versioned engine capabilities and verification, building on the existing service catalog.

**Storage should attach through its own capabilities.**

| Storage need                 | Recommended direction                                                | Constraint                                                                             |
| ---------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Uploads, artifacts, backups  | S3-compatible object storage                                         | Applications must support object storage                                               |
| Shared filesystem            | Adopt an existing NFS service first                                  | A basic single-server NFS deployment has that server's availability                    |
| Replicated shared filesystem | Later CephFS or another validated distributed filesystem integration | Requires capacity planning, failure-domain design, monitoring, and recovery operations |
| Database data                | Engine-native replication and backups                                | Independent database processes must not share one writable data directory              |

Future storage contracts should declare attachment scope, access modes, mount behavior, durability expectations, and placement constraints. Membership in a cluster never implies that local disks are available on other servers. Keep initial production clusters within suitable low-latency locations; mixed-provider support does not make every geography appropriate for database or storage replication.

**Build this through the existing package boundaries.**

| Existing code                                                                                                                                                                                                     | Planned reuse or extension                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Server access policy](../packages/platform/src/engine/modules/system/server-access.ts) and [platform mode](../packages/platform/src/engine/lib/platform-mode.ts)                                                 | Central self-hosted capability policy, organization checks, and execution restrictions       |
| [Project target resolution](../packages/platform/src/engine/modules/projects/project-deploy-target.ts)                                                                                                            | Canonical ownership and the distinction between intended and live placement                  |
| [Shared contracts](../packages/contracts) and [database schemas](../packages/db/src/schema)                                                                                                                       | Typed cluster/provider/network operations, persistence, and client generation                |
| [System adapters](../packages/adapters/src/system) and [platform composition](../packages/adapters/src/platform.ts)                                                                                               | Generic host/network drivers exposed only by the appropriate platform capabilities           |
| [Server installation operations](../packages/platform/src/engine/modules/system/server-install.operations.ts)                                                                                                     | Existing SSH/setup patterns and progress; extend with durable network execution              |
| [Project connection service](../packages/platform/src/engine/modules/projects/project-connection.service.ts) and [same-host networks](../packages/platform/src/engine/modules/projects/shared-service-network.ts) | Existing binding semantics plus a verified cross-server connection path                      |
| [Migration orchestration](../packages/platform/src/engine/modules/migration)                                                                                                                                      | Transfer, clone, move, cutover, and rollback execution beneath future placement coordination |
| [Project topology](../apps/dashboard/src/components/topology/README.md)                                                                                                                                           | Current service controls, inspector, deployment review, and migration UI                     |

Provider definitions and domain planning stay independent of frontend components. Privileged operations live in adapters and the engine. UI components consume shared contracts and capability responses. Avoid a second deployment queue, separate clone engine, or provider-specific cluster implementations.

**Deliver in stages with concrete release gates.**

| Stage                                   | Deliverable                                                                                                                         | Exit condition                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1. Authority and foundations            | Backend/UI capability boundaries, typed provider catalog, cluster/network records, operation planning and persistence               | Cloud and organization boundaries hold through every supported entry point; plans are inspectable and resumable                 |
| 2. Native networking                    | End-to-end adoption, starting with Hetzner Dedicated and custom routed networks; expand to the catalog's private-interface profiles | Configuration persists, management access survives, failed joins recover, and each exposed profile passes its adoption checks   |
| 3. WireGuard and infrastructure release | Mixed-provider clusters, key/peer lifecycle, add/drain/remove, health, and cluster overview                                         | Both network modes and custom setup pass recovery and connectivity tests on the supported host matrix                           |
| 4. Private services                     | Private endpoints, DNS, port allocation, enforced connection policies, and cross-server bindings                                    | Supported consumers reach the intended service; other environments cannot; public exposure and existing bindings remain correct |
| 5. Project scaling                      | Explicit cluster placement, managed stateless instances, coordinated updates, routing, and migration reuse                          | A service can scale out, update, and scale in with health checks and recoverable partial failures                               |
| 6. Storage and specialized clusters     | Storage capability adapters, engine-specific replication workflows, and later automation                                            | Each advertised capability has its own tested failure and recovery behavior                                                     |

The first production deliverable is stages 1–3: useful, provider-neutral server clusters with working private networking. Existing server-bound projects continue operating while stages 4–5 are developed. Provider API provisioning can be added per integration after adoption works. Autoscaling, automatic failover, relays, and distributed storage stay outside the initial infrastructure release.

Release checks must cover:

- Cloud deployments accessed from a self-hosted dashboard, forged targets, stale snapshots, cross-organization references, and worker retries: no unauthorized infrastructure calls occur.
- Native VLAN and routed-network persistence, provider-managed addressing, custom interfaces, mixed-provider WireGuard, closed UDP ports, address conflicts, and MTU failures.
- Lost SSH during setup, controller restart, repeated apply, concurrent joins, external configuration edits, key replacement, partial completion, and safe drain/removal.
- Existing local Docker sharing, service connection outputs, migration clone/move semantics, and Oblien-backed deployment/resource operations retain their expected behavior.
- Before private service access ships: no public private-port exposure; policy tests include two environments sharing one source server with only one authorized; DNS and endpoint changes reach consumers correctly.
- Before coordinated scaling ships: unhealthy instances receive no traffic, interrupted rollouts remain recoverable, scale-in drains connections, and ordinary clones are never counted as managed replicas.

Provider behavior must be checked against current product documentation and real host tests before declaring support. The Hetzner Dedicated VLAN and MTU details above are based on [Hetzner's vSwitch documentation](https://docs.hetzner.com/robot/dedicated-server/network/vswitch/); they are specific to that product.
