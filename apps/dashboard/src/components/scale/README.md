# Scaling planner components

The production workspace is now [Project topology](../topology/README.md) at
`/projects/:id/topology`; `/scale` redirects to the project list. The example
planner described below is retained for capability development and tests and
is not rendered by a dashboard route. Its example does not provision servers,
configure OpenShip Edge, run an autoscaler, or change databases. Shared canvas
edges and the collapsible details panel are reused by project topology.

## Topology

- **OpenShip Edge** is a single resource type handling ingress, TLS termination, API routing,
  health checks, and load balancing. There is no standalone
  load-balancer module. Gateways connect directly to application instances or to other gateways.
- **Applications** are runtime-agnostic APIs, websites, or HTTP services. Shared configuration lives
  in `draft.services`; every stateless instance is its own `draft.nodes` entry, with its own position,
  region, and connection handles. There is no aggregate application node containing replica rows.
- Scaling an application creates/removes actual instance nodes. New instances start unconnected.
  Each wire connects exactly its source and destination nodes; adding, editing, or removing it leaves
  sibling instances and their connections alone. Removing an instance removes its incident edges.
- **Databases** support PostgreSQL and Redis, each with a **Standalone** or **Cluster** deployment
  choice in the node palette. Standalone is the default when creating a database. It is a single
  node with its own name, region, CPU, and memory; standalone PostgreSQL also has storage capacity.
  Individual application instances can connect to either deployment type.
- **Database clusters** are movable groups in the overview. An inset composition panel shows primary
  and replica counts, replication links, and any unconnected replicas from the actual member topology.
  The card also shows the engine, total members, and placement. **Open cluster** (or double-click)
  enters a separate canvas. Each primary and
  replica is an individually movable member with its own name, region, and replication connections.
  A visible **Back to overview** button returns to the service topology; each view retains its own
  pan and zoom. Expanded member, replication, and cluster settings include the same return action.
- **PostgreSQL clusters** have one writable primary and zero to eight read replicas. Failover planning requires
  a replica. Replicas can stream from the primary or another replica. Primary-to-replica links support
  synchronous or asynchronous replication; cascading links are asynchronous. This is read scaling,
  not multi-primary or write sharding.
- **Redis clusters** have three to twelve primary shards and one or two replicas per shard. The optional slot
  preview and member cards partition all 16,384 hash slots; a cluster-aware client is required.
  Adding a shard includes its replicas; adding a replica per shard updates every shard. Removing a
  shard removes its members and connections together, preserving the minimum of three shards.

Inside a cluster, selecting a member or connection highlights it and shows a minimized settings panel.
Expanding it exposes member placement or connection source and mode settings.
Replication can be disconnected and reconnected using the handles
or the source selector. A replica has at most one source, and loops, cross-cluster connections, and
cross-shard Redis replication are rejected. Disconnected replicas remain visible as unconnected.
Cluster settings control capacity, default placement for new members, and PostgreSQL failover planning.
Resizing preserves retained members, custom placement, and deliberately disconnected connections.

Self-connections, routing cycles, duplicates, incompatible node pairs, and dangling references are
rejected. Autoscaling bounds and graph size are checked when scaling; connection budgets are checked
when wiring nodes. Local validation is not a production-readiness or health check.

## UI and rendering

The canvas is an absolute, full-size layer filling the dashboard workspace. Floating command groups
provide workspace identity, undo/redo, auto-layout, and a primary Add node action; they do not consume
canvas space. PostgreSQL clusters expose a direct **Add replica** action. Redis clusters expose an
**Add to cluster** menu with **Add shard** and **Add replica per shard**, including the scope of each
action and a reason when its capacity is reached. Cluster settings and member layout remain available.
Toolbar groups and their menus, inspectors, and nodes use borders without drop shadows. There are no summary
tiles, save controls, or fixed-height canvas cards. The right-hand
340px settings panel is an overlay at **every** breakpoint, never a flex/grid column. Opening, switching,
or closing it does not change the canvas dimensions or its pan/zoom transform.

Adding a node opens its Configuration panel immediately so its options can be set. Selecting an
existing node shows an 80px-tall header at the top right, aligned with the toolbar. Adding a replica
or shard opens the new member's settings; adding replicas across Redis shards opens cluster settings.
**Expand settings**
extends it down to the bottom inset without changing its 340px width or top position. Once explicitly
opened, the panel follows selection while editing. **Minimize** (or Escape inside the panel) restores
the header while retaining the selection, tab, and scroll position. A dropdown consumes Escape
before the panel does. Closing clears the selection. Settings content loads only after opening it;
minimizing keeps that content mounted and hidden so work can resume in place.

Selecting a connection opens a compact panel with colored From/To endpoints and its protocol and port.
A labeled **Settings** button with a gear icon expands the panel; **Remove** is a separate action.
Expanding an overview connection exposes an optional name, protocol, destination port,
and enabled state. HTTP routes support HTTP/HTTPS; database connections support TCP/TLS. Disabled
connections remain visible as dashed lines and do not count toward reachability. Each connection's
settings are independent. Cluster connections expose their replication source and mode instead.

