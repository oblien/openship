# Oblien subscription changes

Openship uses the published `oblien@2.7.0` plan-change API for existing managed
server subscriptions. Each server has its own namespace and subscription.
Oblien owns proration, payment, credits, renewals and entitlements; Openship
supplies trusted retail offers and the existing server resize/restart workflow.

Provider contract: [Reseller subscription plan changes](https://oblien.com/docs/api/billing#reseller-subscription-plan-changes).
Checked against the published API docs and npm SDK on October 3, 2026.

## Unfinished initial checkouts

Checked against `oblien@2.10.0` and the provider billing documentation on
October 14, 2026. This is separate from changing an existing subscription.

When the provider catalog advertises `reseller.checkoutCancellation`, Openship
cancels the original checkout through
`POST /billing/checkout/:checkoutId/cancel`. It saves the checkout ID and stable
retry key before dispatch, then re-reads that original checkout. Confirmed expiry
allows another plan; paid or uncertain outcomes retain the purchase until its
status is verified. No customer-supplied namespace, owner, quote, or payment URL
controls the cancellation.

Older providers still use their existing exact capacity-quote cancellation.
Saved quote cancellations continue through that path after an upgrade. A saved
checkout cancellation retries its original ID and key even if capability
discovery is unavailable; it never switches payment identity after dispatch.
The provider SDK adds `billing.cancelCheckout(namespace, checkoutId, input)`;
until that SDK release is adopted, Openship uses its existing authenticated,
bounded billing transport and shared checkout-response validator.

A provider without either capability returns
`cancelUnavailableReason: "unsupported"`. Failed capability or capacity reads
return `"provider_unavailable"`, for which the dashboard offers Refresh. Neither
case clears the purchase locally. Subscription cancellation is separate: it
stops renewal of an existing paid subscription.

## Customer flow

1. Select a server in Billing's right sidebar and choose **Review change** on
   another plan or a Custom configuration. The server's billing interval stays
   unchanged. Its saved paid offer supplies the current price, even if the
   public catalog has changed.
2. Review the provider's unused-time credit, remaining-time charge, amount due
   now, estimated next invoice and effective date. The same dialog shows the
   capacity change and projects that may restart.
3. Confirm an upgrade or schedule a downgrade. A pending payment keeps the old
   plan. If authentication is needed, **Complete payment** opens the provider's
   validated invoice link. An accepted request can be checked or canceled from
   the selected server's subscription card.
4. Only provider status `applied`, followed by a fresh matching subscription
   read, authorizes new capacity. Upgrades apply after payment; lower or equal
   prices take effect at the next paid renewal. Purchased credits and metered
   usage remain provider-managed.
5. The existing server worker applies the approved resize. If the server or
   project set changed since review, Billing's **Apply plan capacity** action
   asks for fresh restart consent. Server progress, logs and retry remain in
   the standard server UI.

Disks cannot shrink in place. To lower CPU or RAM, choose Custom and retain at
least the allocated disk size. A smaller disk requires moving data to another
server. Downgrade acceptance never shrinks or deletes resources early.

## API and authorization

The same application operations serve SaaS HTTP routes, the SDK, and linked
self-hosted installations. Local links map their server billing scope to the
verified Cloud identity; they do not maintain a second financial operation.

| Openship route | Permission | Official Oblien SDK method |
| --- | --- | --- |
| `POST /api/billing/subscription/change/preview` | `billing:write` | `billing.previewPlanChange(namespace, input)` |
| `POST /api/billing/subscription/change` | `billing:admin` | `billing.changePlan(namespace, input)` |
| `GET /api/billing/subscription/change` | `billing:read` | `billing.planChange(namespace, changeId)` |
| `POST /api/billing/subscription/change/cancel` | `billing:admin` | `billing.cancelPlanChange(namespace, changeId, input)` |

Preview saves a quote, so it is explicitly a write route. Preview and confirmation
also require write access to the server and its projects. Namespace, retail price,
credits and offer metadata are derived on the server. Public requests cannot
override them. MCP exposes preview and status; financial confirmation and
cancellation remain in Billing.

New quotes and confirmations require billing to be enabled and the provider's
Enterprise reseller eligibility. The provider supports active, automatically
charged, single-item monthly/yearly USD subscriptions. Resolve pending invoices,
subscription cancellation and an existing plan change first. Current retail
availability still applies; Custom offers are monthly. Read/cancel operations
stay available when new purchases are disabled. Cancel a pending change before
canceling or resuming the underlying subscription.

## Durable recovery

- Preview saves the exact trusted request, expiring quote identity and server
  restart approval in `cloud_workspace.subscription_change` (additive migration
  `0164_subscription_change_intent.sql`). It stores no payment link or card data.
- Confirmation saves its deterministic retry key **before** calling Oblien.
  A timeout or lost response replays that same request. A changed or expired
  quote requires a fresh preview; unknown outcomes cannot start another charge.
- `queued`, `dispatching`, `payment_pending`, `scheduled`, `canceling` and
  `reconciliation_required` are pending states. HTTP 200/202 alone never activates
  the new offer. Failed/canceled/expired changes do not resize the server.
- Existing HMAC verification and event deduplication handle
  `subscription.change.scheduled`, `.applied`, `.canceled`, `.payment_required`,
  `.failed` and `.expired`. Each event triggers fresh provider reads, so delayed
  or reordered delivery cannot apply stale financial terms.
- The existing one-minute managed-server recovery job also resumes accepted
  plan changes. Resizes use the existing activity barrier and durable operation
  worker, preserving deployment exclusion, retry identity and project restart
  recovery. A later refund, cancellation or different plan prevents replay of
  an older capacity approval.

Payment and VM resizing are separate durable operations, not a single distributed
transaction. The UI distinguishes the applied plan from its server update.
The provider invoice URL is validated against Stripe's hosted invoice domains
and excluded from logs, audit payloads and persisted recovery state.

## Verification

Provider-adapter tests exercise SDK paths, monetary units, pending responses,
tenant binding, URL validation and sanitized errors. Lifecycle integration tests
run actual HTTP/native SDK authorization, PGlite persistence, locks, signed
webhooks and the server worker with simulated provider transport. They cover
upgrade payment, scheduled renewal, retries, duplicate/concurrent confirmation,
changed restart consent, disk constraints and isolation. Linked-installation
tests exercise the real scoped proxy, local permissions and stored Cloud identity.
UI tests cover review, duplicate clicks, payment recovery, expiry, scope switches
and cancellation. Both production route trees are boot-tested.

These checks do not constitute a live paid-cycle test. Deployment verification
must still confirm real payment authentication, webhook delivery and renewal in
an isolated provider billing environment. The existing Oblien credentials and
signed webhook configuration are reused; there is no new Stripe integration.
