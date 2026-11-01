# Cloud product analytics

Openship can send a small, typed set of product events to PostHog from the hosted
Cloud API. Desktop, self-hosted, development and test instances stay disabled,
including installations connected to Cloud. Local project operations never enter
this pipeline. Operations actually performed by the Cloud API, including purchases
made through a connected client, are Cloud activity.

## Enable on the Cloud API

Use a production PostHog project and set these **only on the hosted API**:

```dotenv
CLOUD_MODE=true
NODE_ENV=production
POSTHOG_ENABLED=true
POSTHOG_PROJECT_KEY=phc_your_project_token
POSTHOG_HOST=https://us.i.posthog.com
POSTHOG_EXCLUDED_ORGANIZATION_IDS=org_internal,org_demo
POSTHOG_EXCLUDED_USER_IDS=user_internal
```

Use `https://eu.i.posthog.com` for an EU project. The key is the project token, not
a personal API key. Keep the normal production `OPENSHIP_TARGET` configuration;
the browser collector accepts only that runtime target's HTTPS dashboard origin.
An invalid/missing token, unsupported ingestion host, or non-production target
leaves analytics disabled. No dashboard build variables or PostHog browser script
are needed. The API never exposes the project token to the browser.

Migrations create the outbox, checkout correlation and workspace snapshot tables.
Restart the API after configuring it. `GET /api/health/env` advertises
`cloudAnalytics.dashboardOrigin` only when enabled. The built-in
`cloud-analytics:deliver` job sends batches and reconciles checkouts once a minute.
Inspect its recent runs through the existing Jobs surface. Expect up to a minute
of delivery delay; provider/ingestion failures use bounded retries.

Exclude internal/demo **organizations** to exclude their background deployments,
subscription snapshots and payment webhooks as well as browser events. User
exclusions additionally suppress attributed activity. The dashboard's cosmetic
Demo mode pauses browser telemetry; it does not turn real purchases into test
payments. Development never sends to this production integration. Test the capture
contract with the automated local receiver, or a separately configured production
preview with its own PostHog project, never with the production token.

## Data boundary and identity

- Browser events go to the first-party `/api/cloud/telemetry` endpoint. The
  existing `/api/cloud/analytics` relay continues to serve customer traffic data. Only
  enumerated screen names, checkout interactions, bounded campaign labels and
  referrer hostnames are accepted. No full URL, query string, document title,
  DOM text, IP, repository name, service environment, log, token or terminal data
  is forwarded. There is no autocapture, session replay or exception autocapture.
- A browser UUID connects a visit to its subsequent authenticated session through
  PostHog `$identify`. Logout/account changes rotate it. The server resolves the
  user and active organization from the cookie session and current membership;
  mismatched/stale identities are dropped. Client-supplied business events and
  arbitrary properties are rejected.
- `distinct_id` is the internal user ID when known. Unattributed background work
  uses `workspace:<organizationId>` with person-profile processing disabled.
  Events carry `workspace_id` and `$groups.workspace`. Use workspaces as the unit
  for customer/revenue reporting, not individual team members.
- Deployment outcomes recover the initiating user from the queued deployment's
  analytics receipt. Checkout outcomes recover the initiating payer from the
  saved checkout record. Older checkouts without that receipt remain attributed
  to their verified workspace; the code does not guess a payer.
- Only PostHog's project token is used for ingestion. Creating dashboards through
  PostHog's management API would require separate account access; deployment of
  this code does not automatically create a dashboard in that account.

## Event catalog

The authoritative property schemas live in
`packages/contracts/src/cloud-analytics.ts`. Every event also carries `product =
openship_cloud`, `environment = production`, its source and available workspace.

