# OpenShip Cloud operational telemetry in BytesMap

OpenShip Cloud uses the single `bytesmap` npm SDK (`bytesmap/events/server`) for
traces, logs and errors. BytesMap owns OpenTelemetry internally and exports to
the configured BytesMap ingestion origin; OpenShip has no direct OpenTelemetry
dependencies, providers or exporters. The existing structured-error reporter supplies one
sanitized snapshot per accepted observation. Its database/local destinations
continue to operate independently of the exporter. A collector outage cannot
change an API result, retry a deployment, or grant access to an organization.
Spans carry timing, status and correlation; exception details are exported only
through the existing error reporter, without another copy on each span.
HTTP server spans follow the final response: only 5xx responses count as server
failures. Handled errors and failed lifecycle events retain their diagnostic logs
without marking successful or rejected (4xx) requests as server failures. Failed
child operations and background jobs keep their own error status.

## Configuration

Deploy the BytesMap OTLP implementation and storage schema 2 before enabling
this integration. The API runtime requires Node 22.15 or newer. Configure the
Cloud API's runtime environment:

```dotenv
CLOUD_MODE=true
DEPLOY_MODE=cloud
OPENSHIP_BYTESMAP_ENABLED=true
OPENSHIP_BYTESMAP_ENDPOINT=https://YOUR_MANAGED_INGESTION_ORIGIN
OPENSHIP_BYTESMAP_DATASET=YOUR_DATASET_UUID
OPENSHIP_BYTESMAP_TOKEN=YOUR_DATASET_SERVER_SENDING_KEY
OPENSHIP_BYTESMAP_SAMPLE_RATE=1
OPENSHIP_BYTESMAP_ENVIRONMENT=production
```

The endpoint is the HTTPS ingestion origin, not the BytesMap account API or a
`/v1/traces` URL. The SDK sends both `/v1/traces` and `/v1/logs` with the dataset sending key
and a `dataset` query parameter. Never use a BytesMap account administration token
here, put these credentials in `NEXT_PUBLIC_*`, or send them to a browser.

The integration is off by default. It requires both `CLOUD_MODE=true` and the
explicit enable flag, and it refuses `DEPLOY_MODE=desktop`. Connecting a local
installation to Cloud does not enable it. Invalid enabled configuration produces
a credential-free local warning while the existing diagnostics keep running.
The environment label defaults to `NODE_ENV`; use an explicit label for staging.

## Collected signals

| Boundary            | Data                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP                | Registered route, method, status, duration, generated request reference and authenticated identifiers. Valid W3C `traceparent` is accepted; headers cannot assert identity.               |
| Platform operations | The same operation span through HTTP, MCP and SDK, preserving synchronous results, original rejections and streamed iteration.                                                            |
| Deployments         | A span for the detached deployment execution, including project/deployment/server context and recorded failures.                                                                          |
| Jobs                | Fresh scheduled-job context, backup run/attempt IDs and propagated queue trace parents for both BullMQ and in-process fast paths. Recovered jobs can start new traces.                    |
| Oblien              | Client spans for provider and billing requests, with W3C parent propagation. Request paths, headers, bodies and payment data are excluded from these spans.                               |
| Errors              | Existing API, platform, browser-intake, worker and recovered-error observations, with category, severity, error/observation IDs and trace/span/request correlation.                       |
| Audit facts         | Recorded event type and opaque authorized user/workspace/resource identifiers after the audit write succeeds. Audit diffs, names, IP addresses and user agents remain in the audit store. |
| Process             | Start/stop records and a minute heartbeat: uptime, RSS/heap, CPU use, event-loop p95 and failed export attempts, scoped to a random process instance ID.                                  |

`workspace_id` is the observed **OpenShip** workspace. BytesMap's own tenant
identity remains controlled by the dataset credential; `organization_id` and
`event_id` are reserved BytesMap fields. `observation_id` carries an OpenShip
observation/audit ID. `error_id` can span multiple boundary observations; use
request context as well when counting incidents.

The existing Cloud browser-error intake keeps its authentication, validation,
rate limits and untrusted markers. It receives no BytesMap key. Customer
application stdout/stderr, request bodies, environment values, command text,
cookies, raw query strings and arbitrary audit payloads are not added to this
integration. Fatal process reporting retains its synchronous local exit path;
remote receipt cannot be guaranteed during a crash.

## Dataset and dashboard setup

Create a dedicated Events dataset in an existing BytesMap Cloud storage
connection. This does not require buying or provisioning another destination.
Keep it in an internal operator workspace: this dataset contains operational
observations across OpenShip customers, so its dataset/dashboard permissions
must remain restricted to the intended platform operators.
The complete field list is available with:

```sh
bun scripts/setup-bytesmap-observability.ts --schema
```

The operator setup helper can add missing dimensions to that existing dataset
and publish a dashboard. It refuses conflicting types and the dataset's
64-dimension limit. Supply a private configuration file:

```json
{
  "apiUrl": "https://YOUR_BYTESMAP_ACCOUNT_API",
  "organizationId": "YOUR_BYTESMAP_ORGANIZATION_ID",
  "datasetId": "YOUR_DATASET_UUID",
  "manifestPath": "/PRIVATE_DIRECTORY/openship-bytesmap.json"
}
```

Use an operator account API token with dataset/query/view/dashboard permissions,
held in a private JSON file with a `token` property. Preview first:

