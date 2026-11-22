# Cloud customer emails

OpenShip Cloud sends four independent transactional messages:

| Trigger                                                        | Message                                                                                                 | Sender                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A new signup verifies its email                                | Welcome, workspace link, optional Cloud plans link, and an invitation to ask for help                   | `SMTP_SUPPORT_FROM` when configured, otherwise `SMTP_FROM`; replies go to Support |
| A server subscription or managed-service purchase is confirmed | Purchase welcome, setup link, and support guidance                                                      | `SMTP_SUPPORT_FROM` when configured, otherwise `SMTP_FROM`; replies go to Support |
| A payment or renewal is confirmed                              | Separate invoice/receipt notice with the amount, payment reference, and scoped billing link             | `SMTP_BILLING_FROM` when configured, otherwise `SMTP_FROM`                        |
| Subscription cancellation is confirmed                         | Cancellation confirmation, scheduled end date when applicable, and an invitation to reply with feedback | `SMTP_SUPPORT_FROM` when configured, otherwise `SMTP_FROM`; replies go to Support |

The billing provider remains the invoice issuer. OpenShip does not create a second
tax invoice or invent invoice numbers. The email links to Payments & invoices,
where the customer can open the provider's billing portal and download the official
invoice or receipt. Stable application links avoid emailing expiring portal sessions.
Actions funding remains on its independent payment-reconciliation path.

## Delivery and ownership

- Signup mail is saved in the account bootstrap transaction. Unverified signups
  remain queued without delivery attempts until the address is verified. OAuth
  signups with a verified address use the same path. Desktop identities and local
  mirrors do not enqueue welcome mail.
- Billing mail is prepared only downstream of HMAC verification, persisted
  namespace ownership and entitlement synchronization. Its outbox rows commit with
  the webhook checkpoint. Browser checkout-return parameters never send mail.
- The organization owner receives purchase, invoice and cancellation mail. Delivery checks their
  current verified email and owner membership again, so a departed owner does not
  receive new billing details. Customer deletion cascades to private mail records.
- Each account gets one signup welcome. Each independent billing namespace gets
  one purchase welcome. Each payment gets one invoice/receipt notice, including
  renewals. Repeated webhooks do not recreate those messages.
- Cancellation mail uses the provider's current subscription, not event claims.
  `subscription.updated` and `subscription.canceled` queue one confirmation per
  namespace and provider cancellation timestamp; the eventual period-end event
  does not repeat the feedback request. Delivery rechecks the subscription:
  resumed, replaced or missing cancellations are suppressed, and a delayed
  message reflects the current end date or says the subscription has ended.
  Missing or invalid cancellation dates do not produce an invented confirmation.
- Cancellation emails identify the affected Cloud workspace or managed service,
  link to its scoped billing page, and do not imply sibling subscriptions have
  ended. They do not change access, provisioning, renewal or cancellation policy.
- Migration creates an empty outbox; it does not email existing accounts in bulk.
  Private delivery records are excluded from instance exports and transfers.

## Operations

The SaaS worker runs at startup and every minute as `cloud-customer-email:deliver`.
Cloud system mail, including password reset and verification codes, uses the
Oblien SDK when the API has both `OBLIEN_MAIL_NAMESPACE` and `OBLIEN_MAIL_KEY`.
Use an Openship-owned namespace with an active mail tenant, sending allowance,
funded credits, and a verified sending domain. Store a send-only key in the
Cloud API secrets. The namespace is fixed for platform mail across all customer
organizations. See the [Oblien mail guide](https://oblien.com/docs/api/mail).

`SMTP_FROM` supplies the default sender for both transports. Set
`SMTP_SUPPORT_FROM` or `SMTP_BILLING_FROM` for customer mail if desired.
Authorize all configured addresses on the sending key. The SDK sends their bare
email addresses. Welcome and cancellation replies go to `support@openship.io`.
With both Oblien mail settings unset, existing deployments use SMTP.
An Oblien submission failure stays on the SDK path for retry.

Rows in `cloud_customer_email` retain delivery status, attempt count, lease and
timestamps. A worker claims one message at a time with a five-minute SQL lease.
Abandoned leases are recoverable after restart. Failures retry with exponential
backoff, capped at six hours, and stop after twelve attempts with status `failed`.
Errors are normalized; SMTP secrets and customer data are not copied into failures.
System job summaries expose sent, failed and canceled counts.

Outbox retries derive the same Oblien idempotency key from the saved delivery
identity, including after a lost response. With SMTP, a process crash after
acceptance can cause a duplicate even though the retry reuses the Message-ID.
Operators should inspect failed deliveries before requeuing them.

Cancellation verification failures use the same bounded retry policy as SMTP
failures; they do not send an unverified goodbye. The migration only adds the
payload column and allowed message kind. It preserves existing delivery records
and does not send retrospective cancellation emails in bulk.

For a missing welcome, inspect the `signup:<user-id>` outbox row and the
`cloud-customer-email:deliver` job. Verified Google signups are eligible immediately,
but delivery occurs on the next worker tick. An existing account logging in again
does not receive another welcome. Pending messages retry on their scheduled attempt
after a sender configuration fix is deployed; terminal `failed` rows require an
operator review and requeue. A missing row can indicate an account created before
customer emails were deployed, or signup on a non-Cloud instance.
