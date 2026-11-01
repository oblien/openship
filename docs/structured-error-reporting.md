# Structured error reporting

Openship-owned failures go through `ErrorReporter` in
[`packages/core/src/diagnostics`](../packages/core/src/diagnostics). The same implementation is used
across the API, platform and dashboard, with automatic collection enabled only for Cloud SaaS.
Self-hosted instances, Desktop, the native worker and CLI leave collection disabled. Reporting observes
operations; it does not retry deployments, choose a destination, change authorization or replace their
existing return values and user messages.

The shared singleton starts disabled. The SaaS API enables it from `CLOUD_MODE` after database and
instance configuration bootstrap, then installs its database destination. The SaaS dashboard enables
browser collection only when the API serving it positively reports Cloud mode. Unknown mode fails
closed. Signing into Cloud, changing organizations, or connecting Desktop to a remote instance does
not enable collection on a local installation. There is no diagnostics vendor SDK or extra Redis queue.

Disabled `reportError()` and `reportCaughtError()` calls do not inspect the error, enqueue events or
invoke a configured destination. Explicit `diagnostics.warn()` / `diagnostics.error()` calls and fatal
process errors still produce redacted local output, so operational failures remain diagnosable. The
website and standalone dashboard server do not install an upload destination.

This is operational diagnostics, separate from the existing security audit log, deployment output and
Cloud product analytics. Customer applications' own stdout, stderr and exceptions remain their service
logs. OpenResty, Docker, SSH, database engines and the separately deployed webmail application retain
their own internal logs; errors that reach an Openship control-plane adapter are observed here.

## Cloud database destination

[`apps/api/src/lib/cloud-error-destination.ts`](../apps/api/src/lib/cloud-error-destination.ts) owns
both table creation and the single batched insert. SaaS startup creates `cloud_error_event` in the
existing API database with `CREATE TABLE IF NOT EXISTS`; this is deliberately not a shared ORM schema
migration. Non-Cloud installations do not create the table or mount the browser intake. No new
environment variable or separate database is required.

| Column | Content |
| --- | --- |
| `event_id` | Server-generated observation ID and primary key. Replayed batches use `ON CONFLICT DO NOTHING`. |
| `occurred_at` | The reporter's timestamp. |
| `received_at` | Database receipt time; used for retention. |
| `event` | The full sanitized JSON event, including classification, error/cause and allowed context. |

Indexes support receipt-time, request-reference and organization lookups. There are no user or project
foreign keys: pre-authentication and system failures need no existing resource. There is no log-reading
HTTP endpoint. Access is through the Cloud database's existing operator permissions, for example:

```sql
SELECT occurred_at, event
FROM cloud_error_event
WHERE event #>> '{context,requestId}' = 'request-reference'
ORDER BY received_at DESC;
```

The destination reuses the existing bounded reporter queue and writes one parameterized insert per
batch. Setup and inserts use transaction-local lock/statement deadlines of 250/500 ms. PostgreSQL
replicas serialize table setup with a transaction advisory lock. Cancellation is checked again after
waiting for a connection; an abandoned batch is rolled back. Invalid Unicode from truncated text is
normalized for PostgreSQL JSON storage without rereading the original error.

Successful batches also retain the existing local JSON output. Setup failure leaves the API running
with local output; insert failures use the reporter's bounded local fallback, without recursively
logging the database query or retrying the request. After the existing exporter failure threshold,
local fallback remains in use until the destination is reinstalled or the process restarts.

Retention targets 30 days by receipt time. Pruning runs with incoming batches, at most once per hour
when caught up, and deletes at most 1,000 expired rows per batch. A backlog is drained by subsequent
batches. Idle or unavailable destinations can retain expired rows longer; this is bounded maintenance,
not an exact deletion deadline. It touches only this Cloud diagnostics table.

## Event contract

Each event has `schemaVersion: 1`, a timestamp, an `eventId`, an `errorId`, a severity, a category,
`error` and `context`. The error contains its name, redacted message, optional code and stack, and bounded
causes or aggregate errors. A returned HTTP error without an exception has no invented stack trace.

Context is an allowlist: request/parent/trace identifiers, source, operation/component, HTTP method and
registered route, status, duration, authorized user/organization/resource identifiers, deployment/job/run
identifiers and safe provider failure metadata. It never serializes an execution context or request.

