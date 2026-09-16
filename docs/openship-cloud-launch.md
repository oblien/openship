# Openship Cloud release gate

Cloud uses Oblien Mode B. Oblien owns hosted checkout, payment collection,
subscription renewals, credit grants, usage enforcement, and workspace lifecycle.
Openship owns customer identity, project/build orchestration, application
permissions, and the dashboard. It calls the provider APIs for infrastructure;
it does not operate a hypervisor or maintain an independent payment ledger.

This implementation has automated coverage, but has **not** completed a live
signup → payment → deployment smoke test. Do not enable public purchases until
the provider configuration and release checks below pass.

## What is connected

- `oblien@2.3.0` supplies the official billing module. Openship validates the
  returned namespace, subscription shape, and hosted URL. Its transport rejects
  redirects, bounds request time, and keeps provider error bodies private.
- Public prices and credit packs come from `/billing/catalog`. Marketing and
  the dashboard use the same catalog as checkout. Internal plan IDs remain
  stable: `starter → hobby`, `pro → pro`, `team → scale`.
- Purchases use `/billing/checkout` with the authenticated organization's
  namespace, the selected interval, and a scoped idempotency key. Checkout first
  requires the new namespace subscription API, so older provider deployments
  cannot silently fall back to shared customer billing.
- The namespace portal provides invoices, payment methods, and cancellation.
  Customers can also cancel or resume renewal from Overview. Both actions are
  repeatable; cancellation preserves the paid period. They remain available
  when new purchases are disabled. Portal/cancel/resume require `billing:admin`.
- Paid plan/interval changes use a replacement checkout. Oblien starts a new
  full-price cycle after payment without automatic proration. The dashboard
  discloses these terms, displays scheduled cancellation, and supports yearly
  plans and resubscribing after an ended subscription.
- Signed Oblien events trigger a fresh entitlement read. The browser return URL
  never grants access. Failed synchronization returns 503 for retry; repeated
  deliveries are deduplicated. A five-minute reconciliation job repairs missed
  events without resetting quotas or granting credits.
- Every customer runtime uses a namespace token and explicitly supplies the
  namespace on workspace creation. Namespace ownership is immutable and unique
  in the database. Admin-only Pages/routing operations check every referenced
  resource's namespace on the SaaS, including desktop/self-hosted calls.
- New billable work requires a current entitlement and usable provider balance.
  Stop/delete paths remain available when credits are exhausted.
- Route removal calls the actual provider revoke/disconnect APIs. Certificate
  status comes from the provider. Unsupported volume mounts fail before a build
  can silently discard the customer's storage configuration.
- The direct Stripe webhook returns 410. The old automatic quota-grant/reset
  functions refuse execution. Historical billing rows are retained for migration.

## Observed account configuration, 2026-09-15

Checks against the configured credentials, followed by staging default-policy
setup after the user confirmed the account. Billing endpoints and the webhook
registry were rechecked at 20:15 UTC:

| Check | Result |
| --- | --- |
| Oblien authentication/catalog | Reachable; three priced plans and five packs |
| Automatic namespace defaults | Changed from unlimited to `quotaLimit=0`, `overdraft=0`, `suspendThreshold=0`, `autoApply=true` for staging |
| Exhaustion action | `stop_workspaces` |
| Subscription and top-up flags | Both disabled |
| Staging webhook registry | No webhooks registered |
| `.env.local-saas` callback | Needs an explicit public HTTPS callback |
| Account identity | User confirmed `.env.local-saas` is staging/test; `.env.saas` contains the same Oblien credentials |
| New subscription API with staging key | Read returned 200 with the correct namespace for existing and unused namespaces; cancel/resume returned the expected `404 no_subscription` for the unused namespace |
| Portal for an unused staging namespace | Returned the documented `404 no_customer` |

The earlier `401 authentication_required` blocker is resolved. The same staging
key also returned 200 for `/namespaces` and `/billing/defaults`. The read-only
Openship readiness checker passed the SDK-backed catalog, default-policy, and
namespace subscription checks; it still fails for the missing public HTTPS
callback and disabled purchase flags. These probes do not yet verify management
of a paid subscription or a complete payment/webhook cycle. Openship rejects an
unscoped portal response; it never returns the owner's billing session.

