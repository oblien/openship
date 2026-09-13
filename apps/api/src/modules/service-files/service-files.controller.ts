/**
 * Read-only file browsing inside a deployed service.
 *
 * SECURITY: this is the SAME REACH as the service terminal — a container's
 * filesystem holds its `.env`, its keys, its database credentials. So it is
 * gated at the same admin tier, with the same 404-shaped denial (never confirm
 * a service exists to someone not allowed to see it).
 *
 * The resolver below deliberately DUPLICATES the terminal's rather than
 * extracting a shared one. The terminal's `resolveServiceForOrg` is the
 * authorization boundary for an interactive shell; parameterising it to serve a
 * second feature means editing that boundary. The two are kept in sync by
 * calling the identical `checkPermission(...)` — if they ever diverge, this
 * comment is the place that says they shouldn't.
 *
 * Runtime gate: `serviceShell`. Docker and Cloud implement it; BARE DOES NOT,
 * and that exclusion is load-bearing rather than incidental — bare's
 * `inContainerExecutor()` ignores its containerId and hands back the HOST
 * executor (bare.ts:154, "a bare deployment is a host process"). Gating on
 * anything weaker would turn this tab into a host filesystem browser.
 */

import type { Context } from "hono";
import { repos } from "@repo/db";
import type { RuntimeAdapter } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";
import { getRequestContext } from "../../lib/request-context";
import { checkPermission } from "../../lib/permission";
import {
  containerIdForService,
  liveContainerIdWithRuntime,
  resolveServiceRuntimeForRead,
} from "../services/service-container";
import {
  MAX_DOWNLOAD_BYTES,
  MAX_ENTRIES,
  MAX_PREVIEW_BYTES,
  buildListCommand,
  buildReadCommand,
  joinContainerPath,
  looksBinary,
  newProbeNonce,
  normalizeContainerPath,
  parseListOutput,
  parseReadOutput,
  type ListFailure,
  type ReadFailure,
} from "./service-files.service";

/**
 * Wall-clock budget for one probe, passed through to the executor — which
 * honours it (`opts.timeout`, guarded by both an in-container watchdog and a JS
 * timer). Well under the runtime's 120s default, because this backs an
 * interactive tab: a wedged container must surface as an error long before the
 * dashboard's own request timeout, not hold the tab spinning.
 */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * In-flight probes per user. The service terminal caps concurrent sessions per
 * user; nothing carried that over, and each probe buffers the base64 payload
 * plus the decoded bytes in API heap (~2.3x the file). On a 3GB-capped API a
 * handful of concurrent 10MB downloads is a real OOM path, and this box has
 * been OOM-killed before.
 */
const MAX_CONCURRENT_PROBES_PER_USER = 4;
const inFlight = new Map<string, number>();

function acquireSlot(userId: string): boolean {
  const current = inFlight.get(userId) ?? 0;
  if (current >= MAX_CONCURRENT_PROBES_PER_USER) return false;
  inFlight.set(userId, current + 1);
  return true;
}

function releaseSlot(userId: string): void {
  const current = inFlight.get(userId) ?? 0;
  if (current <= 1) inFlight.delete(userId);
  else inFlight.set(userId, current - 1);
}

type Resolved = { containerId: string; runtime: RuntimeAdapter };
type ResolveFailure = { status: 403 | 404 | 409 | 500 | 501; message: string };

async function resolveServiceForFiles(
  serviceId: string,
  organizationId: string,
  userId: string,
): Promise<{ ok: true; value: Resolved } | { ok: false; error: ResolveFailure }> {
  const notFound = {
    ok: false as const,
    error: { status: 404 as const, message: "Service not found" },
  };

  const service = await repos.service.findById(serviceId);
  if (!service) return notFound;

  // Admin tier — see the header note. 404-shape on deny, never 403: a 403 would
  // confirm the service exists to someone with no right to know that.
  const allowed = await checkPermission(userId, organizationId, {
    resourceType: "project",
    resourceId: service.projectId,
    action: "admin",
  });
  if (!allowed) return notFound;

  const project = await repos.project.findById(service.projectId);
  if (!project || (project.organizationId != null && project.organizationId !== organizationId)) {
    return notFound;
  }

  if (!project.activeDeploymentId) {
    return { ok: false, error: { status: 409, message: "Project has no active deployment yet" } };
  }
  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) {
    return { ok: false, error: { status: 409, message: "Active deployment not found" } };
  }

  // RUNTIME ONLY — the read-path resolver, for the reason its own doc gives:
  // building the full platform drags the OpenResty detect + Lua self-heal, and
  // the provision lock they run under, into what is a polled read endpoint.
  // That is the exact defect recorded in service.service.ts ("what made status
  // hang and then report unknown"), and the Files tab polls no less than it.
  const runtime = await resolveServiceRuntimeForRead(project, dep);
  if (!runtime) {
    console.error("[service-files] runtime resolution returned null for", service.id);
    return { ok: false, error: { status: 500, message: "Could not reach this service's host" } };
  }

  // From here the runtime is OURS to release: every early return has to hand it
  // back, or a rejected request leaks the same SSH bridge a served one would.
  const abandon = () => void Promise.resolve(runtime.dispose?.()).catch(() => {});

  if (!runtime.supports("serviceShell") || !runtime.inContainerExecutor) {
    abandon();
    return {
      ok: false,
      error: { status: 501, message: `File browsing not supported on ${runtime.name} runtime` },
    };
  }

  // Verify the recorded container against the host: a redeploy replaces it, and
  // probing a dead id fails with docker's opaque "no such container".
  let containerId: string | null;
  try {
    containerId = await liveContainerIdWithRuntime(runtime, {
      service: { id: service.id, name: service.name },
      projectId: project.id,
      slug: project.slug,
      tracked: await containerIdForService(dep, service),
    });
  } catch (err) {
    abandon();
    console.error("[service-files] live container lookup failed:", safeErrorMessage(err));
    return {
      ok: false,
      error: { status: 500, message: `Could not reach the host: ${safeErrorMessage(err)}` },
    };
  }
  if (!containerId) {
    abandon();
    return {
      ok: false,
      error: { status: 409, message: "Service container not found — it may still be deploying." },
    };
  }

  return { ok: true, value: { containerId, runtime } };
}

