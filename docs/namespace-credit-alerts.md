# Namespace credit alerts

Cloud credit warnings come from Oblien's current namespace quota state. The default
warning bands are 80% and 95% of the included allowance plus purchased credits.
The dashboard keeps a warning visible, opens a dismissible popup at the final
configured warning band, grace entry or exhaustion, and links to billing for that
specific organization. Buying extra credits is offered only when Cloud billing
and top-ups are available. Resource-cap errors still require reducing resources or
changing the plan; purchasing credits does not raise resource caps.

Signed `namespace.quota.threshold`, `credits.low` and `credits.depleted` events
refresh the provider entitlement before any notification is prepared. Delayed
warnings after funding, old billing periods, different service quotas and stale
namespace bindings do not notify the wrong customer. Openship queues notifications,
preserves credit-exhaustion activity when recording is enabled, and writes the
processed event checkpoint in one database transaction; a failure returns 503 for
Oblien's durable retry. No webhook grants credits in Openship.

Billing recipients receive email and in-app messages through the existing
notification system, subject to billing-read access and notification preferences.
The default email must be verified, and an email transport must be configured.
Each attempt rechecks membership and its destination. Critical deliveries persist
retry backoff, retain their delivery IDs, and recover after an interrupted worker.
A renewable lease also recovers sends on shared Postgres, and stale workers cannot
overwrite the replacement worker's delivery outcome. Losing verified account email
or billing access stops the delivery rather than retrying an unauthorized recipient.
SMTP delivery is at least once: a lost acknowledgment can cause a repeated email.
The dashboard also refreshes on focus and once a minute while visible, so email
availability does not hide current credit state.

Apply database migration `0153_durable_credit_alerts` when deploying the Openship
API. Deploy Oblien's additive `quota.alert` response and durable metering alerts
first, then Openship's API and dashboard together. Existing SDK 2.4.0 transport is
compatible; no unpublished SDK dependency is introduced. Customer emails use
`/cloud-billing?organizationId=...`, which validates membership and selects that
organization before opening billing. An inaccessible organization cannot fall back
to another customer's billing page. Login preserves this destination even when no
organization is currently selected. Explicit namespace allowances without a hosted
subscription also show warnings; a fresh, unfunded setup namespace does not.

Verification covers signed receipt retries, stale events, service and organization
isolation, queue rollback and deduplication, real database migration and retry
recovery, verified email defaults, preference opt-outs, dashboard warnings and
organization switching. No customer was charged or emailed to run these tests.
