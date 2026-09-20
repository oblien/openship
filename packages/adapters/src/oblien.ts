import {
  Oblien as OblienSdk, OblienError, AuthenticationError, ConflictError,
  NotFoundError, PaymentRequiredError, RateLimitError, ValidationError,
  type OblienOptions, type RequestOptions,
} from "oblien";

function providerError(status: number, body: unknown): OblienError {
  const input = body as { code?: unknown; error?: unknown } | null;
  const candidate = input?.code ?? (typeof input?.error === "string" ? input.error : undefined);
  const code = typeof candidate === "string" && /^[a-z0-9_-]{1,128}$/i.test(candidate) ? candidate : "OBLIEN_REQUEST_FAILED";
  // Provider error bodies can contain account data, resource payloads or auth
  // URLs. Keep the status/code needed for retries without forwarding that body.
  const message = `Oblien rejected the request (HTTP ${status}, ${code})`;
  const ErrorType = status === 401 || status === 403 ? AuthenticationError
    : status === 402 ? PaymentRequiredError : status === 404 ? NotFoundError
      : status === 409 ? ConflictError : status === 429 ? RateLimitError
        : status === 400 || status === 422 ? ValidationError : null;
  return ErrorType ? new ErrorType(message, code, undefined, undefined, status) : new OblienError(message, status, code);
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
      if (result.success === false || result.valid === false || (result.error != null && result.success !== true)) {
        throw providerError(result.code === "NAMESPACE_LIMIT_REACHED" ? 409 : 502, body);
      }
      return body as T;
    };
  }
}
