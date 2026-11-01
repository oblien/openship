# Topology scaling delivery

The topology is a frontend for the existing deployment, native database, and
infrastructure operations. It is not a second scheduler or source of workload
state. Database replicas and migration clones remain different actions.

## Delivered in this change

- Quick Scale entry from a workload node and explicit application replica review.
- Existing compute-cluster runtime setup embedded without leaving the draft.
- Actual versus requested instance counts, timestamps and durable progress.
- PostgreSQL standalone-to-replicated scaling within the same operator resource,
  with separate encrypted writer and reader bindings.
- Redis replication and Sentinel, separate from the existing sharded mode.
  Adding replicas is supported; replica removal stays blocked until a fenced
  primary handoff can be proven.
- Shared admission reasons for unsupported application workloads.
- Revision/sequence guards, organization isolation and reader-consumer protection
  during downscale. Existing operations own retry, cancellation and recovery.

## Runtime support

Application scaling reuses the existing Kubernetes and connected Swarm runtimes.
Swarm Compose workloads keep their existing stateless-service scaling and
manager-pinned, single-instance placement for named-volume services. The active
project replica setting, not the sum of all service tasks, is the review baseline.

Managed PostgreSQL and Redis replication require Kubernetes operators. Swarm
targets are rejected before saving or scheduling database creation; the topology
does not offer them as database destinations. Replicating a container never
substitutes for database replication or failover coordination. Existing Docker
and bare databases require the explicit migration described below.

## Subsequent delivery

These are backend features, not switches to reveal in the current UI:

1. **Standalone Docker/bare database conversion:** plan an engine-specific backup
   and data transfer, final catch-up and write fencing, verify the destination,
   then switch consumers explicitly. Track the writer generation so recovery
   never reactivates a stale primary. Keep source data until verified cleanup.
2. **Independent per-service Compose settings:** extend the existing Swarm release
   flow with a persistent per-service scaling
   target and immutable artifact delivery, preserve service/environment secrets,
   storage and private links, and use the current release/cutover pipeline. Do not
   apply application copies to database services. The existing Swarm flow keeps
   named-volume services at one instance.
3. **Cloud cluster execution:** implement private control-plane transport and
   verified machine identity for provider-managed execution endpoints. Reuse the
   same operation contracts and capability checks. Resource placement uses an
   explicitly selected customer pool. Provisioning/billing for extra servers
   requires a reviewed purchase; this change makes no provider purchases.
4. **First-use infrastructure setup:** embed existing network preparation/review
   and cluster creation in the workload flow, without silently accepting provider
   firewall rules or creating a parallel network wizard.
5. **Policy-driven autoscaling:** an independent later controller, with explicit
   minimum/maximum instances, budgets, cooldowns and placement rules.

## Acceptance

Focused tests must cover review/cancel, scope switches, stale settings, failed
permission reads, environment ownership and encrypted writer/reader transactions.
The real Linux scaling journey must prove PostgreSQL 1→3→1 preserves committed
data and reader behavior, and Redis replication preserves data and recovers after
primary host loss. A new desired configuration or accepted HTTP response is not
proof of runtime readiness. The PR records which acceptance checks actually ran.
