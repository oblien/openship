import { cp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { AppError, NotFoundError } from "@repo/core";
import type { SourceDependencies } from "../../../../sources";
import { prepareSourceDirectory, archiveSourceDirectory, validateSourceDirectory, SOURCE_EXCLUSIONS } from "../../../../source-files";
import { assertNativeSourcePath } from "../../../native/source-policy";
import { getFolderSession, deleteFolderSession } from "./session-store";
import { audit } from "../../../lib/audit-emitter";
import { pickRevealed } from "../../../lib/env-reveal";

function sessionFor(id: string, organizationId: string) {
  const session = getFolderSession(id);
  if (!session || session.orgId !== organizationId) throw new NotFoundError("Upload session", id);
  return session;
}

export const sourceDependencies: SourceDependencies = {
  projectForSession: (ctx, id) => sessionFor(id, ctx.organizationId).projectId,
  open: async (ctx, input, apiBaseUrl) => (await import("./folder.service")).createFolderSession({ ...input, orgId: ctx.organizationId, userId: ctx.userId, apiBaseUrl }),
  async stage(ctx, input) {
    const { createFolderSession } = await import("./folder.service");
    const root = process.env.OPENSHIP_DATA_DIR ? join(process.env.OPENSHIP_DATA_DIR, "sources") : undefined;
    const source = await prepareSourceDirectory(input.source, { temporaryRoot: root, validatePath: assertNativeSourcePath });
    let id: string | undefined;
    try {
      const result = await createFolderSession({ orgId: ctx.organizationId, userId: ctx.userId, projectId: input.projectId, name: input.name ?? (source.temporary ? "app" : basename(source.directory)), stack: input.stack, packageManager: input.packageManager });
      id = result.sessionId;
      const session = sessionFor(id, ctx.organizationId);
      if (session.mode === "api-relay") {
        await cp(source.directory, session.stagingDir!, {
          recursive: true, dereference: true,
          filter: path => !SOURCE_EXCLUSIONS.has(basename(path)),
        });
        await validateSourceDirectory(session.stagingDir!);
        session.uploaded = true;
      } else {
        const archive = await archiveSourceDirectory(source.directory, { temporaryRoot: root });
        const stream = createReadStream(archive.path);
        try {
          const response = await fetch(result.upload.url, { method: "POST", headers: result.upload.headers, body: Readable.toWeb(stream) as ReadableStream<Uint8Array>, duplex: "half", signal: AbortSignal.timeout(120_000) } as RequestInit);
          if (!response.ok) throw new AppError(`Provider source upload failed (${response.status})`, 502, "SOURCE_UPLOAD_FAILED");
          await response.body?.cancel();
          session.uploaded = true;
        } finally { stream.destroy(); await archive.dispose(); }
      }
      return { sessionId: id, expiresAt: result.expiresAt };
    } catch (error) {
      if (id) {
        const session = deleteFolderSession(id);
        if (session?.stagingDir) await rm(session.stagingDir, { recursive: true, force: true });
      }
      throw error;
    } finally { await source.dispose(); }
  },
  async scan(ctx, id, options) {
    const [{ projectInfoToScanResponse }, { scanFolderSession }] = await Promise.all([import("../../deployments/prepare.service"), import("./folder.service")]);
    return projectInfoToScanResponse(await scanFolderSession(sessionFor(id, ctx.organizationId)), options);
  },
  async upload(ctx, id, ticket, body) {
    const session = sessionFor(id, ctx.organizationId);
    if (session.mode !== "api-relay") throw new AppError("Session does not accept relay uploads", 400);
    if (!ticket || ticket !== session.uploadTicket) throw new AppError("Invalid upload ticket", 403);
    if (!body) throw new AppError("Empty upload", 400);
    if (session.uploaded || session.uploading) throw new AppError("This upload session has already received source", 409, "SOURCE_ALREADY_UPLOADED");
    session.uploading = true;
    try { await (await import("./folder.service")).acceptRelayUpload(session, body); }
    finally { session.uploading = false; }
  },
  async reveal(ctx, id, input) {
    const session = sessionFor(id, ctx.organizationId);
    const service = session.services?.find(row => row.name === input.service);
    if (!service) throw new NotFoundError("Service in upload session", input.service);
    return pickRevealed(service.environment, input.keys);
  },
  recordAudit(ctx, operation, sessionId, after) {
    audit.recordAsync({ organizationId: ctx.organizationId, actorUserId: ctx.userId, source: ctx.source ?? "api", ipAddress: ctx.clientIp, userAgent: ctx.userAgent, sourceClientId: ctx.sourceClientId }, {
      eventType: "project:write", resourceType: "project", resourceId: "*", after: { operation, sessionId, ...(after as Record<string, unknown> | undefined) },
    });
  },
};
