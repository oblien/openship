# Cloud monthly capacity and provider handoff — 2026-10-04

This is a historical provider-price comparison for the resource sizes below.
For current retail resources, see [the pricing catalog](../packages/core/src/pricing/README.md).

Openship and Oblien are part of the same company. The product decision is to sell
one managed server per subscription, with CPU, RAM and disk covered continuously
for the paid month. Keep the agreed retail prices and resources:

| Plan | Retail/month | vCPU | RAM | Disk | Published provider/month |
| --- | ---: | ---: | ---: | ---: | ---: |
| Hobby | $5 | 1 | 4 GiB | 25 GiB | $11.25 |
| Starter | $20 | 2 | 8 GiB | 32 GiB | $21.60 |
| Pro | $39 | 4 | 16 GiB | 128 GiB | $46.40 |
| Scale | $99 | 8 | 32 GiB | 256 GiB | $92.80 |

The provider amounts above are a dated comparison against
`GET https://api.oblien.com/billing/capacity/catalog`, tariff
`workspace-capacity-2026-10-v1`: 600 cents/vCPU, 100 cents/GiB RAM,
5 cents/GiB disk, with a 500-cent monthly minimum. They are not copied into
Openship's runtime pricing code. The live provider owns price and admission.

## Message for the Oblien team

> Keep Openship monthly retail at Hobby $5 (1 vCPU / 4 GiB / 25 GiB), Starter $20
> (2 / 8 / 32), Pro $39 (4 / 16 / 128), and Scale $99 (8 / 32 / 256), one managed
> workspace per subscription. The published capacity tariff currently costs
> $11.25 / $21.60 / $46.40 / $92.80 for those sizes. Please configure the agreed
> Openship provider tariff, or explicit company subsidy support, so
> `/billing/checkout` and subscription plan changes accept these retail prices.
> We send `offer.billingMode: "monthly"`, `credits: 0`, the resource pool and no
> credit policy. A confirmed payment must cover CPU, RAM and disk for the full
> paid month regardless of old credits or owner-wallet balance. Apply this to
> Custom sizes too and retain saved renewal terms. Please confirm the tariff
> identifier and verify checkout, renewal, proration and refund settlement at
> these prices; we will keep using the existing generic APIs.

No new customer credit budget should be introduced to compensate for an internal
provider-price mismatch. Lower retail prices require an agreed tariff or explicit
subsidy at the provider boundary. A generated checkout URL is not evidence of
successful payment or infrastructure funding.

## Usage, extras and internal accounting

The same deployed catalog publishes PAYG at $0.030/active vCPU-hour,
$0.008/reserved GiB-hour and $0.05/retained GiB-month, with a compute cap at
125% of the saved monthly capacity price. These are measured usage dimensions,
not conversions from old namespace credits or estimates of full utilization.
Use provider-reported savings for historical comparisons; do not promise a
universal monthly discount from hypothetical load.

Optional managed proxy transfer is separate at $0.10/GiB, with a $5 minimum
purchase. Public app routing is not the paid managed internet proxy. Backups are
not included in provider compute. After expiry, disks remain for at least
30 days without automatic deletion; storage remains billable until deleted.

Monthly contracts use no additional compute-credit top-ups. Existing metered
subscriptions keep their saved allowance until an explicit plan change. Customer
PAYG checkout remains unavailable because the current wallet-confirmation API
uses the reseller's wallet rather than a tenant-funded payment balance.

Count customer revenue once across the company. Moving funds to the internal
provider wallet is not a second sale. Actual fleet costs, safe placement density,
card fees and operational headroom belong to infrastructure/finance planning;
Openship does not approximate them to bypass provider admission.

## Prepaid PAYG pricing preview

The UI now previews one customer balance funding multiple independently sized
managed servers. Monthly hosts keep one subscription each. Both use the same
server acquisition and deployment architecture; selecting a purchase view does
not switch an existing server's contract.

Suggested prepaid deposits are $5, $20, $50 and $100. At the published conversion
of 100 credits per dollar, they represent 500, 2,000, 5,000 and 10,000 credits.
There are no hidden package discounts or legacy allowance conversions. These
are display selections, not new entries in the old namespace top-up catalog.

PAYG uses the provider's published resource rates, credit conversion and
reference period length. It reuses the monthly resource controls but does not
request monthly quotes or derive a retail ceiling from monthly host prices.
Provider settlement terms remain owned by Oblien. The UI is a pricing preview
and cannot initiate PAYG checkout, even if the catalog's availability flag
changes. No wallet, quota, subscription or deployment mutation is introduced
by the estimator.

Estimates use identical hosts and constant CPU activity. RAM is charged while
reserved and disk while retained. Balance duration is prepaid funds divided by
resource usage cost. The range varies CPU activity from full to idle while
keeping RAM and storage billable. Several hosts multiply usage, never the
customer's deposit. This is a UI estimate, not financial settlement, admission
or recorded savings.

## Additional handoff for Oblien

> Please add customer-scoped prepaid funding to the existing capacity model.
> Stripe deposits should fund one customer/organization wallet which can pay
> for multiple server namespaces; those balances must not borrow funds from
> another customer or the reseller's general wallet. Quote and enforce prepaid
> resource usage independently of monthly host prices, with saved terms.
> Keep the published resource rates and explicit credit
> conversion visible. Deduplicate deposits and usage, enforce concurrent spending
> through bounded reservations, and expose balance, per-server usage and
> low-balance events through the existing signed flow. Monthly servers must not
> debit this compute balance. Before strict prepaid purchases open, agree a
> funded storage-retention policy: compute shutdown alone does not stop reserved
> RAM or retained-disk costs, and the current retention flow can create storage
> debt. We need an explicit reserve, funded grace period or agreed deletion policy,
> with no surprise postpaid bill. Keep custody, metering and settlement in Oblien;
> Openship will present and orchestrate the existing APIs.

## Verification

Openship validates the published catalog, saved monthly capacity/entitlement,
provider blocking flag, zero-credit checkout fulfillment and signed event
reconciliation. Upgrade prices and dates come from Oblien. Resource reductions
and billing-model changes wait for renewal; paid upgrades use the existing
restart review and durable server worker.

Local integration tests simulate provider transport and settlement. They cover
empty legacy balances, stale credit warnings, namespace isolation, checkout
retries, renewal changes and provisioning, but do not establish a successful
live purchase. Verify the agreed tariff and the complete signed
payment-to-server cycle in the intended provider environment before rollout.

See [the catalog contract](../packages/core/src/pricing/README.md) and
[Cloud release gate](openship-cloud-launch.md).
