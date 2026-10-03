# Openship reseller catalog

`pricing.json` defines retail prices, metered credit allowances, application limits,
VM limits and combined namespace capacity. `GET /api/billing/plans` supplies the
same catalog to the dashboard, marketing and linked installations. Checkout uses
a generic Oblien offer; the subscription belongs to the customer's namespace.
The Enterprise reseller owner receives wallet funding and keeps its own plan.

## Version 8 offers

| Plan | Monthly price | Included credits | Shared CPU / RAM / disk | Per service: CPU / RAM | Projects | Service slots |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| Hobby | $5 | 400 | 1 / 4 GB / 25 GB | 1 / 4 GB | No set limit | No set limit |
| Starter | $20 | 1,700 | 2 / 8 GB / 32 GB | 2 / 8 GB | No set limit | No set limit |
| Pro | $39 | 3,500 | 4 / 16 GB / 128 GB | 4 / 16 GB | No set limit | No set limit |
| Scale | $99 | 9,000 | 8 / 32 GB / 256 GB | 8 / 32 GB | No set limit | No set limit |

CPU values are vCPU. New retail offers allow one service up to the full shared
CPU and RAM pool. `limits.maxServiceResources` records that ceiling explicitly,
including custom sizes; it does not change machine presets or workload defaults.
Version 8 sells one managed server per subscription. It removes the old
project/service-count limits: a nine-service catalog app consumes the resources
it uses on that server, not nine subscription slots. All projects share the
purchased CPU, RAM and disk; the absence of a count limit does not make those
resources unlimited. Prices, credits and hardware capacities are unchanged.
The provider namespace allows exactly one VM. Another managed server has its
own namespace and independently purchased subscription.

Hobby includes a finite allowance for light use. A continuously running Docker
host can need top-ups; $5 does not buy an unlimited always-on VM.

## Custom server resources

Custom is a resource configuration of the existing subscription, not another
deployment or billing engine. `pricing.json#custom` owns the supported ranges
and monthly additions: $5 per extra vCPU, $2.50 per extra GB RAM, and $0.10 per
extra GB disk. It starts at Hobby's $5 for 1 vCPU, 4 GB RAM and 25 GB disk.

The quote compares every retail bundle plus its resource additions and chooses
the lowest total. A smaller configuration cannot cost more than a covering
preset, and a bundle discount does not silently enlarge the selected server.
For example, 1 vCPU / 4 GB / 50 GB costs $7.50; 3 vCPU / 12 GB / 80 GB receives
Pro's bundle price of $39. Application allowances and support follow that bundle.
80% of the additional resource charge funds additional credits at 100 credits
per USD, on top of the bundle allowance. This remains finite metered usage,
not guaranteed full-load runtime for the month.

`GET /api/billing/subscription/quote` returns the price and a fingerprint of the
complete offer. Checkout accepts only resources and that fingerprint; it
recalculates all terms before invoking the existing tracked provider checkout.
The saved Custom contract includes price, credits, application limits and
single-server capacity. Renewals verify the saved snapshot, without reading
new retail prices. Existing paid subscriptions are not rewritten.

After a replacement subscription is paid, Billing exposes the existing server
resize review: current and new resources, affected projects, and explicit
restart confirmation. It uses the same revision check and durable worker as
the server page. Disk shrinking is rejected before checkout and before resize.
Creating a new server still follows the existing paid provisioning flow.

All limits apply together. Containers cannot all use the server's maximum
size at the same time. CPU is shared
virtual CPU quota, not a dedicated physical core. An unpaid namespace has zero
workspace and total capacity. Enterprise remains contact-sales; only a verified
contract or audited operator grant can select it.

At Oblien's current 100 credits/USD wallet rate, these payments fund 500 / 2,000 / 3,900 /
9,900 wallet credits. The namespace allowances stay below that funding. Catalog
validation rejects unfunded retail allowances, top-ups and inherited retail
capacity. Oblien-admin promotions explicitly account for any promotional subsidy;
they are not an unrecorded enlargement of the namespace allowance.

Openship uses **milli-credits** internally: 1,000 milli-credits = one Oblien credit.
`billing.creditsPerCycle` and offers use whole credits; API `monthlyCredits`,
`annualCredits` and `credits_milli` use milli-credits. Credits are not minutes.
Oblien meters CPU, memory and transfer; its active rate card defines the billed dimensions. Current workspace billing does not charge disk I/O.
Neither a resource ceiling nor a credit grant promises continuous full-load
runtime for the entire month. New paid plans have no additional fixed build-minute
allowance; builds consume the same metered credits as applications.

Top-ups are 400 credits for $5, 1,700 for $20 and 4,500 for $50. They add purchased
credits without resetting consumption or changing capacity, grace, service limits
or the subscription. Only unused purchased credits carry to a later paid cycle.
Checkout idempotency includes the versioned offer reference, so a changed pack
price cannot replay an old quote accidentally. Older accepted orders retain
their saved amounts.

