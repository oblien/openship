# Openship Cloud release gate

Paid Cloud subscriptions use Oblien Mode B. Oblien owns hosted checkout, payment collection,
subscription renewals, credit grants, usage enforcement, and workspace lifecycle.
Openship owns its prices, product copy, namespace allowances and application limits,
customer identity, project/build orchestration, and the dashboard. It calls the provider APIs for infrastructure;
it does not operate a hypervisor or maintain an independent payment ledger.

Operators can also issue [complimentary Cloud plans](complimentary-cloud-plans.md).
These have a separate, audited grant and a zero customer price. Their finite
monthly allowances use Oblien Mode A; ordinary paid subscriptions keep the
provider-managed checkout and renewal flow.

The Docker deployment path passed 31 live staging checks on 2026-09-17, including
rollback, volume restore, cold restart, HTTPS and resource cleanup. After Oblien's
billing fixes, fresh namespace defaults, subscription ownership, Docker metering,
usage-driven exhaustion, automatic billing shutdown, manual suspension and
customer isolation pass live checks. The `opsh.io` restriction applied to the
staging key; the operator confirmed that the production account supports it.
Production acceptance still requires signup → payment → signed public webhook
verification against the deployed API, including a production-domain deployment.
The final two-customer isolation/lifecycle run passed all 52 checks at 04:31 UTC.
See [the current provider test report](./oblien-staging-cycle-report.md). Keep
public purchases disabled until these checks pass.

The September 19 hosted checkout probe now succeeds and reuses the same session
for an identical idempotent retry. The earlier Oblien SQL collation failure no
longer reproduces. A fresh namespace still has no paid subscription after merely
opening checkout. A completed payment and signed public delivery remain to be
verified; see [the checkout verification report](openship-cloud-production-verification.md).

## Reseller offer contract, 2026-09-21

New purchases use Openship's $10 / $39 / $99 monthly catalog. Each checkout saves
an immutable generic offer: price, namespace credits, zero-by-default configurable
grace, VM caps and application plan metadata. The namespace receives the customer
subscription. The reseller account receives wallet funding and retains its own
platform subscription. Oblien has no Openship-specific plan mapping.

New namespace checkouts require the reseller owner's Enterprise account or an
operator-granted Enterprise tier. Oblien enforces this for custom offers, catalog
plans and top-ups in test and live mode. A customer's Openship plan cannot grant
it. `reseller_enterprise_required` is an operator configuration failure, shown to
customers as a request to contact Openship support. Existing customer billing
management and renewal/refund processing continue after an owner downgrade.

Openship resolves `reseller` subscriptions using the saved offer reference,
organization, namespace and application-limit snapshot. Unknown or mismatched
contracts fail closed. Renewals keep those terms even when the current catalog
changes. The catalog and detailed configuration are documented in
[`packages/core/src/pricing/README.md`](../packages/core/src/pricing/README.md).

Deploy the matching Oblien API first: `/billing/catalog` must report
`reseller: { contractVersion: 2, offerPolicy: true, resourceLimits: true, effectiveResourceLimits: true }`.
Dashboard docs alone cannot enable this contract. Then deploy the updated
Openship API and dashboard together. Checkout and the readiness check reject an
older provider; startup also logs the missing capability. Existing subscription
management remains available during that update. The npm SDK remains pinned to the
published 2.4.0 transport, so Openship does not depend on a pending SDK release.

The user reports a successful test-mode payment with the earlier integration.
That is not a live acceptance result for this new offer contract. Keep the
configured provider mode intact and verify the changed cycle after deployment.
The historical reports below describe their original code and dates.

Checkout returns include `session_id`. `GET /api/billing/checkout?checkoutId=...`
checks that session through the authenticated organization's namespace. The UI
waits for paid/completed fulfillment with a positive net credit grant; an old
active subscription or a forged success query cannot confirm payment. Refund,
dispute, expiry and provider errors have explicit states. Signed events and the
five-minute sweep continue to reconcile authoritative subscription state.

