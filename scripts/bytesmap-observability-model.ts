/** Bounded OpenTelemetry and operational dimensions for the owned control-plane dataset. */
export const bytesmapOperationalDimensions = [
  ...[
    "trace_id",
    "span_id",
    "parent_span_id",
    "span_name",
    "service_name",
    "span_status",
    "span_kind",
    "level",
    "message",
    "deployment_environment",
    "service_version",
    "http_method",
    "http_route",
  ].map((name) => ({ name, type: "string" as const })),
  ...["duration_ms", "http_status_code"].map((name) => ({ name, type: "number" as const })),
  ...[
    "event_name",
    "observation_id",
    "request_id",
    "parent_request_id",
    "error_id",
    "error_code",
    "error_category",
    "workspace_id",
    "user_id",
    "project_id",
    "server_id",
    "deployment_id",
    "job_id",
    "run_id",
    "resource_type",
    "resource_id",
    "component",
    "operation",
    "source",
    "kind",
    "service_instance_id",
    "provider_code",
    "provider_request_id",
  ].map((name) => ({ name, type: "string" as const })),
  ...[
    "status_code",
    "provider_status",
    "attempt",
    "uptime_seconds",
    "memory_rss_mb",
    "heap_used_mb",
    "cpu_percent",
    "event_loop_p95_ms",
    "export_failures",
  ].map((name) => ({ name, type: "number" as const })),
  ...["handled", "untrusted", "retryable"].map((name) => ({ name, type: "boolean" as const })),
];

/** All panels execute the existing scoped ClickHouse source; no control-plane DB or secret access. */
export function bytesmapOperationalQueries(tableName: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(tableName))
    throw new Error("Invalid BytesMap dataset table.");
  const table = `bytesmap_events.\`${tableName}\``;
  return [
    {
      title: "API latency and errors",
      columns: ["operation", "requests", "errors", "p95_ms", "p99_ms"],
      statement: `SELECT span_name AS operation,count() AS requests,countIf(span_status='error') AS errors,quantile(0.95)(duration_ms) AS p95_ms,quantile(0.99)(duration_ms) AS p99_ms FROM ${table} WHERE type='trace.span' AND span_kind='server' AND timestamp>=now()-INTERVAL 1 HOUR GROUP BY span_name ORDER BY requests DESC LIMIT 100`,
    },
    {
      title: "Operational outcomes",
      columns: ["event_name", "records"],
      chart: true,
      statement: `SELECT event_name,count() AS records FROM ${table} WHERE type='log' AND event_name IS NOT NULL AND timestamp>=now()-INTERVAL 24 HOUR GROUP BY event_name ORDER BY records DESC LIMIT 50`,
    },
    {
      title: "Recent platform errors",
      columns: [
        "timestamp",
        "operation",
        "error_category",
        "error_code",
        "request_id",
        "workspace_id",
        "deployment_id",
        "trace_id",
        "message",
      ],
      statement: `SELECT timestamp,operation,error_category,error_code,request_id,workspace_id,deployment_id,trace_id,message FROM ${table} WHERE type='log' AND event_name='openship.error' AND timestamp>=now()-INTERVAL 24 HOUR ORDER BY timestamp DESC LIMIT 100`,
    },
    {
      title: "Control-plane instances",
      columns: [
        "service_instance_id",
        "last_seen",
        "uptime_seconds",
        "memory_rss_mb",
        "heap_used_mb",
        "cpu_percent",
        "event_loop_p95_ms",
        "export_failures",
      ],
      statement: `SELECT service_instance_id,max(timestamp) AS last_seen,argMax(uptime_seconds,timestamp) AS uptime_seconds,argMax(memory_rss_mb,timestamp) AS memory_rss_mb,argMax(heap_used_mb,timestamp) AS heap_used_mb,argMax(cpu_percent,timestamp) AS cpu_percent,argMax(event_loop_p95_ms,timestamp) AS event_loop_p95_ms,argMax(export_failures,timestamp) AS export_failures FROM ${table} WHERE type='log' AND event_name='openship.control_plane.heartbeat' AND timestamp>=now()-INTERVAL 15 MINUTE GROUP BY service_instance_id ORDER BY last_seen DESC LIMIT 100`,
    },
  ];
}

export function bytesmapOperationalView(
  panel: ReturnType<typeof bytesmapOperationalQueries>[number],
  queryId: string,
) {
  const component = panel.chart
    ? {
        id: "outcomes",
        type: "chart",
        datasetId: "data",
        width: 12,
        spec: {
          mark: "bar",
          x: { field: "event_name", type: "nominal" },
          y: { field: "records", type: "quantitative" },
        },
      }
    : {
        id: "table",
        type: "table",
        datasetId: "data",
        width: 12,
        key: [panel.columns[0]],
        columns: panel.columns.map((name) => ({ name, label: name })),
      };
  return {
    version: 1,
    title: `OpenShip Cloud · ${panel.title}`,
    datasets: [{ id: "data", queryId, params: {} }],
    components: [{ ...component, title: panel.title }],
  };
}
