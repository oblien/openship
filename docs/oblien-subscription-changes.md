# Oblien subscription changes

Openship treats each managed server as an independently billed namespace. Oblien
owns subscription prices, payments, allowance adjustments, renewal and entitlement.
Openship owns the server UI and reuses its existing resource-change preview and
restart flow.

As checked on October 3, 2026, the published Oblien SDK 2.6.0 and live catalog do
not expose prorated plan changes or scheduled downgrades. The current subscription
checkout replaces a contract at full price. Openship therefore permits it only
when no live subscription exists. An active, trialing, past-due, unpaid, paused or
scheduled-to-cancel subscription must remain unchanged.

## Required provider behavior

1. **Preview:** accept the target reseller offer and billing interval for the
   authenticated namespace. Return current and target terms, the unused-time
   credit, amount due now including applicable tax/discounts, effective date,
   next renewal date/amount, currency, and an expiring quote identifier bound to
   the current subscription revision. Use the saved paid offer for the credit.
2. **Upgrade:** confirm that quote with an idempotency key. Collect the prorated
   difference, including any required payment authentication. Apply the new
   entitlement and limits only after payment is confirmed. A failed or abandoned
   payment leaves the current contract and resources intact. Keep the current
   cycle anchor for changes within the same billing interval.
3. **Downgrade:** schedule the quoted target terms at the current period end,
   preserving the paid plan and limits until then. Return the pending change and
   its effective date in the subscription response. Support cancellation and
   replacement of the schedule without charging or ending the current plan.
4. **Allowances:** own any prorated allowance adjustment. Preserve purchased
   top-ups and already-metered usage; neither an upgrade nor its retry may reset
   usage or grant a second full cycle of credits.
5. **Reconciliation:** expose the change's pending, payment-required, completed,
   failed and canceled states, with signed events. Bind reads, quotes, actions
   and events to owner, namespace and subscription revision. Reject stale quotes
   and conflicting actions; retries and webhook redelivery must be idempotent.
6. **SDK:** publish the supported API methods, response types and capability
   advertisement so clients never infer support from an untyped endpoint.

## Server resource changes

Openship must show the returned price difference and effective date before
confirmation. It must also show the affected projects and obtain restart consent
before a resize. Confirmed upgrades should then trigger the shared resize flow;
scheduled downgrades must not resize early.

Disk shrink is currently unsupported in place. A smaller offer must retain the
existing disk through a supported offer, or require migration to a smaller server
before scheduling. A delayed resize failure must be retryable and visible; payment
success alone is not proof that the server has resized.

Provider coverage must include concurrent/repeated changes, stale quotes, failed
payments, payment authentication, cancellation/resumption conflicts, monthly and
annual terms, renewal races, webhook retry/order, top-up preservation and tenant
isolation. Openship will add adapter, route, SDK and UI coverage against the actual
published contract once it is available.