| Events                                                                         | Meaning                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud_page_viewed`                                                            | Cloud screens, with safe `utm_source`, `utm_medium`, `utm_campaign`, `referrer_host` when present. Topology and backups have their own screen IDs.                              |
| `cloud_signup_completed`                                                       | A new account was provisioned successfully. Email verification is a subsequent step.                                                                                            |
| `cloud_github_connected`                                                       | GitHub App installation verified/claimed, or an enabled personal token saved after validation. `method` distinguishes them.                                                     |
| `cloud_project_created`                                                        | A new project was created, including shared API/SDK paths. Repeated ensure calls do not count as new projects.                                                                  |
| `cloud_deployment_started`                                                     | A deployment was durably queued, including webhook-triggered releases.                                                                                                          |
| `cloud_deployment_succeeded`, `cloud_deployment_failed`                        | Final lifecycle outcomes, deduplicated by deployment and outcome. No logs/errors are sent.                                                                                      |
| `cloud_first_deployment_succeeded`                                             | The workspace's first successful deployment **observed after analytics was enabled**. No historical activity is backfilled.                                                     |
| `cloud_backup_policy_created`, `cloud_backup_completed`, `cloud_backup_failed` | Policy adoption and actual backup outcomes.                                                                                                                                     |
| `cloud_scaling_configured`                                                     | Cluster target or replica configuration changed. This is configuration adoption, not proof of a subsequent healthy scale-out.                                                   |
| `cloud_mcp_tool_called`                                                        | One dispatched tool call, including reads/failures. Tool name, HTTP status and success only; never arguments or credentials.                                                    |
| `cloud_checkout_clicked`                                                       | A hosted dashboard purchase interaction, with `kind` and `surface`.                                                                                                             |
| `cloud_checkout_started`                                                       | Oblien created a hosted checkout. Includes the offered amount, plan/interval when applicable, and an opaque checkout ID. **Not revenue.**                                       |
| `cloud_checkout_returned`                                                      | Browser returned through the success/cancel URL. **Not payment confirmation or subscription cancellation.**                                                                     |
| `cloud_checkout_completed`                                                     | Oblien reports complete, paid, fulfilled and unreversed. One event per checkout, whether found by polling or reconciliation. **Do not sum it as revenue.**                      |
| `cloud_checkout_expired`, `cloud_checkout_failed`, `cloud_checkout_reversed`   | Verified expiration, fulfillment failure or refund/dispute status. A reversed checkout has no guessed refund amount.                                                            |
| `cloud_payment_succeeded`                                                      | Signed, tenant-resolved Oblien payment receipt with a stable payment ID and verified amount in cents. Includes subscriptions and top-ups.                                       |
| `cloud_subscription_renewed`                                                   | A signed renewal receipt. Shares payment correlation with `cloud_payment_succeeded`; **do not add its value to revenue again.**                                                 |
| `cloud_subscription_changed`                                                   | A changed, verified subscription snapshot: plan, interval, paid/complimentary source, status, scheduled cancellation and MRR. One revision per real state change, not per poll. |
| `cloud_operation_failed`                                                       | A checkout/deployment/GitHub API error. Only a fixed operation/category and status; no raw error text or request data.                                                          |

## Payment accuracy

Oblien remains the only billing authority. No access, credits, subscription or
checkout request behavior depends on PostHog. Analytics never contacts PostHog
inside a payment, deployment or signup request. Those paths enqueue locally;
delivery failures cannot change their results. Failed local telemetry writes are
logged and contained as well, but events that never reach durable storage cannot
be guaranteed. This is product analytics, not a replacement accounting ledger.

The outbox uses database uniqueness, worker leases and stable PostHog UUIDs,
insert IDs and timestamps. A response lost after ingestion can be retried with
the same event identity. Financial/milestone receipts remain locally deduplicated
after delivery. Delivered routine activity (including browser, MCP and error events) is pruned after 30 days; undelivered
events remain retryable. Telemetry tables are excluded from project/instance
migration exports.

Checkout creation saves its original payer. A scheduled worker checks at most 20
due checkouts per minute, four concurrently, including cases where the browser
never returned. Unresolved checkouts are revisited for up to seven days. A signed
provider event schedules another check even for an older/finalized checkout.
PostHog delivery is limited to two batches of 100 events per scheduled tick.

Only `cloud_payment_succeeded` is a cash-receipt event. Payment/renewal webhook
retries use the **payment ID**, not the delivery ID, so two event types cannot
double-count the same charge. Checkout polling supplies verified conversion and
fulfillment status; it does not manufacture a second revenue event. Missing
provider payment webhooks can therefore leave cash-receipt reporting incomplete
even when checkout conversion is visible. Reconcile revenue with Oblien's ledger.

Top-ups are one-time credit purchases, not MRR. Complimentary plans and trials
are not paying workspaces. Active subscriptions scheduled to cancel still count
until cancellation takes effect. Past-due/unpaid/paused/canceled subscriptions
contribute zero to the conservative active MRR measure. Annual MRR is the saved
contract price divided by 12. Legacy subscriptions without a verified saved price
report `mrr_cents = null`, rather than using today's catalog as a guess.

Refund/dispute statuses are observable through checkout lookup; that contract
does not provide a verified monetary refund ledger. Do not treat the original
checkout amount as the refunded amount or present gross receipts as net revenue.

## Launch dashboard

Create an **Openship Cloud launch** dashboard in PostHog with these reports:

1. **Acquisition:** unique visitors to `cloud_page_viewed`, broken down by UTM
   source/campaign and referrer host. This starts at entry to Cloud. Visits that
   remain entirely on the marketing site are outside this integration.
2. **Signup:** `cloud_page_viewed` filtered to `screen = signup` →
   `cloud_signup_completed`, with a seven-day conversion window. The identity
   event joins anonymous visits to registered users.
3. **Activation:** `cloud_project_created` → `cloud_deployment_started` →
   `cloud_deployment_succeeded`, grouped by workspace for collaboration. Also
   chart `cloud_first_deployment_succeeded` for newly observed activation.
4. **Checkout:** clicked → started → completed, broken down by kind, plan and
   interval. Treat the offered amount on started as intent only. View expired,
   failed and reversed checkouts separately; closing a tab alone is not failure.
5. **Receipts:** sum `cloud_payment_succeeded.amount_cents / 100`, split by
   `kind = subscription` versus `kind = topup`. Never add completed/renewed
   events to this total.
6. **Paying workspaces and MRR:** use the latest subscription revision per
   workspace, not a count/sum of all subscription events or all members.
7. **Adoption/retention:** weekly unique workspaces deploying, completing backups,
   configuring scaling, invoking MCP, and viewing `project_topology`. Pair outcome
   trends with `cloud_operation_failed` categories for onboarding friction.

On a PostHog plan without group funnels, use `workspace_id` in SQL reports rather
than treating synthetic workspace actors as additional human users.

Gross receipts query (choose the dashboard's date range as appropriate):

```sql
SELECT properties.kind AS kind,
       sum(toFloat(properties.amount_cents)) / 100 AS gross_receipts_usd
