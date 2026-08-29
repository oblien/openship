/**
 * Folder-upload deploy sessions.
 *
 * Lets a browser (SaaS or self-hosted) create a project from a local folder by
 * uploading its contents to a pre-created build workspace, then running the
 * normal build/deploy pipeline. Two byte-transports, one control-plane:
 *
 *   - SaaS (CLOUD_MODE): provision an Oblien *temporary* workspace + mint a
 *     workspace-scoped token; the browser uploads the tar.gz DIRECTLY to the
 *     workspace (mode "oblien-direct"). Deploy adopts that workspace.
 *   - Self-hosted: create a staging dir on this host + a single-use relay
 *     ticket; the browser uploads to POST /projects/folder/upload/:id (mode
 *     "api-relay"), and the existing localPath→transfer pipeline ships it on.
 *
 * Sessions are RAM-only with a TTL (like terminal sessions): the workspace /
 * staging dir they point at is itself short-lived, so surviving a restart is
 * meaningless.
 */

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { getBuildImage, safeErrorMessage, type StackId } from "@repo/core";
import { provisionCloudWorkspace } from "@repo/adapters";
import { env } from "../../../config/env";
import { getNamespaceClient } from "../../../lib/openship-cloud";
import { resolveApiPublicUrl } from "../../../lib/public-url";
import {
  newFolderSessionId,
  putFolderSession,
  sweepExpiredFolderSessions,
  type FolderSession,
} from "./session-store";

const execFileAsync = promisify(execFile);

/** How long a session (and the workspace/staging dir it points at) is valid —
 *  generous so upload → wizard → deploy comfortably fits. */
const SESSION_TTL_MS = 60 * 60_000;
/** Oblien workspace TTL — long enough for upload → wizard → deploy to fit. The
 *  workspace is promoted to permanent on deploy, reaped on TTL/exit otherwise. */
const WORKSPACE_TTL = "60m";

/** Build-time resources for the upload workspace. Deploy makes it permanent
 *  (and can resize); these just need to be enough to install + build. */
const UPLOAD_BUILD_RESOURCES = { cpuCores: 2, memoryMb: 2048, diskMb: 8192 } as const;

/** Oblien runtime gateway (routes by the workspace-scoped token). Server-side
 *  only — the browser never learns this; it just gets an opaque upload URL. */
const OBLIEN_RUNTIME_URL = "https://workspace.oblien.com";

/** Evict expired sessions (via the store) and clean up any staging dirs they
 *  owned. The store stays free of node:fs, so the fs cleanup lives here. */