For this deployment, the callback is
`https://api.openship.io/api/billing/oblien-webhook`; browser checkout/portal
returns use `https://app.openship.io`. Allowlist `app.openship.io` in Oblien's
redirect configuration. The callback URL is a server POST receiver and is not a
browser return URL.

## What is connected

- `oblien@2.4.0` supplies the official billing module. Openship validates the
  returned namespace, subscription shape, hosted URL, and agreement between the
  namespace subscription and its entitlement. Its JSON transport rejects
  credential redirects, bounds request time, checks both HTTP and body failures,
  preserves SDK request cancellation, and keeps provider error bodies private.
  Workspace limits now return HTTP 409 in the live API; compatibility handling
  also rejects the older HTTP 200 `valid:false / NAMESPACE_LIMIT_REACHED` response.
- Public prices and credit packs come from Openship's server catalog, served by
  `/api/billing/plans` to marketing and all dashboards. Legacy provider IDs
  `hobby`, `pro`, `scale` remain readable, but new checkout sends an `offer`.
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
  Openship does not apply the spend gate before Stop/Delete. Scoped inspection,
  repeated Stop and Delete pass during billing and manual suspension. Accepted
  asynchronous workspace deletions are confirmed before completing local
  teardown; failed inspection or timeout leaves cleanup retryable.
- New namespaces get explicit resource ceilings derived from the customer's
  Openship plan. Oblien owns reseller/platform capacity; billing and namespace
  onboarding do not depend on the reseller's workspace-quota response. Billing
  reads and checkout do not synchronize resource ceilings. Spend and token gates
  still confirm customer ceilings without changing credits or usage. Builds,
  updates, rollbacks and direct
  Start/Restart and project resume check the actual CPU/RAM allocation and service
  allowance before starting containers. Service deployments record the applied
  limits for their exact container identity; a stopped Cloud Docker host can use
  that record without booting for inspection. Missing legacy allocations require
  inspection on a reachable host or redeployment. Editing future resource settings
  does not change the allocation of an existing container.
- Organization locks serialize project creation, service creation/enabling,
  and deployment reservations. Native apps and Compose containers share the
  service allowance; redeploying an existing app does not count it twice.
  Disabling a service definition does not release its slot while its active
  container remains. Unlimited project plans retain their advertised allowance.
  Nested quota and entitlement locks share one PostgreSQL connection, preserving
  a pool slot for normal queries even during a deployment burst. Parallel callers
  retain per-key exclusion, and parent locks remain held until started child
  callbacks finish. Locks still coordinate independent API instances.
- Route removal calls the provider APIs and certificate status comes from the
  provider. Compose volumes persist inside the project's Docker workspace;
  unsupported mounts on legacy native workspaces fail before deployment.
- The direct Stripe webhook returns 410. The old automatic quota-grant/reset
  functions refuse execution. Historical billing rows are retained for migration.

## Deployment pricing and billing UX, 2026-09-18

Project setup and configuration do not open pricing or require billing access.
The old hosted Deploy waitlist gate has been removed. An explicit deployment,
install, start, or retry that returns `CLOUD_BILLING_BLOCKED` or
`PLAN_UPGRADE_REQUIRED` opens the shared Cloud plan dialog. Saving configuration
does not. Infrastructure errors retain their own error recovery.

The dialog reads the current organization’s billing state after the refusal.
Free accounts see paid plans and a clear statement that no free Cloud compute
is included. Paid accounts see the appropriate credit, payment, suspension, or
capacity recovery. A top-up is never presented as a way to raise a build or
service limit. Members without billing access are directed to the workspace
owner; otherwise permitted deployments do not acquire a `billing:read`
requirement.

Checkout opens in a separate tab, retaining project settings. A stable
idempotency key protects retries, and a link remains available if popups are
blocked. Returning from checkout does not grant access or automatically deploy:
the customer checks the current plan, returns to the project, and retries the
action through the existing server guards. Purchase feature flags still apply.

