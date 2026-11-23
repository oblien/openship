import { ValidationError } from "./errors";
import { EDGE_RESPONSE_MAX_BYTES } from "./edge-response";
import { normalizeCustomHostname } from "./utils";

export const EDGE_PAGE_STATUSES = [400, 403, 404, 405, 408, 413, 429, 500, 502, 503, 504] as const;
export const EDGE_PAGE_LIMIT = 12;
export type EdgePageStatus = (typeof EDGE_PAGE_STATUSES)[number];

/** HTML is response data, never an nginx directive, Lua program or filesystem path. */
export interface EdgePage {
  id: string;
  name: string;
  html: string;
}
export interface EdgePages {
  files: EdgePage[];
  errors: { status: EdgePageStatus; pageId: string }[];
  maintenance?: { enabled: boolean; pageId?: string; retryAfter: number };
  /** Only meaningful on the server: unmatched hostnames and direct-IP requests. */
  defaultPageId?: string;
}
export interface ProjectEdgePages {
  defaults?: EdgePages;
  hosts?: Record<string, EdgePages>;
}

export function normalizeEdgeHtml(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    new TextEncoder().encode(value).length > EDGE_RESPONSE_MAX_BYTES
  )
    throw new ValidationError("Choose a non-empty HTML file of at most 64 KiB.");
  return value;
}

export function normalizeEdgePages(
  input: unknown,
  scope: "server" | "project" = "project",
): EdgePages {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ValidationError("Enter an edge page configuration.");
  const v = input as Record<string, unknown>;
  if (!Array.isArray(v.files) || v.files.length > EDGE_PAGE_LIMIT || !Array.isArray(v.errors))
    throw new ValidationError("Use at most 12 HTML files and one page per error status.");
  const ids = new Set<string>();
  const files = v.files.map((file): EdgePage => {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(file.id) ||
      ids.has(file.id) ||
      typeof file.name !== "string" ||
      !file.name.trim() ||
      file.name.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(file.name)
    )
      throw new ValidationError(
        "Each HTML file needs a unique ID and a name of at most 100 characters.",
      );
    ids.add(file.id);
    return { id: file.id, name: file.name.trim(), html: normalizeEdgeHtml(file.html) };
  });
  const reference = (id: unknown): string => {
    if (typeof id !== "string" || !ids.has(id))
      throw new ValidationError("Choose an existing HTML file.");
    return id;
  };
  const statuses = new Set<number>();
  const errors = v.errors.map((binding) => {
    if (
      !binding ||
      !(EDGE_PAGE_STATUSES as readonly number[]).includes(binding.status) ||
      statuses.has(binding.status)
    )
      throw new ValidationError("Choose each supported error status only once.");
    statuses.add(binding.status);
    return { status: binding.status as EdgePageStatus, pageId: reference(binding.pageId) };
  });
  const out: EdgePages = { files, errors };
  if (v.maintenance !== undefined) {
    if (scope === "server")
      throw new ValidationError("Enable maintenance on a project or hostname.");
    const m = v.maintenance as Record<string, unknown>;
    if (
      !m ||
      typeof m.enabled !== "boolean" ||
      typeof m.retryAfter !== "number" ||
      !Number.isInteger(m.retryAfter) ||
      m.retryAfter < 60 ||
      m.retryAfter > 86400
    )
      throw new ValidationError("Maintenance retry time must be between 60 and 86400 seconds.");
    out.maintenance = {
      enabled: m.enabled,
      retryAfter: m.retryAfter,
      ...(m.pageId === undefined ? {} : { pageId: reference(m.pageId) }),
    };
  }
  if (v.defaultPageId !== undefined) {
    if (scope !== "server")
      throw new ValidationError("The default address page belongs to the server.");
    out.defaultPageId = reference(v.defaultPageId);
  }
  return out;
}

/** Resolve bindings before inheritance so independently named files cannot collide. */
export function compileEdgePages(pages?: EdgePages | null) {
  if (!pages) return undefined;
  const byId = new Map(pages.files.map((file) => [file.id, file.html]));
  return {
    errors: Object.fromEntries(
      pages.errors.map((binding) => [binding.status, byId.get(binding.pageId)!]),
    ),
    ...(pages.maintenance
      ? {
          maintenance: {
            enabled: pages.maintenance.enabled,
            retryAfter: pages.maintenance.retryAfter,
            ...(pages.maintenance.pageId ? { html: byId.get(pages.maintenance.pageId) } : {}),
          },
        }
      : {}),
    ...(pages.defaultPageId ? { defaultHtml: byId.get(pages.defaultPageId) } : {}),
  };
}
export type CompiledEdgePages = NonNullable<ReturnType<typeof compileEdgePages>>;

export function normalizeProjectEdgePages(input: ProjectEdgePages): ProjectEdgePages {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ValidationError("Enter project edge pages.");
  const result: ProjectEdgePages = {};
  if (input.defaults !== undefined) result.defaults = normalizeEdgePages(input.defaults);
  if (input.hosts !== undefined) {
    if (
      !input.hosts ||
      typeof input.hosts !== "object" ||
      Array.isArray(input.hosts) ||
      Object.keys(input.hosts).length > 50
    )
      throw new ValidationError("Configure pages for at most 50 hostnames.");
    result.hosts = {};
    for (const [host, pages] of Object.entries(input.hosts).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (!host.includes(".") || normalizeCustomHostname(host) !== host || host.includes("*"))
        throw new ValidationError("Choose an exact domain hostname for custom pages.");
      Object.defineProperty(result.hosts, host, {
        value: normalizeEdgePages(pages),
        enumerable: true,
      });
    }
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 2 * 1024 * 1024)
    throw new ValidationError("Project HTML pages must fit within 2 MiB.");
  return result;
}

export function resolveProjectEdgePages(
  config: ProjectEdgePages | undefined,
  hostname: string,
): CompiledEdgePages | null {
  const defaults = compileEdgePages(config?.defaults);
  const host = compileEdgePages(config?.hosts?.[hostname.toLowerCase()]);
  if (!defaults && !host) return null;
  const resolved = { ...defaults, ...host, errors: { ...defaults?.errors, ...host?.errors } };
  // An unused library or an explicit maintenance-off needs no request handler.
  return Object.keys(resolved.errors).length || resolved.maintenance?.enabled ? resolved : null;
}
