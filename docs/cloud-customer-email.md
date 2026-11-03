# Cloud customer emails

OpenShip Cloud sends three independent transactional messages:

| Trigger                                                        | Message                                                                                     | Sender                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| A new signup verifies its email                                | Welcome, workspace link, optional Cloud plans link, and an invitation to ask for help       | OpenShip Support `<support@openship.io>`; replies go to Support |
| A server subscription or managed-service purchase is confirmed | Purchase welcome, setup link, and support guidance                                          | OpenShip Support `<support@openship.io>`; replies go to Support |
| A payment or renewal is confirmed                              | Separate invoice/receipt notice with the amount, payment reference, and scoped billing link | OpenShip Billing `<noreply@openship.io>`                        |

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
- Payment mail is prepared only downstream of HMAC verification, persisted
  namespace ownership and entitlement synchronization. Its outbox rows commit with
  the webhook checkpoint. Browser checkout-return parameters never send mail.
- The organization owner receives purchase and invoice mail. Delivery checks their
  current verified email and owner membership again, so a departed owner does not
  receive new billing details. Customer deletion cascades to private mail records.
- Each account gets one signup welcome. Each independent billing namespace gets
  one purchase welcome. Each payment gets one invoice/receipt notice, including
  renewals. Repeated webhooks do not recreate those messages.
- Migration creates an empty outbox; it does not email existing accounts in bulk.
  Private delivery records are excluded from instance exports and transfers.

## Operations

The SaaS worker runs at startup and every minute as `cloud-customer-email:deliver`.
It uses the existing SMTP transport, which must authorize both sender addresses.
Self-hosted instances cannot select these SaaS sender identities.

Rows in `cloud_customer_email` retain delivery status, attempt count, lease and
timestamps. A worker claims one message at a time with a five-minute SQL lease.
Abandoned leases are recoverable after restart. Failures retry with exponential
backoff, capped at six hours, and stop after twelve attempts with status `failed`.
Errors are normalized; SMTP secrets and customer data are not copied into failures.
System job summaries expose sent, failed and canceled counts.

SMTP is an at-least-once transport: a process crash after server acceptance but
before the database acknowledgement can cause a retry. Every retry retains the
same Message-ID; event deduplication and leases prevent ordinary duplicate sends.
Operators should inspect failed deliveries before requeuing them.