`component` identifies the code module that observed the failure; it is separate from the request's
route. The request boundary supplies HTTP context automatically, and the browser supplies its current
page path. Browser delivery preserves the bounded module label as untrusted metadata; it cannot assert
an authenticated identity or replace the API's own request identifier.

`eventId` identifies one observation. The same Error object keeps its `errorId` across boundaries;
repeated observations at the same boundary/request are suppressed. Reused provider Error objects can
span requests, so use request/operation identifiers when counting incidents. Identifiers are log fields,
not metric labels. Browser `eventId` becomes `context.clientEventId` and never controls the server's IDs.

Categories include authentication, authorization, validation, not found, conflict, rate limit, capacity,
billing, network, timeout, cancellation, deployment, storage, database, dependency and internal failure.
Structured status/code/cause take precedence over generic labels. Known Docker disk-exhaustion messages
also classify as storage failures when Docker supplies no error code. Categories and severity can be
overridden explicitly by a trusted operation. Cancellation is informational; recovered catches are
warnings, with common expected filesystem/abort outcomes informational.

## Boundaries and correlation

These are the shared observation hooks; automatic capture runs only where the owning Cloud process
or browser has enabled the reporter. Local return values, response references and operational logs
remain available with collection disabled.

| Boundary | Coverage and behavior |
| --- | --- |
| HTTP | The first Hono middleware generates `X-Request-ID` before auth, validation, rate limits or routing. Thrown errors and explicit 4xx/5xx responses are observed, including unmatched routes. Early guards retain the intended registered route. |
| Authentication and permissions | Identity is added only from the established execution context and authorized resource scope. Input headers and body fields cannot set diagnostic identity. |
| Shared platform | All operation families are wrapped at `createPlatform`. HTTP, MCP and native SDK use that same boundary. Synchronous results, rejections and asynchronous stream iteration retain their semantics. |
| Deployments | The asynchronous worker carries request/project/deployment/server/organization context. The canonical failure lifecycle records failed outcomes, including failures expressed as strings rather than thrown exceptions. |
| Jobs and backups | Both BullMQ and in-process runners establish a fresh job context. Attempts, job/run IDs and resolved organization are carried into errors. Failed command exits are observed, not just thrown exceptions. |
| Background work | Tracked work, scheduled operations, rejections, recovery catches and `allSettled` results are observed. A cron tick does not inherit a previous request's tenant. |
| SSE and WebSocket | Observers retain the original request context after the HTTP response opens. Streamed failed results, promised SSE data, write failures and WebSocket hook errors are covered without changing frame order. |
| Dashboard | Fetch/auth failures, handled error messages, toasts, React error boundaries and global browser exceptions/rejections use the reporter. API errors keep the server's response reference. |
| Dashboard proxy | Failed upstream connections get a response reference. Requests forward a generated parent reference and preserve the upstream API's own reference when supplied. |
| Desktop | Capture and upload are disabled, including while connected to Cloud. IPC results and rejections are unchanged; fatal and intentional operational logs remain local. |
| Native worker and CLI | Capture and upload are disabled by default. CLI human messages, JSON stdout and intentional local logs retain their output contract. Native `diagnostics: "silent"` still honors the caller's choice. |
| Onboarding | Rejected settings pushes and terminal readiness failures are observed without recording passwords or tunnel tokens. A successful readiness poll does not report its earlier expected connection refusals. |
| Public support | The website support adapter records returned and thrown failures, returns a request reference, and forwards it to the Cloud API. It never logs the support form or receipt. |

`AsyncLocalStorage` holds only identifiers and other allowed primitives. Parallel requests and workers
get separate frames; an authorized scope change does not change process-global identity. Incoming
request IDs must be UUIDs and are recorded only as `parentRequestId`, never accepted as the API's own ID.
References forwarded between instances provide a chain; this is not a full OpenTelemetry span exporter.

The pre-runtime CLI Node recovery launcher is an explicit exception. It must work without a supported
Node version or installed workspace dependencies, so it retains its built-in-only stderr reporting.
After it starts the actual CLI, the shared reporter is installed. Importing the reporter into this early
launcher would break the mechanism that repairs unsupported installations.

