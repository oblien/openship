import { workspaceMetricsStream } from "./oblien-metrics";
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import {
  Oblien as OblienSdk, OblienError, AuthenticationError, ConflictError,
  NotFoundError, PaymentRequiredError, RateLimitError, ValidationError,
  type OblienOptions, type RequestOptions,
} from "oblien";

export { OblienError } from "oblien";

const capacityErrors = new Map([
  [
    "plan_limit_exceeded",
    "The configured Cloud limits exceed the provider account's resource capacity. Contact Openship support.",
  ],
  [
    "namespace_limit_exceeded",
    "The Cloud provider account has reached its namespace limit. Contact Openship support.",
  ],
  [
    "namespace_limit_reached",
    "This workload exceeds your organization's Cloud resource limits. Reduce its resources or review your plan.",
  ],
  [
    "sandbox_limit_reached",
    "The Cloud provider account has reached its workspace limit. Contact Openship support.",
  ],
  [
    "pool_limit_reached",
    "The Cloud provider's resource pool is at capacity. Try again later or contact Openship support.",
  ],
]);

const resourceUnits = {
  cpus: "vCPU",
  memory_mb: "MB",
  disk_size_mb: "MB",
  workspaces: "workspaces",
} as const;
const resourceLabels = {
  cpus: "CPU",
  memory_mb: "RAM",
  disk_size_mb: "Disk",
  workspaces: "Workspaces",
} as const;
type CapacityViolation = {
  resource: keyof typeof resourceUnits;
  requested: number;
  effectiveLimit: number;
  unit: string;
  enforcementScope: "namespace" | "namespace_allocated_pool";
  currentUsage?: number;
};

/** Only this tenant's numeric allocation belongs in a customer-facing error.
 * Provider messages, account usage, identifiers and arbitrary details stay private. */
function namespaceCapacityDetails(raw: unknown) {
  if (!raw || typeof raw !== "object") return undefined;
  const details = raw as Record<string, unknown>;
  const candidates = Array.isArray(details.violations) ? details.violations.slice(0, 4) : [details];
  const numeric = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER;
  const violations: CapacityViolation[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (
      typeof value.resource !== "string" ||
      !Object.hasOwn(resourceUnits, value.resource) ||
      !numeric(value.requested) ||
      !numeric(value.effectiveLimit) ||
      (value.enforcementScope !== "namespace" &&
        value.enforcementScope !== "namespace_allocated_pool")
    )
      continue;
    const resource = value.resource as keyof typeof resourceUnits;
    violations.push({
      resource,
      requested: value.requested,
      effectiveLimit: value.effectiveLimit,
      unit: resourceUnits[resource],
      enforcementScope: value.enforcementScope,
      ...(numeric(value.currentUsage) ? { currentUsage: value.currentUsage } : {}),
    });
  }
  return violations.length ? { ...violations[0]!, violations } : undefined;
}

function workspaceIdFromDetails(details: unknown): string | undefined {
  const id = (details as { workspace_id?: unknown } | null)?.workspace_id;
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : undefined;
}

/** Creation can fail after allocating a workspace. Its identity takes priority
 * over the error status; only a confirmed admission rejection releases a key.
 * An unclassified 422 may be a failed provision after allocation. */
export function cloudWorkspaceCreationFailure(error: unknown): {
  workspaceId?: string;
  rejected: boolean;
  capacityRejected: boolean;
} {
  const value = error as { status?: number; code?: string; details?: unknown } | null;
  const workspaceId = workspaceIdFromDetails(value?.details);
  const capacityRejected = !workspaceId && typeof value?.code === "string" && capacityErrors.has(value.code.toLowerCase());
  return {
    workspaceId,
    capacityRejected,
    rejected:
      !workspaceId &&
      ([400, 401, 402, 403, 404].includes(value?.status ?? 0) || capacityRejected),
  };
}

