import { ValidationError } from "./errors";

export const EDGE_RESPONSE_MAX_BYTES = 64 * 1024;
export const EDGE_RESPONSE_MAX_HEADERS = 32;
export const EDGE_RESPONSE_MAX_ROUTES = 64;
export const EDGE_RESPONSE_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/** A literal response, served after the domain's access policies. Never executable code. */
export interface EdgeResponse {
  match: "exact" | "prefix";
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
  /** An empty list matches all supported methods. GET also matches HEAD. */
  methods: string[];
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const MANAGED_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "x-accel-redirect",
]);
const bytes = (value: string) => new TextEncoder().encode(value).length;

export function normalizeResponsePath(input: unknown): string {
  if (typeof input !== "string" || !input.startsWith("/"))
    throw new ValidationError("Enter a path starting with /.");
  let path: string;
  try {
    path = decodeURIComponent(input.trim());
  } catch {
    throw new ValidationError("Enter a valid URL path.");
  }
  if (
    bytes(path) > 512 ||
    /[\u0000-\u0020\u007f?#\\%]/.test(path) ||
    path.includes("//") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  )
    throw new ValidationError("Use a path without query parameters, fragments, or dot segments.");
  if (
    /^\/(?:_openship|\.openship)(?:\/|$)/.test(path) ||
    /^\/\.well-known\/acme-challenge(?:\/|$)/.test(path)
  )
    throw new ValidationError("This path is reserved for domain verification or platform routes.");
  return path;
}

/** Shared by the editor and API. Invalid content must fail, never silently truncate. */
export function normalizeEdgeResponse(input: unknown): EdgeResponse {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ValidationError("Enter a static response.");
  const value = input as Record<string, unknown>;
  const match = value.match ?? "exact";
  if (match !== "exact" && match !== "prefix")
    throw new ValidationError("Choose exact path or path prefix.");
  const status = value.status ?? 200;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599)
    throw new ValidationError("Response status must be a whole number from 200 to 599.");
  const body = value.body ?? "";
  if (typeof body !== "string" || bytes(body) > EDGE_RESPONSE_MAX_BYTES)
    throw new ValidationError("Response content must be text of at most 64 KiB.");
  if ([204, 205, 304].includes(status) && body !== "")
    throw new ValidationError("Statuses 204, 205, and 304 require an empty response body.");
  const contentType = value.contentType ?? "text/plain; charset=utf-8";
  if (
    typeof contentType !== "string" ||
    bytes(contentType) > 256 ||
    CONTROL.test(contentType) ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;[^\r\n]*)?$/.test(contentType)
  )
    throw new ValidationError(
      "Enter a valid content type, such as text/plain or application/json.",
    );
  const entries =
    value.headers === undefined
      ? []
      : value.headers && typeof value.headers === "object" && !Array.isArray(value.headers)
        ? Object.entries(value.headers)
        : null;
  if (!entries || entries.length > EDGE_RESPONSE_MAX_HEADERS)
    throw new ValidationError("A response can contain at most 32 headers.");
  const headers: Record<string, string> = {};
  let headerBytes = 0;
  for (const [name, headerValue] of entries) {
    const key = name.toLowerCase();
    if (name.length > 128 || !HEADER_NAME.test(name) || MANAGED_HEADERS.has(key))
      throw new ValidationError(
        `Header ${name.slice(0, 128)} is invalid or managed by the edge. Use the content type field for Content-Type.`,
      );
    if (Object.hasOwn(headers, key)) throw new ValidationError(`Header ${name} is repeated.`);
    if (typeof headerValue !== "string" || CONTROL.test(headerValue) || bytes(headerValue) > 2048)
      throw new ValidationError(`Header ${name} must be a single line of at most 2 KiB.`);
    headerBytes += bytes(name) + bytes(headerValue);
    if (headerBytes > 8192) throw new ValidationError("Response headers must fit within 8 KiB.");
    Object.defineProperty(headers, key, {
      value: headerValue,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  const methods = value.methods ?? ["GET", "HEAD"];
  if (
    !Array.isArray(methods) ||
    methods.length > EDGE_RESPONSE_METHODS.length ||
    methods.some(
      (method) =>
        typeof method !== "string" ||
        !(EDGE_RESPONSE_METHODS as readonly string[]).includes(method),
    )
  )
    throw new ValidationError("Choose supported HTTP request methods.");
  return { match, status, body, contentType, headers, methods: [...new Set(methods)] };
}