## Bounded delivery

When enabled, `capture()` sanitizes a bounded snapshot and enqueues it. Disabling capture clears the
queue, cancels an active exporter and prevents queued events from being replayed on re-enable. It never awaits a network request, database,
file write or logging destination. Normal requests must not call `flush()`.

| Bound | Default |
| --- | --- |
| Buffered events | 256 |
| Approximate serialized buffer budget | 1 MiB, plus one active batch and object overhead |
| Individual event budget | Approximately 16 KiB |
| Batch size / interval | 16 events / 100 ms |
| Exporter calls in flight | One |
| Delivery deadline | 2 seconds |
| Returned JSON error inspection | At most 16 readers, 4 KiB and 250 ms each; detached from the response |

The consumer respects stderr write backpressure. A full buffer drops new events before expensive
inspection and emits `DIAGNOSTICS_OVERFLOW` with the drop count. A failed exporter writes the sanitized
batch and `DIAGNOSTICS_DELIVERY_FAILED` to the local fallback. After three failures, or one timeout,
delivery switches to that fallback. An exporter ignoring cancellation cannot accumulate a new hung
request for every batch. An incorrectly asynchronous fallback is replaced after its first call.
The local fallback also checks stderr backpressure; it cannot grow Node's output buffer indefinitely
when the pipe is stalled. Events lost there are counted and reported as `DIAGNOSTICS_OUTPUT_DROPPED`
when a later event can be written after recovery.

There are no delivery retries inside application operations. An uncertain exporter can finish after a
timeout, so a collector should deduplicate by `eventId`. `stats()` exposes queue depth/bytes, successful
primary delivery count, dropped events and delivery failures. No success log is generated for each
ordinary request.

API shutdown drains the bounded response readers and reporter before closing the database, then
uses local output for the remaining teardown. CLI and native-worker orderly shutdown
also have bounded flushes. Fatal Node exceptions use the same redaction in a direct local emergency
write and exit nonzero; they do not wait for an exporter or continue a potentially corrupt process.
Explicit Node exits also make a bounded last-chance local write of queued and uncertain in-flight events,
so a CLI refusal using `process.exit()` does not discard its error before the first batch timer fires.
Forced Electron termination, browser closure, SIGKILL, OOM, power loss and broken local output can still lose
buffered events. This system deliberately does not promise durable or exactly-once delivery.

Zero overhead is not possible. A local Node 22.21.1 microbenchmark on 2026-10-09 measured 18–21 µs per
captured Error with context/stack, and about 15–16 µs additional time for a successful in-process Hono
request. Five samples used 2,048 errors and 2,500 HTTP requests respectively. These are local measurements,
not production latency guarantees. A synchronous burst of 10,000 events took about 3.2 ms, retaining 256
and explicitly accounting for the remaining 9,744 as dropped; it did not grow the queue indefinitely.

## Redaction and trust

Only allowlisted error/context properties are read. Bodies, cookies, headers, environment, IPC
arguments, commands, SDK configuration and arbitrary attached objects are excluded. Text is bounded
before filtering. Filters remove recognizable credentials, authorization values, private keys,
credential-bearing URLs, query strings, invitation/reset tokens, email addresses, SQL/query payloads,
environment assignments and sensitive command flags. A credential disguised as an error code is omitted.
Better Auth's internal logger uses this same serializer, including WebAuthn challenge redaction.
Provider-specific redaction remains ahead of reporting: notification webhook URLs, Telegram tokens,
ACME enrollment keys and GitHub credential verification keep their existing sanitized error boundary.
The reporter does not bypass that boundary to recover a more detailed raw error.
Custom message/stack getters and `toJSON` are not invoked; V8's captured intrinsic stack getter is allowed.

Redaction cannot identify an arbitrary secret embedded in otherwise ordinary prose. Do not construct
errors or summaries from raw configuration, process output, form contents or provider responses. Prefer
a stable error code and pass the original Error so the safe serializer can retain its stack/cause.
As with any JavaScript inspection, hostile Proxy traps are not a sandbox boundary.

