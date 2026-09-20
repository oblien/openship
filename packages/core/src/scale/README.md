# Scale planning model

`@repo/core/scale` is a browser- and server-compatible module with no React or provider dependencies.
It owns the supported capabilities, the versioned desired topology types, runtime validation, and
graph commands used by the Scale workspace.

## Contract

- `catalog.ts` exports the serializable `SCALE_CATALOG` (version **1**, stage **planning**) and
  per-engine `DATABASE_CATALOG`. Definitions include deployment modes, defaults, capacity limits,
  member roles, access and removal rules, replication sources and modes, connection protocols and ports, and
  stable command IDs with their scope. Limits are OpenShip planning limits, not database engine limits.
- `topology.ts` defines the `ScaleDraft` **version 2** schema, its resource union discriminated by
  `kind` and database `mode`, and `parseDraft(serialized)` for runtime validation. It validates
  configuration, references, routing, capacity, and nested member graphs. Unknown kinds, modes, and
  mixed engine settings are rejected. Legacy version-2 databases without a `mode` are restored as
  clusters. Serialized input is bounded to 2 MB in UTF-8.
- `clusterTopology.ts` provides `availableClusterAdditions`, `addClusterMember`, `configureCluster`,
  member removal, replication source/mode commands, and nested graph validation. Command availability
  and execution enforce the same catalog limits. Commands return new values without modifying the
  original resource; retained members keep their identities, custom settings, and disconnected links.

| Deployment            | Structure                                   | Creation actions inside the cluster                                                                                   |
| --------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL standalone | One database instance                       | None                                                                                                                  |
| PostgreSQL cluster    | One primary, 0–8 read replicas              | `add-replica` — one reader connected to the primary                                                                   |
| Redis standalone      | One database instance                       | None                                                                                                                  |
| Redis cluster         | 3–12 primary shards, 1–2 replicas per shard | `add-shard` — a primary with its configured replicas; `add-replica-per-shard` — one additional replica on every shard |

PostgreSQL supports asynchronous cascading replication; synchronous replication requires a primary
source. Redis replicas follow their own shard's primary asynchronously. Redis replica counts are
uniform across shards in this model, and clients must support Redis Cluster. These structures are
explicit; PostgreSQL multi-primary, Redis Sentinel, and other engines are not implied by a generic
"cluster" flag.

The dashboard uses the catalog for palette choices, action labels and availability, configuration
bounds, and replication options. A standalone database cannot receive a member command. A PostgreSQL
cluster cannot receive a Redis shard command. Unsupported commands and capacity violations throw;
they never silently perform a different action.

```ts
import {
  addClusterMember,
  availableClusterAdditions,
  isClusterResource,
  parseDraft,
} from "@repo/core/scale";

const draft = parseDraft(serialized);
if (!draft) throw new Error("Invalid topology");

const database = draft.nodes.find((node) => node.id === resourceId);
if (database && isClusterResource(database)) {
  const actions = availableClusterAdditions(database);
  const action = actions.find((entry) => entry.id === actionId && !entry.disabled);
  if (!action) throw new Error("Unsupported cluster action");
  const updated = addClusterMember(database, action.id);
  // Replace this resource in the desired draft; applying infrastructure is a separate operation.
}
```

## Production integration

The existing app installation catalog (`../apps/catalog/`) and its template schema describe app
packages, containers, configuration, and endpoints. They do not describe these distributed topology
operations. Installing a Redis-compatible app does not make it a Redis Cluster. A future provisioner
must explicitly map a Scale engine and deployment mode to an implementation and supported versions.

The current UI saves a local plan; catalog support does not claim that a production provisioner exists.
Before applying a plan, a backend must:

1. Authenticate and authorize the target project and resources, validate the desired draft, and
   enforce the actual provider's placement, capacity, and engine capabilities. The current region
   list is for planning; it is not an inventory of deployed infrastructure.
2. Resolve durable infrastructure identities, storage, networks, and credential references. Keep
   observed health and replication status separate from the desired graph.
3. Produce a reviewable change set and reconcile it through engine-specific operations, including
   PostgreSQL replication/failover and Redis slot movement, membership, and replica coordination.
   Canvas moves and local persistence must not apply infrastructure changes.

When adding an engine or deployment mode, extend its catalog definition, discriminated resource
type, validation, and domain operations together. Test allowed and rejected operations and saved
draft compatibility before exposing the choice. Bump the draft version for incompatible shape
changes and migrate explicitly. Do not infer scaling capabilities from an app template's category.

```sh
bun run --cwd packages/core test src/scale
bun run --cwd packages/core lint
```
