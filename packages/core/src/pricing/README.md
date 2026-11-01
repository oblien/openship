# Openship server pricing

`pricing.json` defines Openship retail prices, supported Custom sizes and application
limits. The API serves those terms through `GET /api/billing/plans`; dashboard,
website and linked installations share the catalog. Oblien owns provider pricing,
payment settlement, resource admission, metering and paid coverage.

## Prepaid server offers (v13)

| Plan | Monthly price | Annual charge | Annual monthly equivalent | vCPU | RAM | Disk | Managed servers |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Hobby | $12 | $120 | $10 | 1 | 4 GiB | 50 GiB | 1 |
| Starter | $24 | $240 | $20 | 2 | 8 GiB | 128 GiB | 1 |
| Pro | $47 | $468 | $39 | 4 | 16 GiB | 250 GiB | 1 |
| Scale | $119 | $1,188 | $99 | 8 | 32 GiB | 600 GiB | 1 |

Annual is charged in full upfront. The dashboard displays the monthly equivalent
and full annual charge together; the selected interval is sent through checkout.
Manage remains monthly, separately from Cloud compute. Annual purchases require
Oblien's `resellerSubscriptionIntervals` capability to include `yearly`.

New compute subscriptions start at Hobby. Existing subscriptions, including $5 Hobby and v12 monthly offers, keep
their saved price and capacity through renewal; catalog changes do not migrate
them. Openship Manage offers Basic at $5/month with email support and Priority at
$20/month with priority support. Both include two customer-owned servers, with
additional servers at $3/month each and no included Cloud compute. Paid Cloud
includes Basic; Priority retains its $15 support fee. New Manage v2 contracts bind
the support plan, fee and server allowance together. Saved v1 contracts remain
Basic at their original price. A support selection never proves paid entitlement.

Each subscription covers its server's CPU, RAM and storage for the full paid
period, without a second compute-credit allowance. CPU is shared vCPU, not a
reserved physical core. Projects and services share the purchased resources,
including the operating system and Docker. Each offer records its project,
running-service and concurrent-build allowances; there is no separate build-minute
cap. One service can use the whole pool; optional container limits do not reserve another VM. Source builds run on
the same host using measured headroom and the shared execution/activity locks.
Another server requires its own namespace and subscription.

Monthly servers include the provider's managed internet-transfer benefit. Read
`capacity.network` for its allowance and explicit unlimited flag; do not derive
it from CPU counts or rewrite saved compute tariffs. Public app routes and
backups are separate. Expired disks are retained for at least 30 days with no automatic deletion;
retained storage remains billable until deletion. The UI discloses provider
retention terms and amounts due instead of treating them as compute credits.

## PAYG resource tiers

`pricing.json#payg` owns the PAYG resource tiers and suggested credit packages.
The API publishes this catalog as `GET /api/billing/plans` → `payg`; the dashboard
must not derive customer tiers from the reseller owner's Oblien account plan.

| Tier | Credit purchases to unlock | Pool vCPU | Pool RAM | Pool disk | Servers |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | $5 | 2 | 8 GiB | 64 GiB | 2 |
| 2 | $20 | 4 | 16 GiB | 128 GiB | 4 |
| 3 | $50 | 8 | 32 GiB | 256 GiB | 8 |

These are Openship pool allowances shared across servers, not monthly prices or
provider account upgrades. Unlocking is based on cumulative verified credit
purchases, not the declining spendable balance. One server may use the whole
pool within effective provider limits. Adding servers does not multiply it.
Usage rates and credit conversion remain provider-owned.

The current PAYG surface previews this catalog and validates proposed allocations.
It does not grant access, change namespaces or activate checkout. Persisted
customer funding and runtime entitlement must be integrated before selling PAYG;
the preview's package selection is never payment evidence.

## Provider checkout and authority

New purchases use the existing tracked `/billing/checkout` flow:

- `kind: "subscription"`, `billingInterval: "monthly"` or `"yearly"`;
- `offer.billingMode: "monthly"`, `offer.credits: 0`, no credit policy;
- explicit `offer.capacity` and all seven `resourceLimits` fields;
- the versioned reference plus server-derived organization, namespace and limits.