/** `execInContainer` REJECTS when the container isn't running. That is the
 *  single most likely failure in normal use — a stopped service — so it gets a
 *  real status and a plain-language message, not a 500. */
function execFailure(err: unknown): { status: 409 | 500 | 504; message: string } {
  const message = safeErrorMessage(err);
  if (/timed out/i.test(message)) {
    return { status: 504, message: "The container took too long to answer." };
  }
  if (/not running/i.test(message)) {
    return { status: 409, message: "Service container is not running." };
  }
  // 500, NOT 502. Cloudflare treats a 502 from the origin as a gateway failure
  // and REPLACES the body with its own "Bad gateway" page, so every message
  // below is invisible to any operator behind a CDN — they just see a blank
  // error. Verified against this install: a 404 body passes through, a 502
  // body does not.
  console.error("[service-files] probe failed:", message);
  return { status: 500, message: `Could not read from the container: ${message}` };
}

// See execFailure on why these are 500 rather than 502.
const LIST_STATUS: Record<ListFailure, 400 | 403 | 404 | 500> = {
  not_found: 404,
  not_a_directory: 400,
  permission_denied: 403,
  truncated: 500,
  malformed: 500,
};

const LIST_MESSAGE: Record<ListFailure, string> = {
  not_found: "No such directory in this container",
  not_a_directory: "That path is a file, not a directory",
  permission_denied: "Permission denied inside the container",
  truncated: "The listing came back incomplete — try again",
  malformed: "Could not read the directory listing",
};

const READ_STATUS: Record<ReadFailure, 400 | 403 | 404 | 413 | 500 | 501> = {
  not_found: 404,
  is_a_directory: 400,
  not_regular: 400,
  permission_denied: 403,
  too_large: 413,
  no_base64: 501,
  incomplete: 500,
  malformed: 500,
};

const READ_MESSAGE: Record<ReadFailure, string> = {
  not_found: "No such file in this container",
  is_a_directory: "That path is a directory, not a file",
  not_regular: "That path isn't a regular file (device, socket or pipe)",
  permission_denied: "Permission denied inside the container",
  too_large: "File is too large to open here",
  no_base64: "This container has no `base64`, so its files can't be read here",
  incomplete: "The file came back incomplete — try again",
  malformed: "Could not read the file",
};

interface Probe {
  path: string;
  nonce: string;
  run: (command: string) => Promise<{ ok: true; stdout: string } | { ok: false; status: number; message: string }>;
}

/** Authorize, resolve, normalize the path, and hand back a one-shot probe that
 *  ALWAYS releases both the runtime and the concurrency slot. */
