export interface BytesMapTelemetryConfig {
  endpoint: string;
  dataset: string;
  token: string;
  sampleRate: number;
  environment: string;
}

export interface BytesMapTelemetryEnvironment {
  CLOUD_MODE?: boolean;
  DEPLOY_MODE?: string;
  OPENSHIP_BYTESMAP_ENABLED?: boolean;
  OPENSHIP_BYTESMAP_ENDPOINT?: string;
  OPENSHIP_BYTESMAP_DATASET?: string;
  OPENSHIP_BYTESMAP_TOKEN?: string;
  OPENSHIP_BYTESMAP_SAMPLE_RATE?: number | string;
  OPENSHIP_BYTESMAP_ENVIRONMENT?: string;
  NODE_ENV?: string;
}

/** Explicit Cloud configuration only; a desktop connected to Cloud never exports. */
export function resolveBytesMapTelemetry(
  input: BytesMapTelemetryEnvironment,
): BytesMapTelemetryConfig | null {
  if (
    input.CLOUD_MODE !== true ||
    input.DEPLOY_MODE === "desktop" ||
    input.OPENSHIP_BYTESMAP_ENABLED !== true
  )
    return null;
  const endpoint = new URL(input.OPENSHIP_BYTESMAP_ENDPOINT ?? "");
  const dataset = input.OPENSHIP_BYTESMAP_DATASET?.trim() ?? "";
  const token = input.OPENSHIP_BYTESMAP_TOKEN?.trim() ?? "";
  const suppliedRate = input.OPENSHIP_BYTESMAP_SAMPLE_RATE;
  const sampleRate =
    typeof suppliedRate === "string" && !suppliedRate.trim() ? NaN : Number(suppliedRate ?? 1);
  const environment = input.OPENSHIP_BYTESMAP_ENVIRONMENT ?? input.NODE_ENV ?? "production";
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(dataset) ||
    !/^\S{16,512}$/.test(token) ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 0 ||
    sampleRate > 1
  ) {
    throw new Error(
      "BytesMap telemetry requires an HTTPS ingestion origin, dataset UUID, server sending key and sample rate between zero and one.",
    );
  }
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(environment))
    throw new Error("BytesMap telemetry environment must be a short environment label.");
  return { endpoint: endpoint.origin, dataset, token, sampleRate, environment };
}
