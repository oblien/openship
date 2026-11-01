# Manage and Cloud pricing rollout

This implements the product split agreed in #1396. The shared pricing catalog is
`packages/core/src/pricing/pricing.json`.

- Self-hosted control planes remain free.
- Manage Basic costs $5/month per organization (shown as a workspace) with email
  support. Priority costs $20/month with priority support. Both include two
  customer-owned servers; additional servers cost $3/month each, up to 100.
- Paid Cloud includes Basic management and its two-server allowance once per
  organization. Priority retains its $15 support fee. Cloud Spaces do not consume
  connected-server slots.
- New Cloud monthly offers are Hobby $12, Starter $24, Pro $47 and Scale $119.
  Annual charges are $120, $240, $468 and $1,188 upfront; Yearly is the default
  purchase view. Hobby includes email support. Saved prices, resources and
  renewals remain intact.
- Dedicated physical hardware is quote-only. PAYG remains a separate preview.

## Release order

1. Release the provider's generic `billingMode: service` subscription support.
   The reseller catalog must advertise `reseller.serviceOffers: true`. Its paid
   entitlement must report `serviceCovered` only for a verified settled cycle;
   service subscriptions must grant zero compute quota and no VM capacity.
2. Apply Openship migration `0199_management_billing.sql` using the normal
   migration runner, then release the API, dashboard and public website together.
   No new secret or environment variable is needed. Existing `BILLING_ENABLED`
   and reseller credentials still control sales.
3. In a non-production organization, verify checkout, paid activation, connecting
   a public SSH host, deployment, allowance upgrade/downgrade, renewal and refund.
   Verify that disabling renewal and disconnecting the host leave workloads and
   volumes intact. Use provider test payments, not a customer's subscription.
4. Check the public pricing catalog and login return to `/billing/manage` before
   announcing the product. If the provider capability is absent, new Manage
   checkout is disabled; existing verified access and cancellation are separate.

## Billing and ownership

Manage uses a separate hashed namespace for each organization. A browser return,
webhook body, or nominal subscription status never grants access: Openship reads
provider state and matches the namespace, organization, saved offer and paid
period. The provider verifies receipts, including upgrade chains and reversals.

New Manage v2 contracts bind the selected Basic/Priority plan and support fee to
the same saved offer, receipt and paid period as the server allowance. Changing
the selection does not grant support entitlement. Priority upgrades and downgrades
use the shared provider preview/confirmation flow; the verified subscription
controls the paid tier. Saved v1 contracts remain Basic at their original terms.
No new database migration or provider billing mode is needed for the support tiers.

Checkout intent is persisted before the external request, with an immutable
idempotency key. Lost responses resume that intent; a confirmed cancellation or
expiration releases it. Inventory changes and allowance changes share the server
inventory lock, so concurrent connections cannot oversubscribe the allowance.

Signed billing events invalidate the shared database entitlement cache. The
bounded background reconciliation also covers missed events. Access is refreshed
at most once per minute, and the paid period is checked on every operation.
Provider failures are not interpreted as a canceled subscription.

When Cloud starts, the separate base Manage fee ends at renewal. Extra-server
charges and paid Priority support keep their saved terms. When Cloud coverage ends, an already-paid
allowance stays valid until its expiry; a discounted renewal is canceled rather
than silently increasing the charge. The customer explicitly selects the full
Manage plan after that period ends. This transition can require reconnecting
management access; applications keep running throughout.

## Customer infrastructure

The existing SSH, Docker/bare runtime, edge, backup and operation layers are reused.
The actual server destination selects those adapters; SaaS mode alone does not
force workloads into a provider VM. Builds and source checkouts run on the
customer host, never the Cloud API host.

Hosted connections accept direct SSH with a password or uploaded private key.
Public addresses are resolved and pinned on each connection, and the first
successful connection pins the host key. Local/agent credentials, jump hosts,
local key paths and custom SSH arguments are unavailable to SaaS customers.
Reachability and exposed-port checks use the same public-address validation and
pin the actual TCP destination, including after DNS changes. The control-plane
mode defines this trust boundary: connecting a customer-owned server to SaaS
does not grant access to the SaaS host, local credentials or private network.
The SaaS operator's ACME account settings, EAB credentials and CA configuration
are not forwarded to customer edges. Self-hosted control planes retain their
configured certificate provider; SaaS-managed customer hosts use the edge's
default public certificate provider and their own certificate accounts.
Management expiration blocks new control-plane operations; it does not stop or
delete running applications or data. Disconnect removes Openship records only.
Normal explicit project deletion retains its existing destructive confirmation.

Clusters, instance migration and mail administration retain their existing
availability constraints; this feature does not expose the SaaS operator host.

Component installation and removal share the existing deployment provisioning
lock for the target host, held until the background installation finishes.
Different servers can install concurrently. The database advisory lock also
prevents another API replica from changing the same host at the same time.
Installation discovery is limited to the active organization and the caller's
server permissions; named session replay and prompt responses require the same
server authority. SDK/CLI callers can select a server explicitly; released
desktop clients using the legacy session ID query remain compatible.
The SDK keeps that wire alias for session IDs so it also works with older APIs.
Live setup logs remain process-local; multi-replica deployments need session
affinity for reattachment. A missing local session never authorizes an overlapping
installation, because its host's advisory lock remains held by the worker.

Provider-managed Cloud Spaces retain their separate subscription/lifecycle
operations. Generic connected-server deletion rejects them before project cleanup.

## Validation boundaries

Automated tests exercise real database persistence and advisory/inventory locks,
HTTP/native SDK parity, checkout retries, tenant isolation, concurrent server
connections, expired access, SSH restrictions and non-destructive disconnect.
Provider critical tests use disposable MariaDB and Redis with mocked Stripe,
including payment activation, renewal, plan changes, refunds and duplicate events.
A live Stripe checkout or customer SSH deployment is not performed by these tests.