async function prepare(c: Context): Promise<{ ok: true; probe: Probe } | { ok: false; response: Response }> {
  const ctx = getRequestContext(c);
  const serviceId = c.req.param("serviceId");
  if (!serviceId) {
    return { ok: false, response: c.json({ error: "serviceId required" }, 400) };
  }

  const path = normalizeContainerPath(c.req.query("path"));
  if (path === null) {
    return { ok: false, response: c.json({ error: "Invalid path" }, 400) };
  }

  if (!acquireSlot(ctx.userId)) {
    return {
      ok: false,
      response: c.json({ error: "Too many file requests in flight — wait for one to finish." }, 429),
    };
  }

  let resolved: Awaited<ReturnType<typeof resolveServiceForFiles>>;
  try {
    resolved = await resolveServiceForFiles(serviceId, ctx.organizationId, ctx.userId);
  } catch (err) {
    releaseSlot(ctx.userId);
    return {
      ok: false,
      response: c.json({ error: `Could not open this service: ${safeErrorMessage(err)}` }, 500),
    };
  }
  if (!resolved.ok) {
    releaseSlot(ctx.userId);
    return { ok: false, response: c.json({ error: resolved.error.message }, resolved.error.status) };
  }

  const { runtime, containerId } = resolved.value;
  // Fire-and-forget, matching service.service.ts:1071 — teardown still runs, it
  // just never extends the response the user is waiting on.
  const release = () => {
    void Promise.resolve(runtime.dispose?.()).catch(() => {});
    releaseSlot(ctx.userId);
  };

  return {
    ok: true,
    probe: {
      path,
      nonce: newProbeNonce(),
      run: async (command) => {
        try {
          const executor = await runtime.inContainerExecutor!(containerId);
          const stdout = await executor.exec(command, { timeout: PROBE_TIMEOUT_MS });
          return { ok: true, stdout };
        } catch (err) {
          return { ok: false, ...execFailure(err) };
        } finally {
          release();
        }
      },
    },
  };
}

// ─── GET /api/services/files/:serviceId/list?path= ───────────────────────────

export async function listDirectory(c: Context) {
  const prep = await prepare(c);
  if (!prep.ok) return prep.response;
  const { path, nonce, run } = prep.probe;

  const ran = await run(buildListCommand(path, nonce, MAX_ENTRIES));
  if (!ran.ok) return c.json({ error: ran.message }, ran.status as 409);

  const result = parseListOutput(ran.stdout, nonce);
  if (!result.ok) {
    console.error(
      `[service-files] list parse failed reason=${result.reason} bytes=${ran.stdout.length}`,
      JSON.stringify(ran.stdout.slice(0, 300)),
    );
    return c.json({ error: LIST_MESSAGE[result.reason] }, LIST_STATUS[result.reason]);
  }

  return c.json({
    success: true,
    path,
    // Surfaced, never silent: a capped listing that looked complete would tell
    // the operator a directory holds 500 files when it holds 40,000.
    truncated: result.truncated,
    limit: MAX_ENTRIES,
    entries: result.entries.map((e) => ({
      ...e,
      // The client must never build paths itself — normalization lives in one
      // place, and a name like `..` must not become a client-side traversal.
      path: joinContainerPath(path, e.name),
    })),
  });
}

// ─── GET /api/services/files/:serviceId/read?path= ───────────────────────────

export async function readFile(c: Context) {
  const prep = await prepare(c);
  if (!prep.ok) return prep.response;
  const { path, nonce, run } = prep.probe;

  const ran = await run(buildReadCommand(path, MAX_PREVIEW_BYTES, nonce));
  if (!ran.ok) return c.json({ error: ran.message }, ran.status as 409);

  const result = parseReadOutput(ran.stdout, MAX_PREVIEW_BYTES, nonce);
  if (!result.ok) {
    return c.json(
      {
        error: READ_MESSAGE[result.reason],
        reason: result.reason,
        size: result.size ?? null,
        limit: MAX_PREVIEW_BYTES,
      },
      READ_STATUS[result.reason],
    );
  }

  // Binary content is reported, never rendered — the client offers a download
  // instead of painting control bytes into the DOM.
  if (looksBinary(result.content)) {
    return c.json({
      success: true,
      path,
      binary: true,
      size: result.content.byteLength,
      content: null,
    });
  }

  return c.json({
    success: true,
    path,
    binary: false,
    size: result.content.byteLength,
    content: result.content.toString("utf8"),
  });
}

// ─── GET /api/services/files/:serviceId/download?path= ───────────────────────

export async function downloadFile(c: Context) {
  const prep = await prepare(c);
  if (!prep.ok) return prep.response;
  const { path, nonce, run } = prep.probe;

  const ran = await run(buildReadCommand(path, MAX_DOWNLOAD_BYTES, nonce));
  if (!ran.ok) return c.json({ error: ran.message }, ran.status as 409);

  const result = parseReadOutput(ran.stdout, MAX_DOWNLOAD_BYTES, nonce);
  if (!result.ok) {
    return c.json(
      {
        error: READ_MESSAGE[result.reason],
        reason: result.reason,
        size: result.size ?? null,
        limit: MAX_DOWNLOAD_BYTES,
      },
      READ_STATUS[result.reason],
    );
  }

  const filename = path.split("/").pop() || "download";
  // Copy into a plain-ArrayBuffer view: Buffer may sit on a SharedArrayBuffer,
  // which Hono's body type (rightly) refuses.
  const bytes = new Uint8Array(result.content);
  return c.body(bytes, 200, {
    "Content-Type": "application/octet-stream",
    // Percent-encoded: a container filename may contain characters that would
    // otherwise terminate the header value.
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Content-Length": String(bytes.byteLength),
  });
}