Pricing uses Openship's server-defined prices and explicit credit grants,
exposed as `monthlyCredits` and `annualCredits` in milli-credits. Build minutes remain a
monthly Openship limit. Cards show build minutes, simultaneous services,
per-service CPU/RAM and project limits with a shared usage explanation. Edge traffic is measured without an invented custom-plan allowance.

Billing leads with measured resource usage. Provider usage buckets are already
whole credits; balance snapshots use milli-credits. Credit totals and the chart
are available under Usage details. The resource table shows measured CPU-hours,
memory GB-hours, disk activity and transfer without inventing a cost split.
Selected end dates include that day up to the current time. Free accounts have
zero project, build-minute and running-service allowances.

The new copy is present in all nine dashboard locales. Automated checks cover
deployment gating, checkout/dismiss/retry, feature flags, billing permissions,
annual allowances, units and dates. Browser checks use mocked billing responses
and checkout on desktop, mobile and Arabic layouts; they do not replace the
production payment/webhook acceptance tests above. The repository-wide locale
checker still reports pre-existing gaps in other namespaces; billing has no
missing, extra or untranslated entries.

## Customer billing onboarding, 2026-09-19

Each customer workspace has its own Oblien namespace. New namespaces start with
zero credits, zero overdraft, and no paid subscription. Openship validates those
automatic defaults without rewriting existing balances. A free-tier entitlement
cannot start billable work even if a legacy policy reports a positive or null
balance. Oblien applies the paid subscription and credits after payment; opening
checkout or returning to the dashboard does not activate compute.

Overview shows **No Cloud plan** and zero projects, running services and build
time for new customers. These are enforced application limits, including on the
first project creation; exceeding them returns `PLAN_UPGRADE_REQUIRED` without
creating a project record. Existing saved projects and purchased-usage history
are retained. Connected self-hosted project creation stays unmetered.

The right column contains a live subscription offer with its price, project
limit, simultaneous services, monthly build minutes and per-service CPU/RAM,
plus Subscribe and Compare all plans. On phones the offer appears first, and
navigation opens in a drawer so the page uses the full viewport width. Project
configuration does not automatically open pricing; an explicit deployment
action shows the plan choice if access is required. Saving a new Cloud project
requires a paid plan.

Paid overview cards show circular used/remaining meters against those limits and
a Cloud usage percentage when the provider supplies a finite allowance. Exact credit amounts
are inside Usage details. An empty or null credit limit never becomes an
Unlimited label. Plan cards explain that builds and apps share an allowance,
with no promised conversion into runtime hours. Top-up cards show their price
and the extra usage as a percentage of the selected subscription interval's
provider credit grant. Top-ups do not increase project, service or build-minute
limits; their accounting amounts remain available in Usage details.

`GET /api/billing/resources` supplies measured CPU-hours, memory GB-hours, disk
activity, compute transfer, edge bandwidth and visitor request counts. It is an
authenticated organization-scoped operation in both SDKs and the local Cloud
proxy. It does not provision resources or change billing policies. Compute usage
must echo the customer's namespace; edge reads use a server-held namespace token.
Monthly traffic is summed from explicit time-range queries, never from the
undated analytics home totals or billing transaction counts. Reads have a shared
deadline and a bounded 30-second cache; an analytics outage only marks those
metrics unavailable and cannot block checkout or subscription management.

Reseller offers do not inherit Oblien platform edge traffic allowances. Traffic
and requests remain measurable; their plan capacity is unknown unless separately
configured and enforced. The overview keeps missing telemetry distinct from measured zero,
and empty circles stay empty at zero use. Builds and runtime share the compute
allowance, so physical CPU-hours are not presented as guaranteed remaining hours.
Build-minute periods now clamp month-end anniversaries without gaps or overlaps,
and uncapped plans still report their measured build time.

Openship's catalog supplies prices, allowances, resource limits, metadata and
checkout copy. The generic offer path is now used for both subscriptions and
top-ups. Existing catalog subscriptions remain readable through a legacy ID
mapping. New offers use their saved identity and application-limit snapshot;
unsupported metadata blocks spending instead of borrowing the owner account tier.