Grace is zero by default. `overdraft` and `suspendThreshold` can be explicitly
configured together; suspension cannot precede the blocking threshold. The
provider balance already includes grace. Annual checkout stays disabled until an
annual price and explicit funded annual allowance are published.

## Capacity enforcement

- `max_workspaces` permits one managed server per paid subscription.
- `max_vcpus`, `max_ram_mb`, `max_disk_gb` limit one VM.
- `max_total_vcpus`, `max_total_ram_mb`, `max_total_disk_gb` limit the combined
  namespace allocation, including stopped VMs, managed disks and pending resizes.
- Per-container CPU/RAM ceilings are enforced by Openship. The underlying VM
  and namespace pools are enforced by Oblien, even when a caller uses the
  provider API directly. Paid v8 offers impose no project/service-count cap.

Openship submits its chosen policy; it does not calculate the owner's remaining
capacity. Oblien intersects configured, paid, account and platform limits and
reserves capacity atomically on create/resize. `readCloudCapacity` supplies
provider allocations for provisioning and resizing. Managed server pages show
provisioned capacity separately from actual host CPU, memory and disk
measurements. Project data is attributed from Docker and managed binds;
shared images/cache/system storage is counted once.

Saved older offers can still have service-count limits. Those counts include
enabled services in deployed projects, active containers and accepted deployment
reservations. An undeployed draft consumes no slots, and redeploying the same
service does not consume a second slot. New v8 offers skip count admission.

Subscribed Docker workspaces use the same Docker build/runtime engine. Source
builds use measured free host memory and CPU, within an optional saved cap; they
do not create a temporary provider VM. Workspace activity locks coordinate
builds, deployment changes, backups and reviewed host resizes. A host resize
requires an explicit revision and restart confirmation, with a durable container
checkpoint for recovery. Shared projects cannot resize or delete the host.

## Existing subscriptions and upgrades

`openship:<tier>:v8` saves the price, credits, grace, application limits and all
seven capacity fields. Renewals use that snapshot, even after catalog edits.
Unknown versions, missing v2–v8 capacity fields and organization/namespace mismatches
fail closed. Price and credit metadata never come from browser input.

Saved v2/v3/v4/v5/v6/v7 subscriptions retain their original price, credits and capacity snapshot,
including the $40 price on existing v4 Pro subscriptions. New v5 offers use a
distinct checkout reference so retries cannot reuse the older price.
Version 6 raises Hobby's per-workspace and total storage limit from 16 GB to
25 GB and Starter's per-workspace storage limit from 16 GB to its existing 32 GB
pool. Prices, credits, other allowances and saved subscriptions are unchanged.
Snapshots without `maxServiceResources` retain their purchased `maxResourceTier`
ceiling. There is no automatic uplift or rewrite of existing paid subscriptions;
any adjustment is an explicit operator action. Unchanged top-ups retain v3 references.
The new Hobby tier exists from v3: a legacy provider `hobby` subscription still
maps to its original Openship Starter tier, never to the new $5 plan.

Legacy v1 offers left VM sizes inherited from the Enterprise owner. Reconciliation
retains their pre-v4 safety ceilings, including 2 vCPU per Pro VM and 4 vCPU per
Scale VM, while preserving paid price, credits, period and history. Pre-reseller
subscriptions also keep those CPU ceilings. Tighter saved limits remain in force.
Existing allocations above a new ceiling are not destroyed; downsize CPU/RAM or
remove/migrate resources before adding more. The older API patch shape preserves
the new total fields, so a prior client cannot erase them by omission.

A paid plan change starts a new full-price cycle and replaces only that namespace's
subscription. It does not prorate or automatically refund the previous cycle.
Credit deposits cannot unlock a more expensive hardware tier. Invoice, renewal,
refund, webhook and owner-wallet settlement remain provider-managed.

## Provider and rollout

Deploy Oblien's API first. `/billing/catalog` must report `contractVersion >= 2`,
`offerPolicy`, `resourceLimits`, `effectiveResourceLimits` and
`aggregateResourceLimits` all enabled. Then deploy the Openship API and dashboard
together. Checkout/readiness fail closed when total enforcement is missing;
existing portal and cancellation actions remain available.

Openship uses published `oblien@2.5.0` transport and validates the new response
fields locally. Its existing log cancellation patch is carried forward to 2.5.0;
do not remove it until using a release with the upstream cancellation fix.
SDK 2.6.0 adds that fix and exported total-capacity types for other integrations;
Openship does not depend on an unpublished package. Admin-created promotions use
the exact hosted URL returned by Oblien. Campaign helpers and legacy Stripe price
IDs do not define reseller checkout prices.

See [capacity economics](../../../../docs/cloud-capacity-economics.md) and
[Cloud release gate](../../../../docs/openship-cloud-launch.md).