No namespace, token, checkout, workspace, or payment was created. The only
provider configuration write set the staging account's default policy for new
namespaces; existing namespace usage and paid allowances were not reset.
Configure a separate verified production account before launch rather than
assuming the `.env.saas` filename indicates production provider credentials.

## Provider configuration

1. Use the confirmed `.env.local-saas` staging key for integration tests. The new
   endpoints now accept this key and return the documented responses. Confirm Stripe
   checkout is in test mode before completing a test payment. Confirm the
   production account's identity and `max_namespaces` capacity before launch.
2. Configure finite **new-namespace defaults** in the production Oblien account.
   This is already configured for the confirmed staging account. The initial
   policy is payment before compute: zero quota and zero overdraft. A capped
   trial is a separate product decision. Example `PUT /billing/defaults` body:

   ```json
   {
     "autoApply": true,
     "quotaLimit": 0,
     "overdraft": 0,
     "onOverdraftAction": "stop_workspaces",
     "suspendThreshold": 0
   }
   ```

   Review the account this applies to first. Do not apply this default to
   existing paid namespaces or reset their usage. Oblien grants paid allowances
   on successful payment. Openship only validates this configuration.
3. Configure the API process:

   ```dotenv
   CLOUD_MODE=true
   OPENSHIP_TARGET=cloud-saas
   OBLIEN_API_URL=https://api.oblien.com
   OBLIEN_CLIENT_ID=<server-only key>
   OBLIEN_CLIENT_SECRET=<server-only secret>
   OBLIEN_WEBHOOK_SECRET=<shared signing secret>
   OBLIEN_WEBHOOK_URL=https://api.openship.io/api/billing/oblien-webhook
   BILLING_ENABLED=false
   BILLING_TOPUPS_ENABLED=false
   ```

   Use staging origins/credentials for staging. Set `OPENSHIP_CLOUD_API_URL` and
   `OPENSHIP_CLOUD_DASHBOARD_URL` to the actual staging origins so checkout
   returns and the marketing catalog point to staging. If a reverse proxy serves
   the API under a prefix, supply that full path in `OBLIEN_WEBHOOK_URL`.
   Have the Oblien operator add the dashboard return host to
   `REDIRECT_ALLOWED_HOSTS`; unlisted hosts silently return to the provider's
   default dashboard. Verify the actual checkout and portal return destinations.
4. Start the updated API and confirm webhook registration succeeds. The hook
   must be active, signed, account-wide, and include every event exported by
   `oblien-webhook-config.ts`. Confirm real signed delivery reaches the handler;
   registration alone does not prove that routing or the secret is correct.

From `apps/api`, run the read-only checker against the intended environment:

```sh
node --env-file=.env.saas --import tsx scripts/cloud-readiness.ts
```

It also verifies an authenticated, namespace-bound response from the new
subscription endpoint. It exits nonzero for failed checks, including disabled purchase flags. Those
flags should remain disabled in production until the remaining release gates
are satisfied. Enable them in staging when deliberately testing checkout.

## Existing installations

- Back up the database and apply `0127_organization_oblien_namespace.sql` using
  the normal migration runner. Duplicate namespace bindings must be resolved
  explicitly; the migration intentionally refuses to silently merge customers.
- Inventory existing provider workspaces and Pages against organization/project
  records. Old resources created in the default namespace need an ownership
  migration before exposing them to customers. Creating a new namespace does
  not move an old workspace, its disk, its routes, or its Pages.
- Accounts with live legacy Stripe subscriptions are blocked from new checkout
  to avoid duplicate billing. Migrate/settle those subscriptions explicitly.
- Stop old API/worker versions before switching billing authority. The updated
  recurring job replaces the old anniversary-reset entry, but an old process
  still executing old code must not be allowed to grant/reset quotas.