```sh
BYTESMAP_API_TOKEN_FILE=/PRIVATE_DIRECTORY/operator-token.json \
  bun scripts/setup-bytesmap-observability.ts /PRIVATE_DIRECTORY/config.json
```

Add `--apply` after reviewing the field additions and four planned panels. The
helper journals created IDs to the private manifest for resumable setup. Retain
that manifest; deleting it and applying again creates another dashboard. A
process interruption between an API creation and its receipt can leave an
orphaned resource, so review the library before repeating an interrupted step.
The helper does not purchase storage, deploy services, create ingestion keys or
enable alerts. Create the dataset sending key through BytesMap's Access UI and
put it in the Cloud API environment above.

The dashboard uses the existing scoped ClickHouse source for:

- API operation counts, failures and p95/p99 latency over one hour.
- Operational outcome counts over 24 hours, including deployment and audit facts.
- Recent structured errors with request, trace, workspace and deployment context.
- Recently observed process instances and heartbeat/runtime measurements.

Use Events → Traces to open a trace's waterfall and related error logs. Filter by
`request_id`, `workspace_id`, `deployment_id` or `error_id` when investigating a
support reference. Heartbeat rows expose `last_seen`; they are observations,
not an authoritative inventory or proof of high availability. CPU percentages
can exceed 100 on multithreaded processes. Periodic runtime measurements use
OTLP log records; this integration does not require an OTLP metrics receiver.

## Delivery, sampling and operations

BytesMap owns OpenTelemetry batching, context and protocol encoding, using its
shared event-delivery transport. It cooperates with an existing OpenTelemetry
context manager and installs one only when needed. OpenShip configures a 16 MiB
transport buffer, 256 records per signal queue, batches of at most 32 records,
a 1.5-second request deadline, one delivery attempt and a 2-second flush wait.
Native events, traces and logs share the same SDK lifecycle. Attributes and
diagnostic snapshots remain bounded. Export failures emit a rate-limited local
warning without recursively capturing exporter errors.

Requests enqueue telemetry without awaiting delivery. Graceful shutdown flushes
the existing reporter and the telemetry providers within a bounded budget.
Queues are in memory: saturation, process termination, transport failures and
shutdown deadlines can lose external telemetry. Existing Cloud error storage
and the audit log remain available under their original delivery contracts.
Heartbeat export-failure counts reset on restart and count failed export
attempts, not every record dropped from an SDK buffer.

Root trace sampling defaults to 100%; child spans inherit their parent decision.
Reduce `OPENSHIP_BYTESMAP_SAMPLE_RATE` only with an understood workload and
sampling policy. Error and operational logs remain unsampled, so a log can refer
to a trace that was not retained. Counts and percentiles over spans describe
retained spans, not an unsampled traffic or availability SLO. A separate
OpenTelemetry Collector can provide deployment-specific persistent queues and
tail sampling. When using tail sampling, retain all eligible spans upstream.

For initial alert workflows, consider sustained server errors, failed deployments
or backups, slow retained traces and missing heartbeats for expected instances.
Review the query, recipients and schedule in BytesMap before enabling a workflow.
The billing ledger and security audit retain their existing responsibilities.

The former hosted product-analytics exporter, browser event intake and email-client
analytics SDK have been removed. Upgrade migration 0225 deletes only the retired
product-event outbox, checkout-correlation mirror and subscription snapshot tables;
their delivery schedule is removed during startup. Authoritative billing and audit
records are retained. Earlier migration files remain in place for upgrade continuity.

## Verification

The API unit suite imports the installed BytesMap SDK and sends real OTLP JSON
to a capture receiver. It covers concurrent tenant isolation, parent/span correlation,
registered-route privacy, redaction, stream completion, returned failures,
sampling and collector refusal. Existing diagnostic, job, provider and billing
tests exercise the shared touched boundaries.

An optional cross-repository fixture verifies the actual Node Cloud bootstrap
through HTTPS into BytesMap's Go receiver, durable NATS, ClickHouse and published
dashboard panels. It requires a schema-2 BytesMap checkout and a disposable
NATS/ClickHouse fixture with matching alternate ports:

```sh
BYTESMAP_SOURCE_DIRECTORY=/PATH/TO/bytesmap \
BYTESMAP_EVENTS_TEST_PORT_OFFSET=3000 \
  bun --no-env-file scripts/test-bytesmap-interop.ts
```

The fixture creates temporary metadata, dataset credentials, a loopback-only
TLS proxy and owned Go/Node processes. A 40-request synthetic deployment workload
uses the existing audit writer against an isolated in-memory database and the
existing operation/HTTP error boundaries. It checks that each persisted audit ID
and accepted error observation ID appears exactly once in BytesMap: 36 audit
facts, 8 observations of 4 failures, 80 spans and 3 process records. The fixture
adds no lifecycle telemetry calls around the operation. It verifies correlation
and all four published panels, then builds the packaged Node server, signs in an
owned test user through real Better Auth, and exercises authenticated project reads, missing
projects, validation failures and browser exception intake. Sixteen concurrent
HTTP requests check the real authorization and platform spans. The same browser
observation must exist once in BytesMap, remain redacted in both stores, and
appear when the published error panel refreshes. Non-Cloud mode must export zero
records. This is a concurrency smoke test, not a production capacity benchmark.
It writes `apps/api/test-results/bytesmap-interop.json` with the installed SDK
version and removes its temporary resources. It never deploys a workload, uses
a developer account, or changes production configuration.
