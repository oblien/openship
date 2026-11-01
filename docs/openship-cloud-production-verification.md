# Cloud production-path verification — 2026-09-19

## Current status: hosted checkout opens; paid-cycle verification remains

The latest check against Oblien successfully created a Hobby/monthly hosted
checkout with Openship's production return URLs. Repeating the identical request
with the same saved idempotency key returned the same checkout session. A fresh
subscription read still returned `null`: opening checkout did not grant access.
The test used a new disposable namespace identity and did not touch an existing
customer's subscription or balance.

The supplied credentials were described as staging, but the returned Stripe
checkout ID is in **live mode** (`cs_live_…`). No payment was attempted. A completed
payment, its signed public webhook, renewal, refund and cancellation behavior
on the intended account remain unverified.

The deployed Openship API returned HTTP 200 with `cloudMode: true` for
`GET /api/health`. An unsigned
`POST https://api.openship.io/api/billing/oblien-webhook` returned HTTP 401
`invalid signature`, confirming that the public handler is present and has its
signature gate enabled. An earlier probe hit an origin timeout; subsequent
probes succeeded. This does not verify the configured secret against a real
provider delivery.

Current [billing](https://oblien.com/docs/api/billing) and
[reseller](https://oblien.com/docs/saas-reselling) documentation still support
our catalog-based Mode-B integration. Custom reseller `offer` checkout and
checkout-status lookup are optional, separate contracts that Openship does not
currently use. SDK 2.4.0 is now published and installed; the manifest and lockfile
resolve it. Its live catalog passes Openship's validator, including Enterprise's
null allowances. A regression test also ensures that invalid negative allowances
still fail validation.

This review fixed top-up retries to retain the original payment key, exposed
only validated diagnostic references and retryability alongside known billing
error codes, and bound current webhook body IDs to their headers. Legacy
notifications without a body ID remain supported. Oblien does not automatically
retry outgoing application webhooks; Openship re-reads provider truth on billing
and deployment actions and runs a paginated entitlement sweep every five minutes.

Read-only provider checks also confirmed zero-credit defaults with no overdraft,
current catalog amounts, and namespace-matched subscription, entitlement,
balance and policy responses for two unpaid namespace samples.

## Earlier hosted checkout failure, now cleared

A direct check with the supplied staging credentials reached Oblien successfully
but `POST https://api.oblien.com/billing/checkout` returned HTTP 400:

```json
{
  "success": false,
  "error": "ER_CANT_AGGREGATE_NCOLLATIONS",
  "code": "ER_CANT_AGGREGATE_NCOLLATIONS",
  "message": "Failed to create subscription checkout"
}
```

The failure reproduced for the full Openship Hobby/monthly request and a minimal
documented Pro request containing only `namespace`, `kind: "subscription"`, and
`planTierId: "pro"`. The latter used direct HTTP without the SDK, return URLs, or
an idempotency key. No checkout URL was returned and no payment was attempted.
The disposable namespace was not created: this staging key's create request
separately returned `namespace_limit_exceeded`. Checkout permits an absent
namespace under the documented contract; no existing customer was used for this
probe. These results do not verify the deployed production account.

This failure no longer reproduced in the current checkout check above.
Openship records the upstream
operation, HTTP status, and bounded error code without logging credentials,
customer namespaces, SQL, or provider messages. Provider SQL failures are mapped
to HTTP 503; checkout returns `OBLIEN_CHECKOUT_UNAVAILABLE`. This behavior was
confirmed against the live failure through the updated wrapper. The error
handling passed 66 targeted billing tests, API type checking, and the production
API build.

The simulated application checks below remain useful regression coverage. They
do not establish real payment or signed webhook delivery on the intended account.

## Application verification with a simulated provider

Both production builds passed from a clean source snapshot containing the Cloud billing and onboarding changes, without local `.env` files. Dependencies were installed with Bun 1.3.3 and `--frozen-lockfile`. The dashboard was built with `NEXT_PUBLIC_API_PROXY=true`, matching its Dockerfile. This update requires rebuilding and deploying both API and dashboard.

The latest resource presentation update leads with project counts, simultaneous services, monthly build minutes and per-service CPU/RAM. Exact credit values and charts are expandable accounting details. Usage packs show their price and size relative to the subscription's actual monthly or annual provider grant. No-plan Cloud accounts have zero projects, build minutes and services; the API rejects their first project creation without leaving a project record behind. Existing projects are retained, and self-hosted project creation remains unmetered.

The compiled API and standalone Next.js dashboard ran together in production mode with isolated Postgres and Redis. Two real application users signed in through the dashboard’s API proxy. Oblien HTTP responses and payment events were simulated; no live payment was made.

All 31 runtime and browser checks passed with SDK 2.4.0:

- Fresh Postgres database migrated and two customers seeded.
- Compiled API starts in production Cloud mode with Postgres and Redis.
- Standalone dashboard starts with runtime API routing.
- Both customers sign in through the dashboard proxy and read enabled billing with zero free credits.
- Each customer receives a distinct namespace with resource limits.
- A customer without a paid plan cannot buy unusable top-up credits.
- Billing SSR succeeds and layout/tab share exactly one state request.
- Safe provider support references reach customer errors without exposing SQL or account details.
- Checkout uses the authenticated namespace and deployed return URL without granting access early.
- A signed billing event cannot be replayed under a different webhook header ID.
- Paid billing remains available when workspace resource operations fail.
- Signed provider event updates only the paid customer; unsigned events are rejected.
- Concurrent billing SSR requests keep the paid and free customers isolated.
- Portal, cancellation and resumption stay scoped to the signed-in customer.
- Top-up checkout reaches Oblien for the correct namespace.
- Existing-customer checkout remains available when workspace resource operations fail.
- Billing SSR survives an 11-second upstream response without duplicate work.
- Provider failure renders the recoverable error, not an organization activation message.
- API startup registers an active signed account-wide billing webhook.
- Container readiness checks are read-only, handle masked secrets, and reject confirmed mismatches.
- Compiled API refuses an enabled but incomplete billing configuration before serving requests.
- Circular meters show measured compute, monthly edge traffic, visitor requests and remaining allowances through authenticated APIs.
- Paid resource cards, measured usage units and monthly/yearly plans hydrate against the compiled API; credit amounts are hidden until Usage details is expanded.
- Usage packs show prices and their share of the plan allowance before optional accounting details.
- A customer without a plan sees zero project, service and build allowances plus a resource-focused subscription offer on the right, including with a legacy null credit policy.
- Mobile billing fills the viewport, keeps Subscribe above the fold, and restores focus when its navigation drawer closes.
- Every unpaid billing tab offers a useful next step without requesting an unavailable portal or top-up checkout.
- Arabic billing renders in RTL at desktop and mobile widths.
- The subscription offer opens hosted checkout for the signed-in customer's namespace without granting credits before payment.
- All billing views complete without browser exceptions.
- No reseller workspace-quota calls occur across onboarding, billing, checkout, or webhooks.

The resource presentation update passed 186 focused tests: 76 dashboard billing/localization tests, 40 API billing/quota tests and 70 shared pricing tests. Both application type checks passed. These cover the first no-plan project refusal, concurrent paid project creation, self-hosted creation, zero free build allowance, actual monthly/annual grants, expandable accounting, missing catalog data, explicit enterprise unlimited entitlements, purchased-credit history, subscription requirements for top-ups, and pricing appearing only after an explicit deployment action. Desktop, mobile, light, dark and Arabic billing views were inspected in the browser.

The subsequent contract review passed 177 API billing/contract/configuration tests
and 27 dashboard billing tests, both application type checks, both production
builds, and the earlier 30 compiled-application checks. Coverage includes
stable top-up retries, matching signed webhook IDs, and safe diagnostic
references through the real HTTP error handler. An old converter test was
updated to expect the new zero-credit free tier; the positive-grant converter
still rejects zero amounts. No checkout payment or live credit grant was made.

The SDK 2.4.0/resource-meter update passed 219 API billing, quota and resource
tests, 65 dashboard billing tests, and 73 Cloud adapter tests. Both application
type checks and production builds passed. The 31 compiled-application checks
above used real Postgres, Redis, authentication, HTTP controllers and dashboard
pages with a simulated Oblien server. New cases cover namespace-scoped analytics,
explicit traffic periods, used/remaining rings, partial telemetry failure,
cross-organization denial, leap-year/month-end build resets and measured build
usage on uncapped plans. Docker transport tests required local Unix sockets and
passed outside the filesystem sandbox.

A separate live check using the supplied staging credentials and SDK 2.4.0
validated the current four-plan/five-pack catalog, zero-credit defaults,
namespace subscription/entitlement/balance agreement, compute usage units and a
60-second namespace token for edge analytics. The inspected namespace had no
domains, so nonzero edge aggregation was verified with provider fixtures. No
subscription, balance or default was changed. Checkout-status lookup in 2.4.0 is
documented for saved reseller offers; catalog purchases continue to reconcile
through the namespace entitlement and subscription endpoints.

A separate read-only check against Oblien confirmed the staging account's automatic defaults: `quotaLimit=0`, `overdraft=0`, `suspendThreshold=0`, `autoApply=true`, and `onOverdraftAction=stop_workspaces`. Public catalog prices and credit allowances supplied the browser fixtures. No account defaults, existing namespace balances, or live subscriptions were changed.

Earlier read-only checks also verified private credential access, an existing namespace's allowance and subscription, and an active account-wide webhook registration. The two purchase flags were disabled in that local configuration. Oblien returned a masked webhook secret, so secret equality was explicitly skipped; this does not verify a signed delivery or the deployed API's environment.

This run used macOS with Node 22 and Postgres 14. The Linux Docker images were not executed because the local Docker daemon was unavailable. The production environment, public webhook delivery, and real payment completion still require verification on the deployed account.

After pushing all required source files, rebuild both API and dashboard from that revision. Keep production credentials in the API runtime environment and enable the purchase flags there. For the root SaaS Compose stack:

```sh
docker compose up -d --build api dashboard
docker compose exec api bun run --cwd apps/api cloud:check
```

See [Cloud launch configuration](openship-cloud-launch.md#enable-purchases-in-the-deployed-saas).

## Earlier follow-up: unlimited reseller accounts

Removed the reseller `/workspace/quota` dependency from namespace onboarding,
resource-policy synchronization, and deployment preflight. Customer ceilings come
from their Openship plan; Oblien owns platform capacity. Billing, checkout, and
plan reads no longer write workspace resource policies. Token issuance, spending,
and webhook synchronization still enforce customer ceilings and credit policy.
Billing and subscription checkout reuse the verified subscription instead of
fetching it twice.

The rebuilt production API passed 20 integration checks with the standalone
dashboard, isolated Postgres and Redis, and simulated Oblien HTTP responses.
The provider fixture returned unlimited reseller quotas and deliberately failed
workspace-management endpoints while paid billing and checkout continued to work.
No reseller workspace-quota requests occurred during onboarding, billing,
checkout, or webhook handling. Free and paid customer isolation, signed webhooks,
portal access, cancellation/resumption, and delayed billing reads also passed.

All 170 targeted billing, provider-contract, preflight, and deployment/service
quota tests passed, along with API type checking and the production API build.
The capacity fix alone required only an API deployment. The subsequent customer
billing changes verified above require both API and dashboard deployments.
Production deployment and live payment completion were not performed in this
verification.