Buying top-ups requires an active or trialing paid customer subscription and
Oblien's current entitlement to be `active` or `credit_exhausted`. Checkout and
dashboard availability share that predicate. An expired period, past-due
entitlement or failed entitlement read cannot qualify through a stale active
subscription record. Scheduled cancellation still allows top-ups until the
paid period ends. Purchased credits add headroom and only their unused remainder
survives renewal. Extra credits alone cannot activate a subscription or raise
resource/application caps.

Checkout errors preserve a validated support reference and known provider code
without exposing the provider's arbitrary error body. Top-up retries keep their
original payment key. Webhooks verify HMAC and match a current signed body ID
to `X-Webhook-Id`; older body-ID-less events retain their existing deduplication
path. Oblien's outgoing webhooks are best effort without automatic retries, so
the periodic entitlement sweep and fresh reads remain required.

Paid customers retain their verified balance and subscription controls if the
plan catalog is temporarily unavailable. Usage explanations are collapsed, and
resource usage keeps the provider's actual units. The copy is available in all
nine dashboard locales. Both API and dashboard must be rebuilt and deployed for
these changes. See [production-path verification](openship-cloud-production-verification.md)
for test coverage and the remaining live payment/webhook verification.

## Compose on Docker workspaces, 2026-09-17

Oblien's live image catalog now includes `oblien/docker:29` (`id: docker`,
label: Docker + Compose). The entry advertises Docker Engine 29 running at boot,
Compose, Buildx/BuildKit, and persistent containers and volumes. Its current
`vm_defaults` are 2 vCPUs, 4096 MiB RAM, 32768 MiB disk, a Docker-capable kernel,
and a `docker-ready` readiness check. These are catalog defaults, not verified
minimum resource requirements. Openship now uses the published SDK 2.4.0.

New Compose and multi-application projects now use this model:

| Project | Execution |
| --- | --- |
| Compose stack | One permanent Docker workspace per project and environment; services run as containers within it |
| Single application | Native Cloud application workspace |
| Additional service on an explicitly single-application project | Native service workspace |
| Static site | Oblien Pages |

Keep the Compose workspace across application redeploys so its named volumes
survive container replacement. Production, staging, and previews use separate
workspace bindings, even when billed under the same customer namespace. Services
within one workspace share its resource capacity and failure boundary; container
limits still need to fit the workspace allocation.

Migration `0132_cloud_docker_workspace.sql` persists the project/namespace/VM
binding. Provisioning reserves an idempotency key before creating the VM and
records its ID before waiting for readiness. Retries reconnect to that disk;
they never replace a missing workspace with an empty one. The workspace becomes
permanent before customer containers or volumes are written. Allocations grow
when service limits and build headroom require it; applying a growth restarts
the VM, so the deploy restores previously running containers afterwards.

`CloudDockerRuntime` connects the existing Docker adapter through Oblien's
authenticated runtime proxy. Its bridge listens only on workspace loopback.
Builds, pulls and generated configuration files execute in that workspace.
Service controls, logs, monitoring, terminal and volume backup/restore address
Docker container IDs. The VM identity remains separate in deployment metadata.
Static sub-apps in a stack run as containers; independent static sites retain
Oblien Pages.

Only selected public endpoints and explicit composite-routing ports are
published on the host. Each receives a distinct, stable host port; private
services communicate over Docker DNS. An owned Page anchors each free or custom
hostname, and Oblien edge routes proxy to the VM's published port. Live routing
edits assemble the whole table before replacing it, including internal API paths
and multi-service path routing. Custom-domain ownership and multi-host routing
are covered internally; live TLS was tested with `preview.oblien.com`.

Named volumes, image-declared volumes and writable relative binds retain their
identity across redeploys. Rollback recreates containers from retained images
and frozen configuration. Retention removes containers/images, preserving the
shared workspace and data. Project teardown inventories routing Pages, including
disabled ones, and deletes the VM only after route cleanup succeeds. Monitoring
does not start a stopped VM; explicit Start or Deploy resumes it.

