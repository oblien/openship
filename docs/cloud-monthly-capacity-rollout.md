# Shared Cloud capacity and pricing rollout

This records the earlier per-project workspace rollout and its historical offers.
For current server subscriptions and resources, see [Managed Cloud servers](managed-cloud-servers.md)
and [the pricing catalog](../packages/core/src/pricing/README.md).

## Allocation authority

Oblien owns effective namespace/account limits, current reservations, atomic
admission, applied workspace resources, deletion and metering. Openship reads
`effective_resource_limits` and `allocated_resource_usage`; it does not infer
free capacity from service counts, observed CPU activity or credit balance.
Stopped workspaces and pending updates remain allocated until Oblien reports
that they have been released.

Runtime and builds use **one shared pool**. Before a source build, Openship reads
the remaining CPU/RAM and selects a build allocation within it and Oblien's
current per-workspace limits. A saved build setting is an optional upper limit;
clearing it restores automatic sizing. There is no fixed default Cloud build
machine and no separate build capacity pool.

Shared Docker projects reserve their runtime allocation and Docker overhead
before granting the builder any headroom. Pending runtime reductions do not
count as released capacity. Native service builds divide headroom across their
concurrent workspaces, reserving room for image services and their eventual
runtime sizes. A native source workspace becomes its runtime after building,
so those two phases are not charged as simultaneous workspaces.

The same selected allocation reaches the actual builder and shared Docker host.
Cloud Docker builds enforce the CPU/RAM budget on their BuildKit worker (or the
legacy builder), keeping the existing project cache and removing the worker
when the build finishes. Shared workspace reconciliation releases temporary
CPU/RAM after success, failure or cancellation; disks are never shrunk. A failed
or ambiguous resize is not reported as released capacity.

Admission is checked again when the worker starts. Another deployment may still
win a reservation between the read and provision: Oblien's atomic admission is
final. That refusal returns through the normal capacity editor and deployment
logs, including catalog app installs. Unknown provider measurements produce a
retryable error; they never become an assumed empty pool.

## Customer recovery

The editor shows actual provider allocations, previews CPU/RAM adjustments and
requires restart confirmation. It redeploys the same project using retained
images, preserving volumes and service settings. It waits for both deployment
completion and confirmed provider allocation before treating the adjustment as
complete. Retry uses the original deployment/install; it does not create another
project. Customers can also set a smaller build cap or restore automatic sizing.
A smaller build can be slower or run out of memory; it does not guarantee that
any application can build on any amount of capacity.

Existing image-based native workspaces now apply changed runtime CPU/RAM before
reuse. A Micro redeploy must be confirmed at **0.25 vCPU**, preserving workspace
identity and disk. Resource update responses are checked, then read back. A
successful HTTP response alone is insufficient when the change is pending.

The current allocation editor supports running projects with a shared Docker
workspace and an active deployment. Native, stopped and draft projects show
why an in-place editor adjustment is unavailable. Native Micro settings still
apply through ordinary redeployment. Self-hosted machine limits and SSH build
behavior are unchanged.

## Pricing scope

Current checkout remains credit based. Offer v6 raises Hobby storage to 25 GB
without changing prices or credits. Starter's per-workspace disk limit becomes
32 GB within its existing 32 GB pool, so upgrading from Hobby does not require
shrinking a disk. Saved subscriptions retain their purchased terms.

These approved next offers are recorded for follow-up; they are **not the active
checkout offers** in this PR:

| Plan           | Monthly price | CPU pool | Memory pool | Storage pool |
| -------------- | ------------: | -------: | ----------: | -----------: |
| Hobby          |            $5 |   1 vCPU |        4 GB |        25 GB |
| Starter        |           $20 |   2 vCPU |        8 GB |        32 GB |
| Pro            |           $39 |   4 vCPU |       16 GB |       128 GB |
| Scale (`team`) |           $99 |   8 vCPU |       32 GB |       256 GB |

Activating larger pools, different project/service allowances or changing from
consumption credits to included monthly hosting is Openship billing work, using
Oblien's existing generic billing and namespace APIs. It is not a prerequisite
for automatic build sizing. Do not bypass current subscription suspension or
rewrite historical paid terms. Publish prices and limits through the single
pricing catalog only when checkout, renewal and entitlement behavior match.
The current Docker/OS overhead (512 MB, memory rounded to 256 MB, minimum 1 GB
host) must be included when describing usable service memory.

## Provider verification handoff

No new build-specific provider API is needed. Verify these generic contracts:

- `namespaces.get` reports current effective per-workspace and aggregate limits,
  plus allocated usage including stopped workspaces and pending updates.
- `workspace.resources.update` (`PUT /workspace/{id}/resources`, `apply: true`)
  applies fractional CPU/RAM without replacing the workspace or shrinking its
  disk. Pending changes remain distinguishable from applied changes.
- `workspace.get` and the namespace allocation read agree after a confirmed
  resize. Four 0.25-vCPU native workspaces account for 1 vCPU, not 4 vCPU.
- Create, resize and release remain atomic across concurrent callers. Structured
  namespace/account/fleet errors retain their code and request reference.

If those existing APIs report a Micro workspace as applied at 0.25 vCPU while
namespace usage still charges it as 1 vCPU, that is a provider accounting issue
to investigate with the affected workspace IDs and request reference. Without
those live readings, do not attribute the customer's incident to that cause.

## Validation

Automated coverage includes provider-derived build sizing, concurrent native
build budgets, Micro redeployment, restart/apply verification, identity checks,
full pools, unavailable measurements, retained-image recovery, async catalog
install errors and retry, optional build caps, and self-hosted isolation.
Provider responses are simulated in these tests. Live paid checkout, renewal
and customer resource changes are not performed by the test suite.