FROM events
WHERE event = 'cloud_payment_succeeded'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY kind
```

Current subscription rows for customer/MRR reports (retain the whole state row so
an unknown/null price cannot accidentally reuse an older known price):

```sql
SELECT workspace_id, plan, paying, mrr_cents, cancel_at_period_end
FROM (
  SELECT properties.workspace_id AS workspace_id,
         properties.plan AS plan,
         properties.paying AS paying,
         properties.mrr_cents AS mrr_cents,
         properties.cancel_at_period_end AS cancel_at_period_end,
         row_number() OVER (
           PARTITION BY properties.workspace_id
           ORDER BY toInt(properties.revision) DESC
         ) AS revision_rank
  FROM events
  WHERE event = 'cloud_subscription_changed'
)
WHERE revision_rank = 1
```

Do not apply a short event-date filter to the current-state query: an unchanged
active subscription can legitimately have an older last revision. Sum known MRR
and show the number of paying workspaces with unknown MRR alongside it. Keep
PostHog retention long enough for the intended reporting period; these events
are not backfilled automatically after a PostHog project reset.

## Validation

`apps/api/test/modules/cloud-analytics` exercises real SQL tables, the browser
collector and an HTTP capture receiver: authentication/tenant isolation, malformed
or oversized input, retries/restarts, duplicate receipts, payer correlation,
subscription transitions and pruning. Browser tests cover local/desktop/demo
gates, logout/account changes, URL sanitization and non-blocking transport failure.
Existing billing, GitHub, deployment/SDK and migration tests cover the touched
application boundaries. No real payment or production analytics event is needed
to run these tests.