function providerError(status: number, body: unknown, retryAfter: string | null = null): OblienError {
  const input = body as {
    code?: unknown;
    error?: unknown;
    details?: unknown;
    requestId?: unknown;
  } | null;
  const candidate = input?.code ?? (typeof input?.error === "string" ? input.error : undefined);
  const code =
    typeof candidate === "string" && /^[a-z0-9_-]{1,128}$/i.test(candidate)
      ? candidate
      : status === 429 ? "OBLIEN_RATE_LIMITED" : "OBLIEN_REQUEST_FAILED";
  const capacity =
    code.toLowerCase() === "namespace_limit_reached"
      ? namespaceCapacityDetails(input?.details)
      : undefined;
  const workspaceId = workspaceIdFromDetails(input?.details);
  // Retry-After permits seconds or an HTTP date. Only carry a bounded numeric
  // value across our public error boundary; never reflect an arbitrary header.
  const delay = retryAfter === null ? NaN : /^\d+$/.test(retryAfter)
    ? Number(retryAfter)
    : /^[A-Za-z]{3}, /.test(retryAfter) ? Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000) : NaN;
  const retryAfterSeconds = Number.isSafeInteger(delay) && delay >= 0 && delay <= 86400 ? delay : undefined;
  const details = capacity || workspaceId || retryAfterSeconds !== undefined ? {
    ...capacity,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  } : undefined;
  const requestId =
    typeof input?.requestId === "string" &&
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.requestId)
      ? input.requestId
      : undefined;
  const allocation = capacity?.violations
    .map((value) => {
      const scope =
        value.enforcementScope === "namespace_allocated_pool"
          ? "namespace total"
          : value.resource === "workspaces"
            ? "namespace workspace count"
            : "per workspace";
      return (
        `${resourceLabels[value.resource]} requested ${value.requested} ${value.unit}; limit ${value.effectiveLimit} ${value.unit} (${scope})` +
        (value.currentUsage === undefined
          ? "."
          : `; currently allocated ${value.currentUsage} ${value.unit}.`)
      );
    })
    .join(" ");
  const message =
    `${capacityErrors.get(code.toLowerCase()) ?? (status === 429 ? "Oblien temporarily throttled the request" : "Oblien rejected the request")}` +
    (allocation ? ` ${allocation}` : "") +
    ` (HTTP ${status}, ${code})` +
    (requestId ? ` Request ID: ${requestId}.` : "") +
    (retryAfterSeconds !== undefined ? ` Retry after ${retryAfterSeconds} seconds.` : "");
  const ErrorType =
    status === 401 || status === 403
      ? AuthenticationError
      : status === 402
        ? PaymentRequiredError
        : status === 404
          ? NotFoundError
          : status === 409
            ? ConflictError
            : status === 429
              ? RateLimitError
              : status === 400 || status === 422
                ? ValidationError
                : null;
  return ErrorType
    ? new ErrorType(message, code, details, requestId, status)
    : new OblienError(message, status, code, details, requestId);
}

/** Keep the official SDK's endpoints, handles and runtime clients. Bound JSON
 * requests, reject credential redirects, and keep provider bodies private while
 * preserving SDK cancellation and token refresh/restore. */
export class Oblien extends OblienSdk {
  readonly streamWorkspaceMetrics: (workspaceId: string, signal?: AbortSignal) => AsyncIterable<unknown>;
  /** Provider's public egress picker. SDK 2.10 exposes applying an IP but not
   * listing it. Keep this fixed endpoint and strip all pool credentials here. */
  async listOutboundIps(): Promise<{ ip: string; countryCode: string | null }[]> {
    const response = await this._http.request<{ success: boolean; proxies: unknown }>({
      method: "GET", path: "/zone/mine",
    });
    if (response.success !== true || !Array.isArray(response.proxies) || response.proxies.length > 10_000)
      throw new OblienError("Outbound addresses are unavailable", 502, "OBLIEN_OUTBOUND_OPTIONS_INVALID");
    const ips = new Map<string, { ip: string; countryCode: string | null }>();
    for (const item of response.proxies) {
      if (!item || typeof item !== "object" || typeof item.ip !== "string" ||
          !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(item.ip) || item.ip.split(".").some((octet: string) => Number(octet) > 255))
        throw new OblienError("Outbound addresses are unavailable", 502, "OBLIEN_OUTBOUND_OPTIONS_INVALID");
      ips.set(item.ip, { ip: item.ip, countryCode: typeof item.country_code === "string" && /^[A-Z]{2}$/.test(item.country_code) ? item.country_code : null });
    }
    return [...ips.values()];
  }

