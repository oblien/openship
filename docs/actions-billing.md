# Cloud Actions billing integration

Actions execution is available on connected servers and operator-funded disposable
Cloud runners. Customer-funded Cloud Actions is not enabled. The budget page,
authorized billing API, financial tables and checkout service are implemented;
checkout creation/resumption remains disabled server-side until provider metering
and enforcement are connected. A UI change cannot enable purchases.

## Approved offer

The Actions budget is separate from every managed application server subscription.
One organization's jobs share its Actions budget. Purchasing funds does not buy an
application server or permit use of another organization's runners.

| Linux runner        | Temporary disk | Price per execution minute |
| ------------------- | -------------- | -------------------------- |
| 2 vCPU / 4 GiB RAM  | 40 GiB         | $0.004                     |
| 4 vCPU / 8 GiB RAM  | 80 GiB         | $0.008                     |
| 8 vCPU / 16 GiB RAM | 160 GiB        | $0.016                     |

Deposits are $5, $20, $50 and $100. Execution is to be charged per second, including
failed workflow steps. Queue time and provisioning failures are excluded. Artifact
and cache storage use the customer's configured destination.

Each deposited $1 includes **5 GiB of combined upload and download transfer**.
This is a prepaid allowance, not a monthly reset. Internet pauses when it runs
out and resumes after additional verified funding. Compute and stored data must
not be deleted when transfer runs out. The Runtime API control connection must
remain available for logs, cancellation and cleanup.

The catalog lives in `packages/core/src/pricing/pricing.json`. Exact amounts use
60,000,000 units per USD, so a micro-USD/minute tariff is an integer number of
units per second. Do not round each job to a cent or infer its price from provider
credits. Existing reservations retain their saved price version and rate.

## Implemented financial boundary

`ActionCredits` persists the complete checkout request before calling Oblien. A
retry uses that request and its original provider idempotency key. Checkout URLs
are encrypted and are excluded from public run views and diagnostics.

Only an authenticated provider receipt for the saved checkout and namespace can
fund the ledger. A browser redirect, an open checkout or payment without completed
fulfillment cannot grant funds. Reconciliation applies the absolute net grant,
so duplicate deliveries do not double-credit and partial refunds adjust only the
relevant deposit. A per-organization lock must cover both the provider read and
the local update to prevent an older response undoing a refund.

`billing.getActionsBudget`, `getActionsPurchase`, `createActionsCheckout` and
`resumeActionsCheckout` use the existing billing authorization layer in the native
SDK and HTTP API. Workflow permissions do not grant financial access. Connected
local instances cannot use a restricted credential to borrow an owner's Cloud
identity. Public budget responses omit namespaces, provider requests and payment
URLs. The provider read and checkpoint use the shared distributed provision lock.

The dashboard shows the approved rates, included transfer and deposit choices.
It preserves exact sub-cent usage, reconciles payment returns with the provider,
and offers the original unfinished checkout when purchases are available. Opening
the page is read-only and does not create a customer namespace or VM.

The repository reserves a maximum execution amount under the current controller
lease. Concurrent jobs cannot reserve the same balance. Unused funds are released
only after worker cleanup, and receipts outlive short-lived execution logs.
These repository operations are tested but are not yet called by the controller.

## Remaining integration

Before enabling customer purchases:

1. Integrate provider enforcement for the approved 5 GiB per $1 transfer allowance.
   A periodically resetting provider limit is not a prepaid lifetime allowance.
   Git clones, package downloads and artifact transfer count too. Reads and an
   internet toggle alone cannot provide a hard cutoff during controller downtime.
2. Establish a trusted execution-time receipt. Oblien's documented Runtime API is
   served inside the VM. A privileged workflow can alter guest journals or that
   server, so guest-reported timestamps cannot alone authorize a customer debit.
   Billing from the controller's reconnect time would overcharge jobs that ended
   during controller downtime. Do not use either shortcut.
3. Provision customer Actions namespaces and runner profiles with the provider's
   resource and transfer limits, then wire budget reservations, bounded execution
   and settlement through the existing controller. Keep app-server subscriptions
   and their monthly capacity out of this path.
4. Wire verified billing webhook delivery and background payment recovery through
   the same receipt service used by the customer UI. Complete provider namespace
   setup before opening checkout, then enable purchases only after settlement and
   transfer enforcement pass real-provider tests.
5. Run an authorized real Oblien test through funding, temporary VM readiness,
   execution, cancellation, cleanup and receipt settlement. The isolated Docker/
   SSH tests use the real managed execution adapter, but do not validate Oblien's
   hosted billing or provisioning service.

### Contract to confirm with Oblien

The VM credit budget is the provider-side spending boundary. Openship is not
asking for another billing system or replacement workflow engine. Before opening
the approved retail offer, send the provider this integration request:

> We are building Openship Actions on the existing prepaid VM namespace flow:
> hosted top-ups fund a metered namespace for temporary VMs, with no monthly server
> contract. We will use namespace spending limits, no overdraft, VM TTL and
> stop-on-exhaustion as the provider-side spending boundary.
>
> For precise runner billing, expose a durable provider-side execution receipt
> bound to the authenticated namespace, workspace and our attempt ID. The start
> must be idempotent. Report accepted execution start/end or elapsed seconds,
> excluding queue/provisioning failures, and retain the receipt after VM deletion.
> Guest workflow code must not be able to change it. Existing VM metering may
> supply this if it has these guarantees; please document the exact API.
>
> Each verified $1 Actions deposit includes 5 GiB combined upload/download
> transfer. We need a cumulative namespace allowance with no automatic reset,
> atomic idempotent grants/refund adjustments, consumed/remaining byte reads, and
> a provider-enforced internet pause at exhaustion across concurrent VMs. Preserve
> authenticated Runtime API access for observation and cleanup. Adding funds
> should restore internet without replacing VMs. Please specify the endpoints,
> rounding, event delivery and any bounded enforcement overrun.

## Operator test pools

Cloud operators can currently configure `OPENSHIP_ACTIONS_CLOUD_POOLS` as an array
of organization/namespace bindings, each with `name`, `cpu`, `memoryMb`, `diskGb`,
`maxParallel`, `image` and `labels`. The namespace must be separately funded and
metered; a monthly application-server namespace is rejected. Each namespace belongs
to one organization and pool. Public requests cannot create these bindings or
grant provider credits.

Each job gets a namespace-scoped provider client and a disposable VM. Provisioning
uses a stable idempotency key and provider TTL. The setup permits authenticated
Runtime API access on port 9990, with SSH disabled and no public application routes.
Cleanup confirms VM absence before releasing the scheduler slot. This path uses
provider funding limits and does not deduct the proposed retail Actions rates.
