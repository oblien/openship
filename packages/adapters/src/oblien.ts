import {
  Oblien as OblienSdk, OblienError, AuthenticationError, ConflictError,
  NotFoundError, PaymentRequiredError, RateLimitError, ValidationError,
  type OblienOptions, type RequestOptions,
} from "oblien";

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

function providerError(status: number, body: unknown): OblienError {
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
      : "OBLIEN_REQUEST_FAILED";
  const capacity =
    code.toLowerCase() === "namespace_limit_reached"
      ? namespaceCapacityDetails(input?.details)
      : undefined;
  const workspaceId = workspaceIdFromDetails(input?.details);
  const details = workspaceId ? { ...capacity, workspace_id: workspaceId } : capacity;
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
    `${capacityErrors.get(code.toLowerCase()) ?? "Oblien rejected the request"}` +
    (allocation ? ` ${allocation}` : "") +
    ` (HTTP ${status}, ${code})` +
    (requestId ? ` Request ID: ${requestId}.` : "");
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
  constructor(options: OblienOptions) {
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
    this._http.setToken = token => {
      auth = new Headers({ Authorization: `Bearer ${token}` });
      setToken(token);
    };
    this._http.restoreAuth = () => { auth = new Headers(original); restoreAuth(); };
    this._http.request = async <T>(request: RequestOptions): Promise<T> => {
      request.signal?.throwIfAborted();
      const url = new URL(request.path, base);
      if (url.origin !== base.origin || url.username || url.password) throw new Error("Oblien request escaped its API origin");
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
        body = response.status === 204 ? { success: true } : await response.json().catch(() => null);
      } catch {
        request.signal?.throwIfAborted();
        throw new OblienError("Oblien is temporarily unreachable. Retry the operation.", 503, "OBLIEN_UNAVAILABLE");
      }
      request.signal?.throwIfAborted();
      if (!response.ok) throw providerError(response.status, body);
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