function sweepExpired(now: number): void {
  for (const s of sweepExpiredFolderSessions(now)) {
    if (s.stagingDir) void rm(s.stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface CreateFolderSessionInput {
  orgId: string;
  userId: string;
  /** Client-detected stack — picks the workspace image for the cloud path. */
  stack?: string;
  packageManager?: string;
  name?: string;
  /** Public base for this API as the CALLER reached it (controller resolves it
   *  from the request) — used to build `upload.absoluteUrl`. */
  apiBaseUrl?: string;
}

/**
 * Opaque upload target handed to the browser. The client is deliberately DUMB
 * about where this points (Oblien workspace, this API, a future object store):
 * it just POSTs the tar.gz to `url` with `headers`. Keeping the destination
 * server-owned means we can change it later without touching the client.
 */
export interface UploadTarget {
  /** Absolute URL (external), or an API-relative path the client resolves
   *  against its API base. */
  url: string;
  /**
   * The same target, fully resolved — so a client that doesn't know this API's
   * base URL (MCP, curl) doesn't have to guess one. On the self-hosted relay
   * this is built from the instance's public URL, so it's only as reachable as
   * that is configured (OPENSHIP_PUBLIC_URL / a verified self-app domain);
   * `url` stays the authoritative form for a client that has its own base.
   */
  absoluteUrl: string;
  method: "POST";
  headers: Record<string, string>;
  /**
   * The upload needs the CALLER's API credentials on top of `headers` — the
   * relay route is permission-checked like any other (send the same
   * `Authorization: Bearer …` you used to open the session, or the session
   * cookie). False for an external target, which carries its own token in
   * `headers` and must never see Openship credentials.
   */
  requiresAuth: boolean;
  /** Send the browser's session cookie? true for the same-origin API relay,
   *  false for an external target (so cookies never leak cross-origin). */
  withCredentials: boolean;
}

export interface FolderSessionResult {
  sessionId: string;
  expiresAt: number;
  upload: UploadTarget;
}

/**
 * Open an upload session. On the SaaS this provisions the Oblien workspace and
 * mints a browser-safe workspace-scoped token; self-hosted just prepares a
 * staging dir + relay ticket.
 */
export async function createFolderSession(
  input: CreateFolderSessionInput,
): Promise<FolderSessionResult> {
  const now = Date.now();
  sweepExpired(now);

  const id = newFolderSessionId();
  const expiresAt = now + SESSION_TTL_MS;

  if (env.CLOUD_MODE) {
    // ── SaaS: direct browser → Oblien workspace ──
    // Use the org's NAMESPACE-scoped client (same as every other cloud service:
    // cloud-pages, cloud-edge-proxy, deploy). The master client can create a
    // namespaced workspace but then can't resolve it by bare id.
    const { client } = await getNamespaceClient(input.orgId);
    // The workspace image is fixed at create time, so resolve it from the
    // client-detected stack when known; fall back to a general JS/TS base
    // otherwise (most uploads are Node/Bun; a mismatch just means the user
    // re-uploads after switching the build image).
    let image: string;
    try {
      if (!input.stack) throw new Error("no stack hint");
      image = getBuildImage(input.stack as StackId, input.packageManager);
    } catch {
      image = input.packageManager === "bun" ? "oven/bun:latest" : "node:22";
    }

    let workspaceId: string | undefined;
    let uploadToken: string;
    try {
      // Provision with the SAME primitive the deploy path uses (create temporary
      // → makeTemporary(remove_on_exit) → connect runtime, with retry): a failed
      // upload/deploy is reaped by Oblien, a successful deploy promotes it to
      // permanent (build/access → adoptWorkspaceRuntime).
      const provisioned = await provisionCloudWorkspace(client, {
        name: `upload-${input.orgId.slice(0, 16)}-${id.slice(0, 6)}`,
        image,
        mode: "temporary",
        resources: UPLOAD_BUILD_RESOURCES,
        ttl: WORKSPACE_TTL,
      });
      workspaceId = provisioned.workspaceId;

      // The browser uploads the tar.gz straight to the workspace's runtime
      // gateway, authenticated with its Gateway JWT. provisionCloudWorkspace
      // already enabled the API server (via runtime()), so getToken just reads
      // that JWT — a workspace-level op the namespace client is allowed to do,
      // unlike the admin-only top-level tokens.create.
      const status = await client.workspace(workspaceId).apiAccess.getToken();
      if (!status.token) throw new Error("runtime API server returned no token");
      uploadToken = status.token;
    } catch (err) {
      // provisionCloudWorkspace cleans up its own failures; this only runs if it
      // succeeded but the token read didn't. remove_on_exit/TTL is the backstop.
      if (workspaceId) await client.workspace(workspaceId).delete().catch(() => {});
      throw new Error(`Failed to provision upload workspace: ${safeErrorMessage(err)}`);
    }

    putFolderSession({
      id,
      orgId: input.orgId,
      userId: input.userId,
      mode: "oblien-direct",
      createdAt: now,
      expiresAt,
      workspaceId,
      uploaded: false,
      name: input.name,
    });

    const workspaceUploadUrl = `${OBLIEN_RUNTIME_URL}/files/transfer/upload?dest=/app`;
    return {
      sessionId: id,
      expiresAt,
      upload: {
        url: workspaceUploadUrl,
        absoluteUrl: workspaceUploadUrl,
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "Content-Type": "application/gzip",
        },
        requiresAuth: false,
        withCredentials: false,
      },
    };
  }

  // ── Self-hosted: relay upload to a staging dir on this host ──
  const stagingDir = await mkdtemp(join(tmpdir(), "openship-upload-"));
  const uploadTicket = randomBytes(24).toString("base64url");

  putFolderSession({
    id,
    orgId: input.orgId,
    userId: input.userId,
    mode: "api-relay",
    createdAt: now,
    expiresAt,
    stagingDir,
    uploadTicket,
    uploaded: false,
    name: input.name,
  });

  return {
    sessionId: id,
    expiresAt,
    upload: {
      url: `projects/folder/upload/${id}`,
      // Resolved from the request when possible (so a desktop dynamic port / LAN
      // address isn't advertised as localhost), else the instance's public base —
      // which accounts for the dashboard same-origin proxy on a --public-url box.
      absoluteUrl: `${input.apiBaseUrl ?? resolveApiPublicUrl()}/api/projects/folder/upload/${id}`,
      method: "POST",
      headers: {
        "x-upload-ticket": uploadTicket,
        "Content-Type": "application/gzip",
      },
      requiresAuth: true,
      withCredentials: true,
    },
  };
}

/**
 * Accept an uploaded tar.gz for a self-hosted (api-relay) session: stream it to
 * disk and extract into the staging dir. Ticket-checked by the caller.
 */
export async function acceptRelayUpload(
  session: FolderSession,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  if (session.mode !== "api-relay" || !session.stagingDir) {
    throw new Error("Session does not accept relay uploads");
  }

  const archivePath = join(session.stagingDir, "__upload.tar.gz");
  await streamToFile(body, archivePath);

  try {
    await safeExtractTarGz(archivePath, session.stagingDir);
  } finally {
    await rm(archivePath, { force: true }).catch(() => {});
  }

  session.uploaded = true;
}

/**
 * Extract a tar.gz into `destDir`, defended against path traversal (Zip-Slip).
 * The tarball is client-supplied — an authenticated org member could bypass the
 * browser packer and POST a crafted archive — so we do NOT trust it: list every
 * member first and REJECT any absolute path or `..` component before extracting.
 * This check is independent of the tar implementation's own (varying) safety
 * behavior. Extraction then runs without restoring archive ownership.
 */
async function safeExtractTarGz(archivePath: string, destDir: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tzf", archivePath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const raw of stdout.split("\n")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry.startsWith("/") || entry.startsWith("~")) {
      throw new Error("Rejected upload: archive contains an absolute path");
    }
    if (entry.split("/").some((seg) => seg === "..")) {
      throw new Error("Rejected upload: archive contains a path-traversal entry");
    }
  }

  await execFileAsync(
    "tar",
    ["-xzf", archivePath, "-C", destDir, "--no-same-owner"],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

async function streamToFile(body: ReadableStream<Uint8Array>, dest: string): Promise<void> {
  // `pipeline` handles backpressure, propagates errors from BOTH ends, and
  // destroys the streams on failure — so a disk-full/permission error rejects
  // here instead of surfacing as an unhandled 'error' that crashes the process.
  await pipeline(Readable.fromWeb(body as NodeWebReadableStream<Uint8Array>), createWriteStream(dest));
}

/**
 * Authoritative framework detection on the uploaded source.
 *   - oblien-direct: read the workspace filesystem via the runtime.
 *   - api-relay: read the staging dir via node:fs (self-hosted only).
 *
 * Any compose services found are REMEMBERED on the session: they're returned to
 * the client too, but the deploy step must not depend on the client handing them
 * back (the documented session → scan → ensure → deploy flow has no step that
 * does), and by then the uploaded compose file is no longer parsed again.
 */
export async function scanFolderSession(session: FolderSession) {
  const info = await scanSource(session);
  session.services = info.services;
  return info;
}

async function scanSource(session: FolderSession) {
  if (session.mode === "oblien-direct") {
    if (!session.workspaceId) throw new Error("Session has no workspace");
    // Namespace-scoped client (not the master) so the by-id runtime lookup
    // resolves within the org's namespace — same reason as createFolderSession.
    const { client } = await getNamespaceClient(session.orgId);
    const rt = await client.workspaces.runtime(session.workspaceId);
    const { resolveFromRuntime } = await import("../../deployments/runtime-source");
    return resolveFromRuntime(rt, session.name ?? "app");
  }

  if (!session.stagingDir) throw new Error("Session has no staging directory");
  const st = await stat(session.stagingDir).catch(() => null);
  if (!st?.isDirectory()) throw new Error("Uploaded source not found");
  const { resolveFromLocal } = await import("../../deployments/local-source");
  return resolveFromLocal(session.stagingDir);
}
