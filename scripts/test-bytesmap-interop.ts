import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { exerciseBytesMapApi } from "./bytesmap-real-api";
import {
  bytesmapOperationalDimensions,
  bytesmapOperationalQueries,
  bytesmapOperationalView,
} from "./bytesmap-observability-model";

const source = process.env.BYTESMAP_SOURCE_DIRECTORY;
if (!source)
  throw new Error(
    "Set BYTESMAP_SOURCE_DIRECTORY to a checkout with the OTLP/schema-2 implementation.",
  );
const bytesmap = resolve(source);
const offset = Number(process.env.BYTESMAP_EVENTS_TEST_PORT_OFFSET ?? 3000);
if (!Number.isInteger(offset) || offset < 0 || offset > 40000)
  throw new Error("Invalid fixture port offset.");
const directory = await mkdtemp(join(tmpdir(), "openship-bytesmap-interop-"));
const root = resolve(import.meta.dir, "..");
const secret = crypto.randomUUID() + crypto.randomUUID();
const children: ReturnType<typeof Bun.spawn>[] = [];
let fixture: any;
let host: any;
let stopControl: (() => Promise<void> | void) | undefined;
let tls: ReturnType<typeof Bun.serve> | undefined;
let actor: any;
let dataset: any;
async function command(args: string[], cwd: string, env: Record<string, string | undefined>) {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  children.push(child);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code)
    throw new Error(`Fixture command failed (${args[0]}): ${(stderr || stdout).slice(-2000)}`);
}
async function port() {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const value = listener.port!;
  await listener.stop(true);
  return value;
}
try {
  const [{ registerAll }, databaseModule, db, native, configuration, listener] = await Promise.all([
    import(join(bytesmap, "packages/adapters/src/index.ts")),
    import(join(bytesmap, "packages/db/test/fixture.ts")),
    import(join(bytesmap, "packages/db/src/index.ts")),
    import(join(bytesmap, "packages/platform/src/engine/native-host.ts")),
    import(join(bytesmap, "packages/platform/src/engine/config/environment.ts")),
    import(join(bytesmap, "apps/api/src/lib/events-listener.ts")),
  ]);
  registerAll();
  fixture = await databaseModule.createTestDatabase();
  await fixture.database
    .insert(db.schema.user)
    .values({ id: "interop-owner", name: "Owned interop fixture", email: "interop@example.test" });
  await fixture.database.insert(db.schema.organization).values({
    id: "interop-org",
    name: "Owned interop fixture",
    slug: `interop-${crypto.randomUUID()}`,
  });
  await fixture.database.insert(db.schema.member).values({
    id: "interop-member",
    organizationId: "interop-org",
    userId: "interop-owner",
    role: "owner",
  });
  const publicPort = await port(),
    privatePort = await port(),
    controlPort = await port();
  const env = configuration.readEnvironment({
    NODE_ENV: "test",
    BYTESMAP_EVENTS_ENABLED: "true",
    BYTESMAP_EVENTS_ALLOW_PLAINTEXT_LOOPBACK: "true",
    BYTESMAP_EVENTS_SERVICE_TOKEN: secret,
    BYTESMAP_EVENTS_PRIVATE_PORT: String(controlPort),
    BYTESMAP_EVENTS_INGEST_URL: `http://127.0.0.1:${publicPort}`,
    BYTESMAP_EVENTS_DATA_URL: `http://127.0.0.1:${privatePort}`,
  });
  host = native.createNativeHost({ database: fixture.database, configuration: env });
  const owner = await db.createAccessRepository(fixture.database).user.findById("interop-owner");
  actor = await host.authorization.resolveScope(
    { user: owner, sessionId: "interop", sessionKind: "native" },
    "interop-org",
    { source: "native" },
  );
  dataset = (
    await host.events.create(actor, {
      name: "Owned OpenShip Cloud interop",
      dimensions: bytesmapOperationalDimensions,
      policy: { redactKeys: ["password", "token", "authorization", "cookie"] },
    })
  ).data;
  const credential = (
    await host.events.createCredential(actor, { id: dataset.id, name: "Owned Node exporter" })
  ).data;
  stopControl = listener.startEventsListener(env, () => host.eventRuntime.policy());
  const binary = join(directory, "events");
  await command(["go", "build", "-o", binary, "./cmd/events"], join(bytesmap, "apps/events"), {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  });
  const runtimeEnv = {
    PATH: process.env.PATH,
    HOME: directory,
    BYTESMAP_EVENTS_ALLOW_PLAINTEXT_LOOPBACK: "true",
    BYTESMAP_EVENTS_SERVICE_TOKEN: secret,
    BYTESMAP_EVENTS_NATS_URL: `nats://127.0.0.1:${18223 + offset}`,
    BYTESMAP_EVENTS_CLICKHOUSE_NATIVE_URL: `clickhouse://127.0.0.1:${19000 + offset}`,
    BYTESMAP_EVENTS_CLICKHOUSE_HTTP_URL: `http://127.0.0.1:${18123 + offset}`,
    BYTESMAP_EVENTS_CLICKHOUSE_USER: "events_admin",
    BYTESMAP_EVENTS_CLICKHOUSE_PASSWORD: "events-test-admin-password",
    BYTESMAP_EVENTS_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
    BYTESMAP_EVENTS_PUBLIC_LISTEN: `127.0.0.1:${publicPort}`,
    BYTESMAP_EVENTS_PRIVATE_LISTEN: `127.0.0.1:${privatePort}`,
  };
  await command([binary, "migrate"], directory, runtimeEnv);
  const events = Bun.spawn([binary, "all"], { env: runtimeEnv, stdout: "pipe", stderr: "pipe" });
  children.push(events);
  const readyBy = Date.now() + 20_000;
  while (
    !(await fetch(`http://127.0.0.1:${publicPort}/health`)
      .then((response) => response.ok)
      .catch(() => false))
  ) {
    if (events.exitCode !== null || Date.now() >= readyBy)
      throw new Error("Owned Go fixture did not start.");
    await Bun.sleep(100);
  }
  const cert = join(directory, "ca.pem"),
    key = join(directory, "key.pem");
  await command(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ],
    directory,
    { PATH: process.env.PATH, HOME: directory },
  );
  tls = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(cert), key: Bun.file(key) },
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (!["/v1/traces", "/v1/logs"].includes(path)) return new Response(null, { status: 404 });
      const response = await fetch(`http://127.0.0.1:${publicPort}${path}${url.search}`, {
        method: "POST",
        headers: {
          "content-type": request.headers.get("content-type")!,
          authorization: request.headers.get("authorization")!,
        },
        body: await request.arrayBuffer(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        const failure = (await response
          .clone()
          .json()
          .catch(() => ({}))) as { error?: string };
        console.log(
          JSON.stringify({
            fixtureReceiver: path,
            status: response.status,
            error: failure.error ?? "ingest_rejected",
          }),
        );
      }
      return response;
    },
  });
  const resultPath = join(directory, "result.json");
  const node = Bun.which("node");
  assert.ok(node);
  const producer = [
    node,
    "--import",
    "tsx",
    join(root, "apps/api/test/fixtures/bytesmap-producer.ts"),
    resultPath,
  ];
  const producerEnv = {
    PATH: process.env.PATH,
    HOME: directory,
    NODE_ENV: "test",
    OPENSHIP_TARGET: "local-saas",
    OPENSHIP_CLOUD_TARGET: "local-saas",
    DEPLOY_MODE: "cloud",
    BETTER_AUTH_SECRET: crypto.randomUUID() + crypto.randomUUID(),
    INTERNAL_TOKEN: "interop-internal-token-with-at-least-32-characters",
    NODE_EXTRA_CA_CERTS: cert,
    OPENSHIP_BYTESMAP_ENABLED: "true",
    OPENSHIP_BYTESMAP_ENDPOINT: `https://127.0.0.1:${tls.port}`,
    OPENSHIP_BYTESMAP_DATASET: dataset.id,
    OPENSHIP_BYTESMAP_TOKEN: credential.token,
    OPENSHIP_BYTESMAP_ENVIRONMENT: "test",
  };
  await command(producer, root, { ...producerEnv, CLOUD_MODE: "false" });
  assert.equal(
    (await host.events.search(actor, { id: dataset.id })).data.events.length,
    0,
    "Non-Cloud host exported telemetry",
  );
  await command(producer, root, { ...producerEnv, CLOUD_MODE: "true" });
  const produced = await Bun.file(resultPath).json();
  assert.equal(produced.auditIds.length, 36);
  assert.equal(produced.observations.length, 8);
  const expected = 127; // 80 spans, 36 persisted audit facts, 8 existing error observations and 3 process records.
  let total = 0;
  const indexedBy = Date.now() + 20_000;
  while (total !== expected && Date.now() < indexedBy) {
    const counts = (await host.events.groups(actor, { id: dataset.id, groupBy: ["type"] })).data;
    total = counts.groups.reduce((sum: number, row: any) => sum + row.events, 0);
    if (total !== expected) await Bun.sleep(100);
  }
  assert.equal(total, expected, "Cloud telemetry was lost or duplicated");
  const trace = (await host.events.trace(actor, { id: dataset.id, traceId: produced.traces[0] }))
    .data;
  assert.equal(trace.events.length, 2);
  const rootSpan = trace.events.find((event: any) => event.dimensions.span_kind === "server");
  const operation = trace.events.find(
    (event: any) => event.dimensions.span_name === "deployments.deploy",
  );
  assert.equal(operation.dimensions.parent_span_id, rootSpan.dimensions.span_id);
  assert.equal(rootSpan.dimensions.span_status, "error");
  assert.equal(operation.dimensions.span_status, "error");
  const views = [];
  const statements = bytesmapOperationalQueries(dataset.tableName);
  for (const item of statements) {
    const query = (
      await host.queries.create(actor, {
        name: item.title,
        sourceId: dataset.sourceId,
        query: { kind: "native", sourceKind: "clickhouse", statement: item.statement },
      })
    ).data.query;
    const view = (
      await host.views.create(actor, { definition: bytesmapOperationalView(item, query.id) })
    ).data.view;
    views.push(view);
  }
  const dashboard = (
    await host.dashboards.create(actor, {
      title: "OpenShip Cloud operations interop",
      layout: views.map((view) => ({ app: view.id, w: 12, h: 6 })),
    })
  ).data.dashboard;
  const draft = (await host.dashboards.runtime(actor, { id: dashboard.id })).data.workspace;
  const published = (await host.workspaces.publish(actor, { id: draft.id, version: draft.version }))
    .data.workspace;
  const panels = await Promise.all(
    views.map((view) =>
      host.workspaces
        .data(actor, {
          id: published.id,
          pageId: dashboard.id,
          publicationId: published.publicationId,
          kind: "panel",
          panelId: view.id,
          datasetId: "data",
        })
        .then((result: any) => result.data.records),
    ),
  );
  assert.equal(Number(panels[0][0].requests), 40);
  assert.equal(Number(panels[0][0].errors), 4);
  assert.equal(
    Number(panels[1].find((row: any) => row.event_name === "deployment.created").records),
    36,
  );
  assert.equal(panels[2].length, 8);
  assert.equal(panels[3].length, 1);
  assert.equal(Number(panels[3][0].export_failures), 0);
  const errors = (
    await host.events.search(actor, {
      id: dataset.id,
      type: "log",
      conditions: [{ field: "dimensions.event_name", op: "=", value: "openship.error" }],
    })
  ).data.events;
  assert.deepEqual(
    errors.map((event: any) => event.dimensions.observation_id).sort(),
    produced.observations.map((event: any) => event.eventId).sort(),
    "Existing error observations must each export exactly once",
  );
  assert.equal(new Set(errors.map((event: any) => event.dimensions.error_id)).size, 4);
  const audits = (
    await host.events.search(actor, {
      id: dataset.id,
      type: "log",
      conditions: [{ field: "dimensions.event_name", op: "=", value: "deployment.created" }],
    })
  ).data.events;
  assert.deepEqual(
    audits.map((event: any) => event.dimensions.observation_id).sort(),
    produced.auditIds.sort(),
    "Persisted audit records must each export exactly once",
  );
  for (const event of errors) {
    const inspected = (
      await host.events.inspect(actor, {
        id: dataset.id,
        eventId: event.id,
        namespace: event.namespace,
        group: event.group,
      })
    ).data;
    assert.ok(!JSON.stringify(inspected).includes("interop-private-value"));
    assert.ok(event.dimensions.trace_id && event.dimensions.span_id);
  }
  await command([process.execPath, "run", "--cwd", "apps/cli", "build"], root, {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  });
  const real = await exerciseBytesMapApi(directory, root, {
    NODE_EXTRA_CA_CERTS: cert,
    OPENSHIP_BYTESMAP_ENABLED: "true",
    OPENSHIP_BYTESMAP_ENDPOINT: producerEnv.OPENSHIP_BYTESMAP_ENDPOINT,
    OPENSHIP_BYTESMAP_DATASET: dataset.id,
    OPENSHIP_BYTESMAP_TOKEN: credential.token,
    OPENSHIP_BYTESMAP_ENVIRONMENT: "test",
  });
  for (const request of real.requests) {
    let spans: any[] = [];
    const deadline = Date.now() + 20_000;
    while (!spans.length && Date.now() < deadline) {
      spans = (await host.events.trace(actor, { id: dataset.id, traceId: request.traceId })).data
        .events;
      if (!spans.length) await Bun.sleep(100);
    }
    const server = spans.find((event: any) => event.dimensions.span_kind === "server");
    assert.ok(server, `Missing real API trace for ${request.name}`);
    assert.equal(server.dimensions.parent_span_id, request.parentSpanId);
    assert.equal(server.dimensions.http_status_code, request.status);
    assert.equal(server.dimensions.request_id, request.requestId);
    if (request.status >= 400 && request.status < 500)
      assert.notEqual(
        server.dimensions.span_status,
        "error",
        "Client rejection counted as a server failure",
      );
    if (request.name.startsWith("projects.list.")) {
      const operation = spans.find((event: any) => event.dimensions.span_name === "projects.list");
      assert.ok(operation, "Real platform operation span missing");
      assert.equal(operation.dimensions.parent_span_id, server.dimensions.span_id);
      assert.equal(operation.dimensions.workspace_id, real.organizationId);
      assert.equal(operation.dimensions.user_id, real.userId);
    }
  }
  const realErrors = (
    await host.events.search(actor, {
      id: dataset.id,
      type: "log",
      conditions: [
        { field: "dimensions.observation_id", op: "=", value: real.browserObservationId },
      ],
    })
  ).data.events;
  assert.equal(
    realErrors.length,
    1,
    "Real stored browser exception was lost or duplicated in BytesMap",
  );
  assert.equal(realErrors[0].dimensions.untrusted, true);
  const inspected = (
    await host.events.inspect(actor, {
      id: dataset.id,
      eventId: realErrors[0].id,
      namespace: realErrors[0].namespace,
      group: realErrors[0].group,
    })
  ).data;
  assert.ok(!JSON.stringify(inspected).includes("real-api-private-value"));
  assert.ok(!JSON.stringify(inspected).includes("real-api-query-secret"));
  const refreshedErrors = (
    await host.workspaces.data(actor, {
      id: published.id,
      pageId: dashboard.id,
      publicationId: published.publicationId,
      kind: "panel",
      panelId: views[2].id,
      datasetId: "data",
    })
  ).data.records;
  assert.ok(
    refreshedErrors.some((row: any) => row.request_id === realErrors[0].dimensions.request_id),
    "Published dashboard did not refresh with the real API exception",
  );
  const require = createRequire(join(root, "apps/api/package.json"));
  const sdk = await Bun.file(require.resolve("bytesmap/package.json")).json();
  const report = {
    at: new Date().toISOString(),
    receiver: "Owned Go → NATS → ClickHouse with TLS from the actual Node Cloud bootstrap",
    records: total,
    requests: 40,
    failedRequests: 4,
    spans: 80,
    persistedAuditFacts: audits.length,
    errorObservations: errors.length,
    distinctFailures: 4,
    existingChannelIdsMatched: true,
    verifiedPublishedPanels: panels.length,
    localModeExportedRecords: 0,
    originalSecretsRedacted: true,
    parentChildCorrelation: true,
    bytesmapSdkVersion: sdk.version,
    realApi: {
      requests: real.requests.length,
      concurrentAuthenticatedRequests: real.concurrentRequests,
      concurrentDurationMs: Math.round(real.durationMs),
      persistedErrorObservations: real.persistedErrorObservations,
      verifiedBrowserExceptionCopies: realErrors.length,
      authenticatedPlatformSpans: true,
      clientRejectionsExcludedFromServerFailures: true,
      refreshedPublishedErrorPanel: true,
    },
  };
  const output = join(root, "apps/api/test-results");
  await mkdir(output, { recursive: true });
  await Bun.write(join(output, "bytesmap-interop.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (host && actor && dataset) await host.events.remove(actor, { id: dataset.id }).catch(() => {});
  await tls?.stop(true);
  for (const child of [...children].reverse()) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
  }
  await stopControl?.();
  await host?.engine.close();
  await fixture?.close();
  await rm(directory, { recursive: true, force: true });
}