The Cloud-only browser intake is public so failures before sign-in are observable. It accepts at most eight events
per request, a 64 KiB body and 20 batches per minute per IP; failures of its rate-limit backend reject
intake rather than bypassing the limit. No tenant, user, severity or server timestamp can be asserted.
The server marks accepted events `untrusted`, sanitizes them again, and returns only `204`. There is no
log-reading API. Browser reports must not be used as proof of payment, authorization or security events.

During a Desktop remote-instance switch, browser collection remains disabled and the diagnostic
endpoint returns 404 locally without forwarding to the remote instance. The remote Cloud API can still
record its own authoritative request failures, linked through parent request references where applicable.

## Extending destinations and adding boundaries

Import browser-safe code from `@repo/core/diagnostics`. Only server entry points import
`@repo/core/diagnostics/node`; importing a library does not install fatal process handlers.

```ts
import { errorReporter, reportError, type ErrorSink } from "@repo/core/diagnostics";

// The Cloud-owned entry point enables collection; replacing the sink never opts in.
// installCloudErrorDestination() already does this for the SaaS API.
function configureErrors(exporter: ErrorSink) {
  if (!errorReporter.isEnabled()) return;
  errorReporter.setSink(exporter);
}

// A destination receives sanitized snapshots, not raw Error/request objects.
const exporter: ErrorSink = async (events, signal) => {
  const response = await fetch("https://logs.example.com/errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
    signal,
    redirect: "error",
  });
  if (!response.ok) throw new Error("Error exporter unavailable");
};

configureErrors(exporter);

try {
  await performOperation();
} catch (error) {
  reportError(error, { component: "my-module", operation: "my-operation", handled: true });
  throw error;
}
```

An exporter must honor its abort signal and avoid synchronous blocking work. Exporter credentials belong
in operator configuration, never event context. Install an exporter in each owning process; workers and
browsers do not share memory. No new environment variable currently enables a remote exporter.

Use `withErrorContext()` at new request/operation boundaries, `observeBackground()` for fresh jobs,
`reportCaughtError()` for recovered exceptions, and `observedAllSettled()` when intentionally collecting
multiple rejected tasks. Prefer one final outcome observation and shared boundaries over ad hoc reports
in every caller. An expected parse/probe/cancellation fallback can be documented with
`diagnostics-ignore: <specific reason>` when emitting an event would misrepresent a successful operation.

## Coverage audit and verification

The source audit covers the API, dashboard, Desktop, CLI, website, core, platform, adapters, databases,
onboarding, contracts and shared UI. On 2026-10-09 it accounts for over 4,200 catch, rejection-handler,
error-event and console-error boundaries. The HTTP source catalog contains 728 unique method/path pairs
across Cloud/local variants. The complete mounted application is also boot-tested in both modes, with
an assertion that the observer is the first middleware.

```sh
bun run errors:check
node scripts/audit-error-boundaries.mjs --json > error-boundaries.json
node scripts/audit-error-boundaries.mjs --routes > error-routes.json
```

The first JSON output identifies each file, line, boundary kind and disposition. The second inventories
each route, module, source and shared HTTP boundary, using the existing API documentation parser rather
than maintaining another route list. CI and the release gate reject newly silent catches and raw
warning/error logs. The audit is a static guard, not proof that arbitrary future code cannot fail or
that a remote collector received an event.

Regression coverage includes concurrent tenant contexts, preservation of results and rejections,
authentication/authorization responses, response IDs, streamed terminal failures, fatal Node/Bun child
processes, redaction and hostile accessors, stalled exporters, overflow, stderr backpressure, API boot,
Cloud intake validation/size/rate limits, database creation/idempotency/retention/cancellation/fallback,
and a real Desktop-to-instance relay that cannot forward diagnostic uploads. Cloud/non-Cloud boot tests
verify storage is created only in Cloud, events persist across shutdown, and self-hosted/Desktop have
no intake. Browser tests cover Cloud-connected local instances and fail-closed mode detection.
A production dashboard build was also exercised in Chromium against a real temporary API: uncaught
browser exceptions and rejected promises arrived with request references and redacted text.
Existing deployment, rollback, migration, authentication, billing, CLI and Desktop tests continue to
exercise their original behavior in an isolated checkout. Validation never uses customer databases,
credentials or deployment destinations.
