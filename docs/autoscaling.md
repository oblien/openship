# Project autoscaling (self-hosted K3s)

Autoscaling is off by default and requires an explicit per-project save. It uses
existing project authorization, project runtime locks, verified Kubernetes
transport and the Jobs scheduler. Docker, Swarm, managed Cloud, databases,
static sites and Kubernetes multi-service projects are outside this feature.
The [user guide](../apps/web/content/docs/guides/mcp-clusters-and-scaling.mdx#automatic-application-scaling)
covers configuration, supported recovery and limits.

## Mutation and recovery contract

The controller observes the active release under the same project lock used by
stop, deletion, policy changes and runtime mutations. It uses fresh metrics for
all ready pods and their deployed CPU limit. It holds during active deployments,
incomplete rollouts, missing/partial/stale metrics, cooldown or explicit suspension.
The configured step is a maximum delta, including convergence to edited bounds.
Scale-down decisions require at least five minutes since the last accepted step.

Before patching Kubernetes, it persists one pending operation containing the
active deployment, project revision, workload UID/generation, old/new counts and
operation ID. The patch checks this precondition on every resource-version retry
and records its operation ID beside the replica intent annotation. It changes the
existing Deployment, without building or creating another release.

Project intent, release snapshot, decision event and pending-operation clearance
commit in one database transaction. Kubernetes and PostgreSQL are separate
systems: a lost response or failed database commit leaves an explicit receipt to
reconcile on a later tick. A matching UID, generation and operation annotation
allow bookkeeping to finish without repeating the patch. A different generation,
release or project revision suspends further changes rather than overwriting an
operator. Pending accepted changes can be recorded after policy disable, but a
disabled/suspended policy cannot issue new scale requests.

If no acceptance receipt exists, retries use the same readiness, fresh metrics,
current policy bounds/step and cooldown checks as new decisions. An obsolete
decision is retired with a conditional same-count patch carrying a cancellation
receipt. This changes the Deployment's operation annotation/generation without
changing its pod template or replica count, so a delayed old request cannot land
after retirement. The pending intent is cleared only after retirement succeeds
or its receipt is observed. If the original request wins that race, its accepted
receipt is recorded instead. A lost cancellation response or database failure
is recovered without replaying either request.

Kubernetes acceptance does not mean pods are ready. The controller does not hold
the project lock while waiting for rollout; it admits another decision only once
all desired instances are ready, updated and available. Manual scaling continues
to use its existing configuration deployment pipeline.

## Cost and operational limits

With no enabled policy or pending recovery, a tick performs two database reads
and no Kubernetes calls. Healthy holds do not write policy rows or change their
configuration revision. Failures use exponential backoff and explicit suspension;
events are bounded to 100 per project. The Jobs module controls the recurring
job; the internal `autoscaler_disabled` instance setting additionally stops tick
admission. Disabling cannot cancel a request Kubernetes already accepted.

Imported application configuration retains policy settings but disables them and
drops source runtime receipts. Whole-instance recovery retains ownership state.

The controller still depends on a reachable Kubernetes API, metrics-server and
available cluster capacity. It does not add nodes, promise ingress failover or
replace application readiness checks. Edge ingress still uses the existing
cluster entry point; autoscaling does not provide ingress high availability.