  constructor(options: OblienOptions & {
    tokenRefresh?: {
      expiresAt: string;
      refresh(): Promise<{ token: string; expiresAt: string }>;
      invalidate?(rejectedToken: string): Promise<void>;
    };
  }) {
    const base = new URL(options.baseUrl ?? "https://api.oblien.com");
    if (base.username || base.password || base.search || base.hash ||
        (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
      throw new Error("Oblien API URL must use HTTPS (HTTP is allowed for localhost tests)");
    }
    super(options);
    const original = new Headers();
    if ("token" in options) { if (options.token) original.set("Authorization", `Bearer ${options.token}`); }
    else { original.set("X-Client-ID", options.clientId); original.set("X-Client-Secret", options.clientSecret); }
    let auth = new Headers(original);
    const setToken = this._http.setToken.bind(this._http);
    const restoreAuth = this._http.restoreAuth.bind(this._http);
    let expiresAt = Date.parse(options.tokenRefresh?.expiresAt ?? "");
    let refreshing: Promise<void> | undefined;
    const ensureAuth = () => {
      if (!options.tokenRefresh || expiresAt - Date.now() > 60_000) return;
      return (refreshing ??= Promise.resolve().then(() => options.tokenRefresh!.refresh()).then(next => {
        const expiry = Date.parse(next.expiresAt);
        if (!next.token || !Number.isFinite(expiry) || expiry <= Date.now())
          throw new Error("Cloud returned invalid execution credentials");
        this._http.setToken(next.token);
        expiresAt = expiry;
      }).finally(() => { refreshing = undefined; }));
    };
    this._http.setToken = token => {
      auth = new Headers({ Authorization: `Bearer ${token}` });
      setToken(token);
    };
    this._http.restoreAuth = () => { auth = new Headers(original); restoreAuth(); expiresAt = 0; };
    const invalidateRejectedToken = async (rejectedAuthorization: string | null) => {
      if (!options.tokenRefresh) return;
      // Invalidate for the next explicit operation; never replay a mutation or
      // subscription. A late rejection must not expire a newer generation.
      if (rejectedAuthorization === auth.get("Authorization")) expiresAt = 0;
      await options.tokenRefresh.invalidate?.(rejectedAuthorization?.replace(/^Bearer /, "") ?? "").catch(error => {
        observeCaughtError(error, "adapters/oblien");
      });
    };
    this.streamWorkspaceMetrics = (workspaceId, signal) => workspaceMetricsStream(async (subscriptionSignal) => {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId)) throw new Error("Invalid Cloud workspace identity");
      const renewal = ensureAuth();
      if (renewal) await renewal;
      subscriptionSignal.throwIfAborted();
      const url = new URL(`/workspace/${encodeURIComponent(workspaceId)}/stats/stream`, base);
      const headers = new Headers(auth);
      headers.set("Accept", "text/event-stream");
      const response = await fetch(url, { headers, redirect: "error", signal: subscriptionSignal });
      if (response.status === 401) await invalidateRejectedToken(headers.get("Authorization"));
      return response;
    }, signal);
    this._http.request = async <T>(request: RequestOptions): Promise<T> => {
      request.signal?.throwIfAborted();
      const url = new URL(request.path, base);
      if (url.origin !== base.origin || url.username || url.password) throw new Error("Oblien request escaped its API origin");
      const renewal = ensureAuth();
      if (renewal) await renewal;
      request.signal?.throwIfAborted();
      for (const [key, value] of Object.entries(request.query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
      const headers = new Headers(request.headers);
      for (const key of ["Authorization", "X-Client-ID", "X-Client-Secret"]) headers.delete(key);
      headers.set("Accept", "application/json");
      headers.set("Content-Type", "application/json");
      for (const [key, value] of auth) headers.set(key, value);
      const waitingCreate = request.method === "POST" && /^\/workspace\/?$/.test(url.pathname) &&
        (request.body as { wait_ready?: boolean } | undefined)?.wait_ready !== false;
      let response: Response;
      let body: unknown;
      try {
        const timeout = AbortSignal.timeout(waitingCreate ? 600_000 : 60_000);
        response = await fetch(url, { method: request.method, headers,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          redirect: "error", signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
        });
        body = response.status === 204 ? { success: true } : await response.json().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "adapters/oblien"); return null; });
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "adapters/oblien");
        request.signal?.throwIfAborted();
        throw new OblienError("Oblien is temporarily unreachable. Retry the operation.", 503, "OBLIEN_UNAVAILABLE");
      }
      request.signal?.throwIfAborted();
      if (!response.ok) {
        if (response.status === 401) await invalidateRejectedToken(headers.get("Authorization"));
        throw providerError(response.status, body, response.headers.get("Retry-After"));
      }
      if (!body || typeof body !== "object") throw providerError(502, body);
      const result = body as { success?: boolean; valid?: boolean; error?: unknown; code?: unknown };
      // Older provider deployments returned HTTP 200 with
      // { valid:false, code:NAMESPACE_LIMIT_REACHED }. Preserve compatibility
      // without mistaking that refusal for an undefined but successful VM.
      if (
        result.success === false ||
        result.valid === false ||
        (result.error != null && result.success !== true)
      ) {
        const code = result.code ?? result.error;
        throw providerError(
          typeof code === "string" && capacityErrors.has(code.toLowerCase()) ? 409 : 502,
          body,
        );
      }
      return body as T;
    };
    // SDK 2.5 types get() as WorkloadInfo but leaves the HTTP envelope intact,
    // unlike create() and list(). Normalize at the provider boundary so process
    // control and server-resize recovery read the same saved workload record.
    const getWorkload = this.workspaces.workloads.get.bind(this.workspaces.workloads);
    this.workspaces.workloads.get = async (workspaceId, workloadId) => {
      const response = await getWorkload(workspaceId, workloadId);
      const workload = response.workload ?? response;
      if (!workload || typeof workload !== "object" || Array.isArray(workload) ||
          !("id" in workload) || typeof workload.id !== "string") {
        throw new OblienError("Oblien returned an invalid application process record", 502, "OBLIEN_WORKLOAD_INVALID");
      }
      return workload as typeof response;
    };
  }
}