Expanding settings fades in a lightly blurred backdrop over the workspace. The covered canvas and
toolbar are inert until settings are minimized; clicking the backdrop minimizes without clearing
selection. The backdrop fades out on minimize or close, and reduced-motion preferences disable the
transition. The dashboard navigation remains available.

Toolbar groups wrap within the space to the left of the panel. On narrow canvases, the toolbar sits
below the measured compact panel and is hidden while settings are expanded, keeping panel controls clear.

Entering `/scale` temporarily collapses the dashboard sidebar to its 72px icon rail. It can still be
expanded manually during the visit. Leaving restores the sidebar's previous preference, and each
new Scale visit starts compact again.

The initial topology fits once. Subsequent fitting is requested by topology actions (add, scale,
layout, or reset) or the Fit button, not selection, focus, configuration edits, or container resizing.
Users keep control of the viewport while working with node settings. Fitting leaves room for the
toolbar (including its two-row compact layout) and bottom controls.

Surfaces and controls still follow OpenShip: `bg-card` / `rounded-2xl`, `Button`, `Input`, `CustomSelect`,
`Tabs`, and `Switch`. Nodes and resource panel icons use subtle type colors from the existing theme.
The node palette uses separated cards with each type's own tinted background, border, and icon:
amber for OpenShip Edge, green for applications, blue for PostgreSQL, and red for Redis.
Choosing a database engine opens Standalone and Cluster cards with short descriptions. Sizing and
member counts are configured in the inspector after adding the node. Back returns to the engine list
and restores focus.
Export and reset live in the canvas options menu, not in permanent page chrome.

The editor is lazy-loaded without SSR and inspectors are separate on-demand chunks. Custom nodes
and edges are memoized; type registries are stable and viewport culling is enabled. Drag-frame state
stays in the canvas; only completed moves, including keyboard moves, enter draft history. The minimap
and Redis slot details mount only when requested. Routes show protocol labels when selected to avoid
cluttering the graph; cluster replication labels remain visible inside the cluster. Drafts are bounded
to 60 overview nodes, 180 service connections, and 24 instances per app. PostgreSQL clusters contain at
most 9 members and Redis clusters at most 36; nested members do not consume overview node capacity.

## Persistence

Completed changes are automatically stored locally after a short debounce, scoped to user and
organization. Pending changes flush on navigation or page exit; dragging does not write storage on
every frame. The serialized model remains **version 2**, with the same storage key as the prototype.
Each database records an explicit `mode` (`standalone` or `cluster`). Older version-2 databases without
this field are restored as clusters, retaining their configuration and routes. Cluster resources use
an optional `topology` field for member nodes and replication edges; standalone databases have no
replica, shard, or member topology settings. Count-only clusters materialize members on the first edit.
Nested topology is validated during loading and saving; serialized drafts are limited to 2 MB.
Overview connections accept optional `label`, `protocol`, `port`, and `enabled` fields. Older wires
without options keep their endpoints and use destination defaults. Partial application routing is valid.
Version 1 combined service nodes and separate load balancers are incompatible: the editor shows a
notice without overwriting old storage until the user explicitly chooses to replace it. Invalid
drafts and storage failures show a recoverable notice. JSON export is not a deployment manifest.

Undo/redo retains 40 edits. Instance creation, connection edits, and removals are undoable operations.
Selection, zoom, and minimap visibility are transient. Node positions are saved. UI copy is currently
English; the sidebar entry is localized. Cluster edits share the same history and JSON export as the
overview. Undoing the creation of an open cluster returns safely to the overview.

## Backend boundary

The capability catalog and validated topology model live in [`@repo/core/scale`](../../../../../packages/core/src/scale/README.md).
The local `topology.ts` and `clusterTopology.ts` files are compatibility exports; there is no separate
dashboard copy of the rules. The palette, cluster commands, resource limits, replication modes,
connection compatibility, and persisted validation consume the shared definitions. The catalog is
version 1 and explicitly marked `planning`; the serialized draft schema remains version 2.

This is separate from the existing app installation catalog and its template schema. An installable
database does not automatically support clustering or scaling. Each engine and deployment mode must
have implemented operations and validation before it is advertised in the Scale catalog.

A future validation/application API must map applications and instances to real projects and servers,
enforce permissions and placement, and reconcile desired configuration with observed state. Edge
customization belongs in the OpenShip Edge integration, not a separate load-balancer
service. Database replication/failover and Redis rebalancing require backend orchestration and an
explicit review/apply operation; local layout persistence must never apply infrastructure changes.

```sh
bun run --cwd packages/core test src/scale
bun run --cwd packages/core lint
bun run --cwd apps/dashboard test src/components/scale src/lib/sidebar-nav.test.ts
bun run --cwd apps/dashboard lint
```