Existing native Cloud deployments keep `CloudComposeSupport` and their original
workspace IDs. They are not migrated implicitly. Moving a shared Docker project
to another billing organization or back to a self-hosted instance requires a
separate data migration; transfer fails before local records are deleted.

The live staging test used the newly supplied test credentials and an isolated
namespace with finite test credit and resource limits. All 31 checks passed:
provider idempotency, workspace permanence, authenticated Docker access, binary
command streams, two image builds, internal DNS, two public ports, logs/usage,
volume archive and restore, redeploy, image rollback, image retention, individual
service stop/start, whole-VM stop/start, and Page/workspace/namespace cleanup.
The disposable resources were deleted. This did not exercise a paid checkout.

Run from the repository root with a confirmed staging credential file:

```sh
bun packages/adapters/scripts/verify-cloud-docker.ts \
  --staging-env /path/to/staging.env \
  --public-domain preview.oblien.com
```

The script records a private resource manifest and check report, grants finite
credit only to its new namespace, and cleans up in `finally`. Its temporary VM
also has an expiry. It does not change account defaults or existing customers.

Sources: [live image API](https://oblien.com/docs/api/images),
[workspace creation](https://oblien.com/docs/api/workspaces), and the authenticated
`GET /workspace/images?search=docker` catalog response.

## Compose service additions, 2026-09-24

Adding an image service to a deployed Cloud Compose project uses that project's
recorded Docker workspace. Adding a service to a native single-application
project keeps the native service-workspace layout. Existing native projects are
not migrated by adding a service. Compose volume mounts require the Docker
layout; a native workspace's persistent root disk is not a Compose volume.

The direct Start path now verifies the recorded workspace binding and prepares
its allocation before creating the new container. Sizing includes sibling
container allocations, including disabled definitions with retained containers,
and does not substitute unapplied sibling CPU or memory edits for recorded
limits. Service quotas remain per service, regardless of the shared VM count.
Start refuses to grow a Compose workspace while a deployment is in flight.
Workspace growth can restart running siblings; ordinary service Start does not
rebuild the project or create a deployment session.

Failed runtime or inventory requests no longer authorize provisioning a missing
container. A stopped Docker workspace is distinguished from an unreachable one
so explicit Start can resume it. A failed initial workspace creation can be
retried through Oblien's `retryCreation` endpoint using the existing ID; this
does not re-create a previously ready workspace. Failed native updates also
retain reused workspaces and their disks.

The dashboard retains a service's saved configuration when startup fails and
opens its detail page for retry. Services without an image, and image services
with relative repository mounts, use the deployment path to prepare their
source. Named-volume image services can start directly in a Docker workspace.

Validation used the real service/repository code with provider mocks for
placement, sizing, quota refusal, failed provisioning and retry behavior, plus
the adapter and dashboard launch tests. The API, platform, adapter and dashboard
TypeScript checks were run. The live staging test passed all 31 checks at
09:43 UTC on `preview.oblien.com`, including two containers on one workspace,
private DNS, public HTTPS, persistent volumes, updates, rollback, and recovery.
Its namespace, workspace and Pages were deleted. The first run failed during
provider boot; the second run used the same image and resource configuration and
passed. The staging script now records provider provisioning details on future
failures. This run did not exercise customer checkout or deploy the API/dashboard
changes to production.

## Shared Docker execution audit, 2026-09-24

Cloud Compose uses the same Compose planner, Docker image builder, container
deployment, environment replacement, backup executor, and retention/rollback
implementation as self-hosted Docker. `CloudDockerRuntime` extends
`DockerRuntime`; its authenticated transport and command executor target the
project's bound Oblien workspace. Provider-specific code owns namespace access,
spending checks, workspace provisioning/resizing/recovery, source staging, and
public edge routes. An added Compose service is another container in that
workspace. It does not allocate another workspace.

The audit closed these gaps:

- Source preparation now follows the shared Compose service selection. Image-only
  deployments and retained-image restores do not clone a repository unless a
  selected service needs files for a relative mount.
- Inline catalog Dockerfiles and files are validated once and staged directly
  inside the workspace. They do not require API-host filesystem access.
- Uploaded source identity survives the common build-config factory for both the
  shared checkout and each service image. Uploads need no Git credential.
- Stopped containers retain their published port reservations through Docker's
  configured bindings, preventing new services from taking those endpoints.
- A bound Docker project rejects the native single-app execution mode instead
  of running a different lifecycle against its existing workspace and data.

The targeted API/adapter suites passed 347 tests. API, platform, and adapter
TypeScript checks passed. The extended live staging test passed 36 checks at
10:08 UTC, including inline builds with API-host source access disabled,
environment apply retaining the exact image and volumes, and redeploy of a
stopped service retaining both published ports. It also covered shared-network
DNS, binary/archive transfer, backup/restore, updates, rollback, HTTPS routing,
workspace recovery, and complete cleanup of its disposable namespace, workspace,
and route Pages. These checks exercise the deployment lifecycle; they do not
certify customer checkout or publish the local changes.

## Newly supplied staging key, 2026-09-17

- Default-created namespaces inherit enough capacity for Docker: the provider
  reports per-workspace limits of 32 CPUs, 65536 MiB RAM and 256000 MiB disk.
  The earlier namespace-count and 10 GB disk blockers do not apply to this key.
- New-namespace defaults are now `quotaLimit=0`, `overdraft=0`,
  `suspendThreshold=0`, `autoApply=true`, and `stop_workspaces`. This change affects
  onboarding; existing customer policies and usage were not reset.
- After the provider fixes, both `namespaces.create` and `namespaces.ensure`
  immediately inherit zero-credit policies. Unpaid namespaces return their own
  free/null subscription state and billing period, rather than the account
  owner's plan. Repeating ensure preserves an existing fixture's allowance.
  Openship retains its subscription/entitlement consistency checks.
- Live tests confirm VM/Page isolation, concurrent workspace-cap enforcement,
  CPU/RAM/disk resize ceilings, and actual HTTP 409 limit responses. Docker CPU
  and memory usage now debit namespace credits. Subsequent usage exhausted a
  positive fixture balance and stopped its VM automatically while the other
  customer's VM kept running. Inspection and repeated Stop worked during
  billing suspension. Restoring credit required an explicit Start of the same VM.
- Manual namespace suspension now stops the Docker VM, including after billing
  restoration and an explicit restart. The final 04:31 UTC test passed both
  manual suspensions. Credit increases do not override manual suspension;
  explicit namespace activation and VM Start are required. Scoped Stop and
  Delete work under both suspension types. Earlier failed observations are
  retained as history in the provider report.
- The key cannot register `opsh.io` routes (`403 domain_not_allowed`, rechecked
  at 04:29 UTC). Slug availability returns true but does not establish permission
  to publish. Give the intended account domain access. Preview-domain HTTPS
  works and passed all 31 Docker checks again with SDK 2.3.2 at 03:51 UTC.
- No public staging API origin exists yet. Signed callback handling is tested
  internally. After the API is deployed, use its public HTTPS origin for webhook
  registration and verify a real test-payment delivery before enabling purchases.

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

That September 15 check created no namespace, token, checkout, workspace, or
payment. Its only configuration write set the staging account's default policy for new
namespaces; existing namespace usage and paid allowances were not reset.
Configure a separate verified production account before launch rather than
assuming the `.env.saas` filename indicates production provider credentials.

## Provider configuration

1. Use confirmed staging credentials for integration tests. The updated
   endpoints accept the earlier staging key and return the documented responses. Confirm Stripe
   checkout is in test mode before completing a test payment. Confirm the
   production account's identity and `max_namespaces` capacity before launch.
2. Configure zero-credit **new-namespace defaults** in the intended Oblien account.
   This was configured for both staging accounts. The September 17 key now
   passes actual create/ensure inheritance checks after the provider fix.
   Verify actual creation in the intended launch account, not only the template.
   The initial policy is payment before compute: zero quota and zero overdraft.
   Openship rejects nonzero or unlimited automatic credit defaults. Example
   `PUT /billing/defaults` body:

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
   # Optional when the deployed runtime API origin is already correct:
   # OBLIEN_WEBHOOK_URL=https://<deployed-api>/api/billing/oblien-webhook
   BILLING_ENABLED=false
   BILLING_TOPUPS_ENABLED=false
   ```

   Use staging origins/credentials for staging. Set `OPENSHIP_CLOUD_API_URL` and
   `OPENSHIP_CLOUD_DASHBOARD_URL` to the actual staging origins so checkout
   returns and the marketing catalog point to staging. The callback defaults to
   the selected runtime's API origin plus `/api/billing/oblien-webhook`; it does
   not require a separate webhook host. If a reverse proxy serves
   the API under a prefix, supply that full path in `OBLIEN_WEBHOOK_URL`.
   Have the Oblien operator add the dashboard return host to
   `REDIRECT_ALLOWED_HOSTS`; unlisted supplied hosts return
   `400 billing_redirect_not_allowed`. Verify the actual checkout and portal return destinations.
4. Start the updated API and confirm webhook registration succeeds. The hook
   must be active, signed, account-wide, and include every event exported by
   `oblien-webhook-config.ts`. Confirm real signed delivery reaches the handler;
   registration alone does not prove that routing or the secret is correct.

### Enable purchases in the deployed SaaS

Set these in the **API process's runtime environment** when launching purchases:

```dotenv
BILLING_ENABLED=true
BILLING_TOPUPS_ENABLED=true
```

The first enables subscription checkout. Top-ups require both flags. These are
global SaaS settings; there is no per-organization billing activation switch.
Billing state and usage remain readable when purchases are disabled, as do
existing subscription management actions.

Both Compose stacks read the repository's root `.env`. The
`apps/api/.env.saas` file is loaded by `dev:saas`; copying credentials there does
not configure a deployed container. The normal API `start` command loads `.env`
in its working directory. Deployment platforms should supply the flags and
`OBLIEN_CLIENT_ID`, `OBLIEN_CLIENT_SECRET`, and `OBLIEN_WEBHOOK_SECRET` directly to
the API service. Use the production Oblien account for production. No Openship
Stripe keys or price IDs are required for this flow.

For the root SaaS Compose stack, apply changed environment values with:

```sh
docker compose up -d --no-deps --force-recreate api
```

A plain `docker compose restart` retains the container's old environment. On a
deployment platform, redeploy the API service after saving its environment.
When Openship manages the deployment, open the API service's **Environment** tab,
save the variables, and choose **Apply environment changes**. This refreshes the
selected API service using the running image's immutable ID, without pulling its
local build tag or creating a deployment/build session. Progress and completion stay
in Environment. The service action retains its ports, volumes and resource limits
and stops the original gracefully. A restart blocked by pending variables
opens the service's **Environment** panel. To ship code changes as well, deploy the
new source.
When `NODE_ENV=production`, `CLOUD_MODE=true`, and `BILLING_ENABLED=true`, the
API refuses to start if provider credentials or the webhook signing secret are
missing, or if the callback cannot resolve to HTTPS. The error names the missing
variables without printing their values. Disabled purchases and development
mode retain their existing startup behavior.

After deploying, run the read-only check **inside the running API container** so
it uses the actual deployed environment:

```sh
docker compose exec api bun run --cwd apps/api cloud:check
```

This verifies private provider access, the catalog, namespace policy, and webhook
registration. When Oblien returns a masked secret, comparison is explicitly
marked as skipped; confirm a real signed delivery reaches the API. If an
unmasked secret is returned, a mismatch fails the check.
On a fresh provider account, customer checks are explicitly marked as skipped
until a namespace exists; re-run after the first customer opens Billing.

Older dashboards display “Billing is not enabled for this organization” for any
failed `GET /api/billing/state`, including authentication, missing credentials,
provider errors, and timeouts. That message does **not** prove that a flag is
off. Current dashboards distinguish those failures and log a safe HTTP status
and error code under `[billing] GET /billing/state failed` in dashboard logs.
Use the deployed API logs for the underlying error:

| Response/code | Action |
| --- | --- |
| `BILLING_NOT_CONFIGURED` | Supply the Oblien credentials to the API process. |
| `OBLIEN_DEFAULT_POLICY_REQUIRED` | Configure the production account's automatic zero-credit, zero-overdraft namespace policy described above. |
| `OBLIEN_WEBHOOK_NOT_CONFIGURED` | Configure the signing secret and deployed callback. |
| `OBLIEN_CHECKOUT_UNAVAILABLE` | Inspect `[oblien:billing] Provider request failed` in the API logs for the upstream operation, status, and error code. `ER_CANT_AGGREGATE_NCOLLATIONS` requires an Oblien database/query fix. |
| HTTP 401 / 403 without `BILLING_NOT_ENABLED` | Check the session and the user's `billing:read` permission. |
| HTTP 404, 5xx, or a connection failure | Check API routing, `INTERNAL_API_URL`, provider connectivity, and the API logs. |

An authenticated `GET /api/billing/state` should return HTTP 200 with
`data.billing.enabled: true` after activation. A public plans response confirms
catalog reachability only; it cannot verify private provider credentials.
The billing layout and tab share one request-scoped snapshot, with a 45-second
timeout to allow the API's bounded namespace/provider reads to finish.

From `apps/api`, run the read-only checker against the intended environment:

```sh
node --env-file=.env.saas --import tsx scripts/cloud-readiness.ts
```

It also verifies that the namespace's subscription and entitlement agree, and
that a consumer namespace has finite credit. It exits nonzero for failed checks,
including disabled purchase flags. Those
flags should remain disabled in production until the remaining release gates
are satisfied. Enable them in staging when deliberately testing checkout.

## Existing installations

- Back up the database and apply `0127_organization_oblien_namespace.sql` using
  the normal migration runner. Duplicate namespace bindings must be resolved
  explicitly; the migration intentionally refuses to silently merge customers.
- Apply the normal migration sequence through `0132_cloud_docker_workspace.sql`
  before starting API/worker code that deploys Compose on Cloud.
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
  pending checkouts. Reseller status is read through
  `GET /billing/checkout/:checkoutId?namespace=...`; Openship exposes the safe
  subset at `GET /api/billing/checkout?checkoutId=...`. Do not infer payment from
  a checkout redirect.

The native-workspace adapter still refuses named/shared/bind volume declarations;
replacing a native workspace does not transfer its disk. New Compose projects
accept these declarations through their persistent Docker workspace. Existing
native projects require an explicit data migration to adopt that model.

## Staging acceptance

1. Create two organizations. Verify distinct namespace bindings and finite
   onboarding policies. With zero onboarding credit, a build must be refused.
2. Buy a Pro monthly plan for A through the UI. Verify the namespace in the
   provider checkout, the charged catalog amount, the signed payment event,
   entitlement synchronization, and the dashboard's refreshed plan/balance.
   Annual checkout stays hidden until an explicit price and annual allowance
   are published; verify that unpublished intervals are refused.
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
10. Verify a paid renewal resets usage once and retains the purchased price,
    credit grant, resource caps and configured grace. Change the catalog and
    redeliver the old invoice: neither should rewrite that saved contract. Test
    a partial refund, full refund and dispute, including an old-cycle refund
    after a new cycle and cross-customer checkout-status reads.
11. Only after these checks pass, enable the production purchase flags, rerun
    `cloud-readiness.ts`, and monitor webhook failures and reconciliation errors.

Provider references: [index](https://oblien.com/llms.txt),
[billing](https://oblien.com/docs/api/billing),
[namespaces](https://oblien.com/docs/api/namespaces),
[Pages](https://oblien.com/docs/api/pages),
[scoped tokens](https://oblien.com/docs/api/scoped-tokens).