- Check Redis/job-runner configuration for multiple API replicas. Folder upload
  sessions currently use process memory and need instance affinity; a restart
  invalidates the upload session, with provider TTL as resource cleanup.

## Customer billing contract and remaining release checks

The updated billing contract requires a namespace for the portal and returns it
in the response. Each namespace has its own Stripe customer. A legacy shared
customer returns `409 billing_customer_conflict`; an inconsistent subscription
identity returns `409 billing_identity_conflict`. Neither is bypassed in Openship.

- Authentication and empty-namespace responses are verified against staging.
  Test two customer portals, invoice/payment isolation, cancellation, resumption,
  and plan replacement with paid test subscriptions.
  `GET /billing/subscription` exposes the provider's actual interval, period,
  and pending cancellation; this metadata is read live rather than inferred
  from the entitlement's status.
- Cloud organization deletion is blocked before local ownership is erased.
  Support must coordinate provider billing closure and resource removal. The
  old hook that tried to cancel Stripe after cascading away its local rows is
  removed. The new cancellation API does not provide invoice settlement or a
  complete namespace/account closure workflow. A canceled status alone does
  not prove billing is settled.
- Verify that concurrent/abandoned subscription checkouts cannot create two
  billable subscriptions for one namespace. The provider now documents replacing
  only that namespace's old subscription after payment; test this with multiple
  pending checkouts. A checkout status/expiration API is still not documented.
  Do not infer payment from a checkout redirect.

Persistent named/shared/bind volumes are not supported by the documented
workspace API. Cloud refuses these declarations. Image-backed services can
reuse their own workspace disk; replacing that workspace does not transfer the
disk. Stateful services requiring Docker volume semantics need a server target
until provider-backed persistence and recovery are implemented and tested.

## Staging acceptance

1. Create two organizations. Verify distinct namespace bindings and finite
   onboarding policies. With zero onboarding credit, a build must be refused.
2. Buy a Pro monthly plan for A through the UI. Verify the namespace in the
   provider checkout, the charged catalog amount, the signed payment event,
   entitlement synchronization, and the dashboard's refreshed plan/balance.
   Repeat with a yearly plan on a separate test organization.
3. Retry the same checkout request/key and deliver the same webhook twice.
   Confirm there is one purchase and no duplicate credit grant. Deliver an old
   suspension event after restoration; current provider state must win.
4. Buy a credit pack. Verify purchased credits survive renewal without resetting
   metered usage during the purchase. Legacy signed `used` values must not be
   clamped. A redirect by itself must not alter permissions or credits.
5. Deploy and redeploy a static site and an HTTP application. Exercise free
   domains, custom domains/TLS, logs, restart, stop, route removal, and deletion.
   Repeat static deployment from a linked desktop/self-hosted instance.
6. Attempt to read/delete/redeploy A's page/workspace from B. Try a route whose
   hostname is owned by B but whose backend or static page belongs to A. All
   cross-organization attempts must fail.
7. Exhaust/suspend A through provider test controls. New work must fail; B must
   keep working; A must still be able to inspect/stop/delete its resources.
8. Test webhook downtime and recovery, unavailable billing reads, failed domain
   operations, and build TTL setup failure. No failed operation may be reported
   as successful. Inspect the provider account for orphan workspaces afterward.
9. Cancel A at period end, repeat cancellation, and resume renewal. Verify A's
   paid period/balance remain intact and B is unchanged. Change A's plan and
   interval through checkout; verify the disclosed full price, new cycle, and
   replacement of the old subscription. Check that each portal shows only its
   customer's invoices/payment methods and rejects shared legacy billing.
   Exercise the support closure procedure and check for continuing charges or
   orphan resources after closure.
10. Only after these checks pass, enable the production purchase flags, rerun
    `cloud-readiness.ts`, and monitor webhook failures and reconciliation errors.

Provider references: [index](https://oblien.com/llms.txt),
[billing](https://oblien.com/docs/api/billing),
[namespaces](https://oblien.com/docs/api/namespaces),
[Pages](https://oblien.com/docs/api/pages),
[scoped tokens](https://oblien.com/docs/api/scoped-tokens).