The subscription remains `tierId: "reseller"`; its entitlement is `tierId: "capacity"`.
Openship checks the embedded capacity's namespace, provider, pool and paid period
against the saved subscription before exposing access. Billing admission uses the
provider's `blocking` flag. Empty legacy quotas or an empty owner wallet cannot
cancel confirmed monthly compute; manual suspension and expiry still apply.

Checkout returns are not proof of payment. Confirmation requires the specific
checkout's completed fulfillment and matching live subscription. Monthly checkout
legitimately grants zero namespace credits, so the UI verifies committed monthly
coverage. Metered subscriptions and top-ups still require their delivered credits.
Fully discounted, fulfilled purchases use the same checks. Pending, refunded,
disputed or superseded payments never show a successful new subscription.

`GET /billing/capacity/catalog` advertises deployed purchase capabilities and rates.
Openship uses `oblien@2.10.0` and the existing SDK transport. Missing monthly Stripe
support stops new sales without hiding existing subscription management. Provider
price admission stays at Oblien; Openship does not copy its affordability or
proration calculation into another pricing engine.

The published provider tariff currently exceeds Hobby, Starter and Pro retail
prices. The company has chosen to keep those retail prices and arrange its tariff
with Oblien. See [the provider handoff](../../../../docs/cloud-capacity-economics.md).
An accepted tariff and real settlement still need verification before release.

## Custom resources and plan changes

Custom reuses the same subscription and resize flow. Monthly retail additions are
$6 per extra vCPU, $3 per extra GiB RAM and $0.12 per extra GiB disk. Annual
additions are $60, $30 and $1.20 respectively for the whole year. The quote compares
every preset plus additions and selects the least expensive bundle. A bundle
discount does not enlarge the selected server. Custom starts at 2 GiB RAM and
stops at the provider's 12-vCPU per-VM ceiling.

`GET /api/billing/subscription/quote` accepts an optional `interval` (`monthly` or
`annual`, default monthly) and returns the full-cycle retail price and a
fingerprint of the complete terms, including interval. Checkout accepts only the
selected resources and fingerprint, then recalculates the offer on the server.
`custom-v3` saves prepaid capacity and zero credits. Monthly and annual quotes
cannot be interchanged. Saved `custom-v1` and `custom-v2` terms retain their
original fingerprints and renewal behavior. Oblien validates provider funding
and physical admission; a local quote does not purchase coverage.

Existing subscriptions use the provider's plan-change preview and confirmation,
never another replacement checkout. The UI shows its amount due, effective date
and affected projects. Pure funded upgrades apply after payment. Resource
reductions and billing-model changes wait for renewal, even when retail price
increases. Openship uses the returned direction and date without local proration.
Annual upgrades use provider proration over the saved paid year and retain its
original end date. Changing an existing subscription between monthly and annual
billing is not supported. The durable worker applies the approved resize once. Changed project membership
requires a fresh restart review. Disk shrinking remains unavailable.

## Saved contracts and metered compatibility

Renewals use saved prices, resource limits, periods and billing mode. A catalog
edit never rewrites paid terms. Existing v9 monthly subscriptions keep their
original RAM and disk allocation; adopting v10 uses an explicit plan change.
Older v1–v8 and `custom-v1` metered offers retain
their finite allowances; they can adopt monthly capacity through the explicit
provider plan-change flow at renewal. Older incomplete v1 snapshots retain their
existing safety ceilings. Unknown references or ownership mismatches fail closed.

Only eligible metered subscriptions expose credit packs and exhaustion warnings.
They retain the existing allowance, signed webhook and renewal code. Internally,
1,000 milli-credits equal one Oblien credit; these units never represent minutes.
New monthly servers cannot be fabricated with the operator's complimentary-credit
grant command. Previously saved grants can still be inspected, reused and revoked.

PAYG displays the published active-vCPU-hour, reserved-GiB-hour, retained-GiB-month
and managed-proxy rates. Customer PAYG checkout remains unavailable: the deployed
capacity confirmation spends the reseller wallet, not a customer-specific funded
balance. No purchase button is enabled for that flow.

See [the Cloud release gate](../../../../docs/openship-cloud-launch.md) for payment,
renewal, isolation and deployment acceptance requirements.
