import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { AppError } from "@repo/core";
import type { BackupDestination } from "@repo/adapters";
import type { ActionJob, ActionRun, ActionStorageObject, createActionStorageRepo } from "@repo/db";
import { ActionRuntimeTokens, type ActionRuntimeIdentity } from "./runtime-identity";

export interface ActionStorageContext {
  run: ActionRun;
  job: ActionJob;
  identity: ActionRuntimeIdentity;
}
export interface ActionStoragePorts {
  repo: ReturnType<typeof createActionStorageRepo>;
  tokens: ActionRuntimeTokens;
  baseUrl(): string;
  authorize(identity: ActionRuntimeIdentity): Promise<ActionStorageContext>;
  store(organizationId: string, destinationId: string): Promise<BackupDestination>;
  reportError(error: unknown, objectId: number): void;
}
const MAX_OBJECT = 1024 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024 * 1024;
const ORG_QUOTA = 20 * MAX_OBJECT;
const DAY = 24 * 60 * 60_000;
const invalid = (message: string) => new AppError(message, 400, "ACTIONS_STORAGE_INVALID");
const missing = () =>
  new AppError("Actions artifact or cache not found", 404, "ACTIONS_OBJECT_NOT_FOUND");
const json = (value: unknown, status = 200) => Response.json(value, { status });
const plain = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function string(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f]/.test(value))
    throw invalid("Invalid artifact or cache parameter");
  return value;
}
function bytes(value: unknown, max = MAX_OBJECT): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0 || number > max)
    throw invalid("Invalid Actions upload size");
  return number;
}
async function readSmall(request: Request, max = 64 * 1024): Promise<string> {
  const values: Buffer[] = [];
  let size = 0;
  if (request.body)
    for await (const value of Readable.fromWeb(request.body as never)) {
      size += value.length;
      if (size > max)
        throw new AppError(
          "Actions metadata request is too large",
          413,
          "ACTIONS_METADATA_TOO_LARGE",
        );
      values.push(Buffer.from(value));
    }
  return Buffer.concat(values).toString("utf8");
}
async function body(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readSmall(request));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid("Actions metadata must be JSON");
  }
  // protobuf JSON permits either camelCase or the original snake_case names.
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(plain(value))) {
    const normalized = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (Object.hasOwn(result, normalized)) throw invalid("Repeated Actions metadata parameter");
    result[normalized] = val;
  }
  return result;
}
function wrapper(value: unknown): unknown {
  return typeof value === "object" ? plain(value).value : value;
}

/** Authenticated protocol adapters, not an execution engine. Both modern artifact
 * actions and cache v1/v2 use the same bounded, tenant-scoped object store. */
export class ActionStorageProtocol {
  constructor(private readonly ports: ActionStoragePorts) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (/\/objects\/\d+$/.test(url.pathname)) return this.objectRequest(request, url);
    const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
    const identity = await this.ports.tokens.verify(token, "runtime");
    const ctx = await this.ports.authorize(identity);
    if (url.pathname.includes("/ArtifactService/") || url.pathname.includes(".ArtifactService/")) {
      if (request.method !== "POST") throw invalid("Artifact metadata requires POST");
      return this.artifact(ctx, url.pathname.split("/").at(-1)!, await body(request));
    }
    if (ctx.run.untrusted) {
      if (request.method === "GET") return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/GetCacheEntryDownloadURL")) return json({ ok: false });
      throw new AppError("Fork runs cannot write shared caches", 403, "ACTIONS_RUNTIME_SCOPE");
    }
    if (url.pathname.includes(".CacheService/")) {
      if (request.method !== "POST") throw invalid("Cache metadata requires POST");
      return this.cacheV2(ctx, url.pathname.split("/").at(-1)!, await body(request));
    }
    return this.cacheV1(ctx, request, url);
  }

  private async reserve(
    ctx: ActionStorageContext,
    kind: "artifact" | "cache",
    name: string,
    version = "",
    maxBytes = MAX_OBJECT,
    expires?: unknown,
  ) {
    const destinationId = ctx.run.configuration.storageDestinationId;
    if (!destinationId)
      throw new AppError(
        "Choose an artifact storage destination for this workflow",
        409,
        "ACTIONS_STORAGE_UNCONFIGURED",
      );
    // Also validates current destination ownership/capabilities before reserving bytes.
    await this.ports.store(ctx.run.organizationId, destinationId);
    const requestedExpiry =
      typeof expires === "string" ? Date.parse(expires) : Date.now() + 7 * DAY;
    if (!Number.isFinite(requestedExpiry) || requestedExpiry <= Date.now())
      throw invalid("Invalid artifact retention date");
    return this.ports.repo.reserve(
      {
        organizationId: ctx.run.organizationId,
        runId: ctx.run.id,
        jobId: ctx.job.id,
        destinationId,
        kind,
        repository: `${ctx.run.configuration.owner}/${ctx.run.configuration.repo}`,
        ref: ctx.run.ref,
        name: string(name),
        version,
        key: `openship-actions/${ctx.run.organizationId}/${ctx.run.id}/${randomUUID()}`,
        // One final object + up to three attempts' worth of chunks are accounted for.
        maxBytes,
        reservedBytes: Math.max(1, maxBytes) * 4,
        expiresAt: new Date(Math.min(requestedExpiry, Date.now() + 30 * DAY)),
      },
      ORG_QUOTA,
      1000,
    );
  }

  private async url(
    ctx: ActionStorageContext,
    object: ActionStorageObject,
    purpose: "upload" | "download",
  ) {
    const token = await this.ports.tokens.issue(
      {
        organizationId: ctx.run.organizationId,
        runId: ctx.run.id,
        jobId: ctx.job.id,
        objectId: object.id,
        purpose,
      },
      Math.max(1, Math.min(1800, ctx.identity.exp - Math.floor(Date.now() / 1000))),
    );
    return `${this.ports.baseUrl()}objects/${object.id}?token=${encodeURIComponent(token)}`;
  }

  private validateArtifactIdentity(
    ctx: ActionStorageContext,
    data: Record<string, unknown>,
    ownJob: boolean,
  ) {
    if (
      data.workflowRunBackendId !== ctx.run.id ||
      (ownJob && data.workflowJobRunBackendId !== ctx.job.id)
    )
      throw new AppError("Artifact request belongs to another job", 403, "ACTIONS_RUNTIME_SCOPE");
  }
  private async artifact(
    ctx: ActionStorageContext,
    method: string,
    data: Record<string, unknown>,
  ): Promise<Response> {
    this.validateArtifactIdentity(
      ctx,
      data,
      !["GetSignedArtifactURL", "DeleteArtifact"].includes(method),
    );
    const repo = this.ports.repo;
    if (method === "CreateArtifact") {
      if (data.version !== 4) throw invalid("Only the artifact v4 protocol is supported");
      const object = await this.reserve(
        ctx,
        "artifact",
        string(data.name, 256),
        "",
        MAX_OBJECT,
        data.expiresAt,
      );
      return json({ ok: true, signedUploadUrl: await this.url(ctx, object, "upload") });
    }
    if (method === "FinalizeArtifact") {
      const object = await repo.forJob(
        ctx.run.organizationId,
        ctx.job.id,
        "artifact",
        string(data.name, 256),
      );
      if (!object) throw missing();
      await this.finalize(object, bytes(data.size), wrapper(data.hash));
      return json({ ok: true, artifactId: String(object.id) });
    }
    const objects = await repo.artifacts(ctx.run.organizationId, ctx.run.id);
    if (method === "ListArtifacts") {
      const name = wrapper(data.nameFilter);
      const id = wrapper(data.idFilter);
      return json({
        artifacts: objects
          .filter(
            (object) =>
              (name === undefined || name === object.name) &&
              (id === undefined || String(id) === String(object.id)),
          )
          .map((object) => ({
            workflowRunBackendId: ctx.run.id,
            workflowJobRunBackendId: object.jobId,
            databaseId: String(object.id),
            name: object.name,
            size: String(object.size),
            createdAt: object.createdAt.toISOString(),
          })),
      });
    }
    const object = objects.find((object) => object.name === data.name);
    if (!object || data.workflowJobRunBackendId !== object.jobId) throw missing();
    if (method === "GetSignedArtifactURL")
      return json({ signedUrl: await this.url(ctx, object, "download") });
    if (method === "DeleteArtifact") {
      await repo.markDeleting(ctx.run.organizationId, object.id);
      // A tombstone is durable; deletion is retried even if the storage provider is down.
      try {
        await this.remove(object);
      } catch (error) {
        this.ports.reportError(error, object.id);
      }
      return json({ ok: true, artifactId: String(object.id) });
    }
    throw invalid("Unsupported artifact operation");
  }

  private async lookupCache(ctx: ActionStorageContext, keys: string[], version: string) {
    if (!keys.length || keys.length > 10) throw invalid("Specify 1–10 cache keys");
    keys.forEach((key) => string(key));
    const refs = [...new Set([ctx.run.ref, `refs/heads/${ctx.run.configuration.defaultBranch}`])];
    const destination = ctx.run.configuration.storageDestinationId;
    if (!destination) return null;
    const rows = await this.ports.repo.candidates(
      ctx.run.organizationId,
      `${ctx.run.configuration.owner}/${ctx.run.configuration.repo}`,
      destination,
      refs,
      string(version, 256),
    );
    for (const ref of refs)
      for (const key of keys) {
        const match =
          rows.find((row) => row.ref === ref && row.name === key) ??
          rows.find((row) => row.ref === ref && row.name.startsWith(key));
        if (match) return match;
      }
    return null;
  }
  private async cacheV2(
    ctx: ActionStorageContext,
    method: string,
    data: Record<string, unknown>,
  ): Promise<Response> {
    const key = string(data.key);
    const version = string(data.version, 256);
    if (method === "CreateCacheEntry") {
      try {
        const object = await this.reserve(ctx, "cache", key, version);
        return json({ ok: true, signedUploadUrl: await this.url(ctx, object, "upload") });
      } catch (error) {
        if (error instanceof AppError && error.code === "ACTIONS_STORAGE_CONFLICT")
          return json({ ok: false, message: error.message });
        throw error;
      }
    }
    if (method === "FinalizeCacheEntryUpload") {
      const object = await this.ports.repo.forJob(
        ctx.run.organizationId,
        ctx.job.id,
        "cache",
        key,
        version,
      );
      if (!object) throw missing();
      await this.finalize(object, bytes(data.sizeBytes));
      return json({ ok: true, entryId: String(object.id) });
    }
    if (method === "GetCacheEntryDownloadURL") {
      const restore = data.restoreKeys ?? [];
      if (!Array.isArray(restore)) throw invalid("Invalid cache restore keys");
      const object = await this.lookupCache(
        ctx,
        [key, ...restore.map((value) => string(value))],
        version,
      );
      return object
        ? json({
            ok: true,
            matchedKey: object.name,
            signedDownloadUrl: await this.url(ctx, object, "download"),
          })
        : json({ ok: false });
    }
    throw invalid("Unsupported cache operation");
  }

  private async cacheV1(ctx: ActionStorageContext, request: Request, url: URL): Promise<Response> {
    if (request.method === "GET" && /\/_apis\/artifactcache\/cache$/.test(url.pathname)) {
      const object = await this.lookupCache(
        ctx,
        (url.searchParams.get("keys") ?? "").split(","),
        string(url.searchParams.get("version"), 256),
      );
      return object
        ? json({
            cacheKey: object.name,
            scope: object.ref,
            creationTime: object.createdAt.toISOString(),
            archiveLocation: await this.url(ctx, object, "download"),
          })
        : new Response(null, { status: 204 });
    }
    if (request.method === "POST" && /\/_apis\/artifactcache\/caches$/.test(url.pathname)) {
      const data = await body(request);
      const object = await this.reserve(
        ctx,
        "cache",
        string(data.key),
        string(data.version, 256),
        data.cacheSize === undefined ? MAX_OBJECT : bytes(data.cacheSize),
      );
      return json({ cacheId: object.id }, 201);
    }
    const match = url.pathname.match(/\/_apis\/artifactcache\/caches\/(\d+)$/);
    if (!match) throw missing();
    const object = await this.ports.repo.get(ctx.run.organizationId, Number(match[1]));
    if (!object || object.jobId !== ctx.job.id || object.kind !== "cache") throw missing();
    if (request.method === "PATCH") {
      const range = request.headers.get("content-range")?.match(/^bytes (\d+)-(\d+)\/\*$/);
      if (!range) throw invalid("Cache upload requires a byte range");
      const start = bytes(range[1]),
        end = bytes(range[2]);
      if (end < start) throw invalid("Invalid cache byte range");
      await this.uploadChunk(object, `${start}:${end}`, request, end - start + 1);
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST") {
      const size = bytes((await body(request)).size);
      if (object.state === "complete" || object.state === "uploaded") {
        await this.finalize(object, size);
        return new Response(null, { status: 204 });
      }
      const chunks = await this.ports.repo.chunks(object.organizationId, object.id);
      const latest = new Map(
        chunks
          .filter((chunk) => chunk.kind === "part" && chunk.state === "complete")
          .map((chunk) => [chunk.name, chunk]),
      );
      const ordered = [...latest.values()].sort(
        (a, b) => Number(a.name.split(":")[0]) - Number(b.name.split(":")[0]),
      );
      let next = 0;
      for (const chunk of ordered) {
        const [start, end] = chunk.name.split(":").map(Number);
        if (start !== next || end! - start! + 1 !== chunk.size)
          throw invalid("Cache chunks are incomplete or overlapping");
        next += chunk.size;
      }
      if (next !== size) throw invalid("Cache size does not match uploaded chunks");
      await this.assemble(
        object,
        ordered.map((chunk) => chunk.name),
      );
      await this.finalize((await this.ports.repo.get(object.organizationId, object.id))!, size);
      return new Response(null, { status: 204 });
    }
    throw invalid("Unsupported cache operation");
  }

  private async objectRequest(request: Request, url: URL): Promise<Response> {
    const upload = request.method === "PUT";
    if (!upload && !["GET", "HEAD"].includes(request.method))
      throw invalid("Unsupported object operation");
    const identity = await this.ports.tokens.verify(
      url.searchParams.get("token") ?? undefined,
      upload ? "upload" : ["download", "user-download"],
    );
    const ctx = await this.ports.authorize(identity);
    const id = Number(url.pathname.split("/").at(-1));
    if (identity.objectId !== id) throw missing();
    const object = await this.ports.repo.get(identity.organizationId, id);
    if (
      !object ||
      object.destinationId !== ctx.run.configuration.storageDestinationId ||
      object.state === "deleting" ||
      object.expiresAt <= new Date()
    )
      throw missing();
    if (upload) {
      if (object.jobId !== ctx.job.id) throw missing();
      const comp = url.searchParams.get("comp")?.toLowerCase();
      if (comp === "blocklist") {
        const xml = await readSmall(request);
        if (/<!|&/.test(xml)) throw invalid("Invalid block list");
        const matches = [
          ...xml.matchAll(/<(Latest|Uncommitted|Committed)>([A-Za-z0-9+/=]+)<\/\1>/g),
        ];
        const stripped = xml
          .replace(/^\s*<\?xml[^?]*\?>\s*/, "")
          .replace(/<(Latest|Uncommitted|Committed)>[A-Za-z0-9+/=]+<\/\1>/g, "")
          .replace(/\s/g, "");
        if (stripped !== "<BlockList></BlockList>" || !matches.length || matches.length > 1024)
          throw invalid("Invalid block list");
        await this.assemble(
          object,
          matches.map((match) => `azure:${match[2]}`),
        );
      } else if (comp === "block" || !comp) {
        const block = comp ? `azure:${string(url.searchParams.get("blockid"), 128)}` : "single";
        const size = bytes(request.headers.get("content-length"), MAX_CHUNK);
        await this.uploadChunk(object, block, request, size);
        if (!comp) await this.assemble(object, [block]);
      } else throw invalid("Unsupported blob operation");
      return new Response(null, {
        status: 201,
        headers: {
          ETag: `"${id}"`,
          "x-ms-request-id": randomUUID(),
          "x-ms-version": "2023-11-03",
          "last-modified": new Date().toUTCString(),
        },
      });
    }
    if (object.state !== "complete" || object.size === null || !object.finalKey) throw missing();
    const allowed =
      object.kind === "artifact"
        ? object.runId === ctx.run.id
        : !ctx.run.untrusted &&
          object.repository === `${ctx.run.configuration.owner}/${ctx.run.configuration.repo}` &&
          [ctx.run.ref, `refs/heads/${ctx.run.configuration.defaultBranch}`].includes(object.ref);
    if (!allowed || (identity.purpose === "user-download" && object.kind !== "artifact"))
      throw missing();
    let range: { start: number; end: number } | undefined;
    const requested = request.headers.get("range");
    if (requested) {
      const parsed = requested.match(/^bytes=(\d+)-(\d*)$/);
      if (!parsed) return new Response(null, { status: 416 });
      range = { start: bytes(parsed[1]), end: parsed[2] ? bytes(parsed[2]) : object.size - 1 };
      range.end = Math.min(range.end, object.size - 1);
      if (range.start > range.end)
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${object.size}` },
        });
    }
    const headers = {
      "content-type": "application/octet-stream",
      "content-length": String(range ? range.end - range.start + 1 : object.size),
      "accept-ranges": "bytes",
      ETag: `"${object.sha256}"`,
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${object.kind}-${object.id}${object.kind === "artifact" ? ".zip" : ".tar"}"`,
      ...(range && { "content-range": `bytes ${range.start}-${range.end}/${object.size}` }),
    };
    if (request.method === "HEAD")
      return new Response(null, { status: range ? 206 : 200, headers });
    const store = await this.ports.store(object.organizationId, object.destinationId);
    const stream = await store.get(object.finalKey, { range });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers,
    });
  }

  private async uploadChunk(
    object: ActionStorageObject,
    name: string,
    request: Request,
    size: number,
  ) {
    bytes(size, MAX_CHUNK);
    const row = await this.ports.repo.addChunk(object.organizationId, object.id, name, size);
    const store = await this.ports.store(object.organizationId, object.destinationId);
    const input = request.body ? Readable.fromWeb(request.body as never) : Readable.from([]);
    const hash = createHash("sha256");
    let read = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        read += chunk.length;
        if (read > size) return callback(invalid("Upload exceeds its declared size"));
        hash.update(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        callback(read !== size ? invalid("Upload is incomplete") : null);
      },
    });
    const timer = setTimeout(
      () => input.destroy(new Error("Actions upload timed out")),
      5 * 60_000,
    );
    timer.unref?.();
    input.on("error", (error) => {
      // diagnostics-ignore: stream failure propagates to the awaited storage write and API error handler.
      counter.destroy(error);
    });
    try {
      await store.put(row.key, input.pipe(counter), {
        size,
        contentType: "application/octet-stream",
      });
      await this.ports.repo.completeChunk(object.organizationId, row.id, hash.digest("hex"));
    } finally {
      clearTimeout(timer);
      input.destroy();
      counter.destroy();
    }
  }

  private async assemble(object: ActionStorageObject, names: string[]) {
    const current = await this.ports.repo.get(object.organizationId, object.id);
    if (current?.state === "uploaded" || current?.state === "complete") return;
    if (new Set(names).size !== names.length) throw invalid("Repeated blob blocks");
    const chunks = await this.ports.repo.chunks(object.organizationId, object.id);
    const latest = new Map(
      chunks
        .filter((chunk) => chunk.kind === "part" && chunk.state === "complete")
        .map((chunk) => [chunk.name, chunk]),
    );
    const selected = names.map((name) => latest.get(name));
    if (selected.some((chunk) => !chunk)) throw invalid("Some upload blocks are missing");
    const total = selected.reduce((sum, chunk) => sum + chunk!.size, 0);
    if (total > object.maxBytes)
      throw new AppError("Artifact or cache exceeds 1 GiB", 413, "ACTIONS_UPLOAD_TOO_LARGE");
    const attempt = await this.ports.repo.beginAssembly(object.organizationId, object.id, total);
    if (!attempt)
      throw new AppError(
        "This upload is being finalized; retry shortly",
        409,
        "ACTIONS_UPLOAD_BUSY",
      );
    const store = await this.ports.store(object.organizationId, object.destinationId);
    const hash = createHash("sha256");
    const stream = Readable.from(
      (async function* () {
        for (const chunk of selected) {
          const part = await store.get(chunk!.key);
          const partHash = createHash("sha256");
          let size = 0;
          try {
            for await (const value of part) {
              size += value.length;
              if (size > chunk!.size) throw invalid("Stored block size changed");
              partHash.update(value);
              hash.update(value);
              yield value;
            }
          } finally {
            part.destroy();
          }
          if (size !== chunk!.size || partHash.digest("hex") !== chunk!.sha256)
            throw invalid("Stored block integrity verification failed");
        }
      })(),
    );
    const timer = setTimeout(
      () => stream.destroy(new Error("Actions finalization timed out")),
      10 * 60_000,
    );
    timer.unref?.();
    try {
      await store.put(attempt.key, stream, {
        size: total,
        contentType: object.kind === "artifact" ? "application/zip" : "application/octet-stream",
      });
      if (
        !(await this.ports.repo.uploaded(
          object.organizationId,
          object.id,
          attempt.id,
          hash.digest("hex"),
        ))
      )
        throw new AppError("Upload finalization was superseded", 409, "ACTIONS_UPLOAD_CLOSED");
    } catch (error) {
      await this.ports.repo.releaseAssembly(object.organizationId, object.id, attempt.id);
      throw error;
    } finally {
      clearTimeout(timer);
      stream.destroy();
    }
  }
  private async finalize(object: ActionStorageObject, size: number, declaredHash?: unknown) {
    if (!["uploaded", "complete"].includes(object.state) || object.size !== size)
      throw invalid("Uploaded artifact size does not match finalization");
    if (
      declaredHash !== undefined &&
      (typeof declaredHash !== "string" || declaredHash.replace(/^sha256:/, "") !== object.sha256)
    )
      throw invalid("Uploaded artifact digest does not match finalization");
    if (
      object.state !== "complete" &&
      !(await this.ports.repo.complete(object.organizationId, object.id))
    )
      throw new AppError("This upload is no longer writable", 409, "ACTIONS_UPLOAD_CLOSED");
    try {
      await this.removeParts(object);
    } catch (error) {
      this.ports.reportError(error, object.id);
    }
  }

  private async safeChunks(object: ActionStorageObject) {
    if (object.leaseUntil && object.leaseUntil > new Date())
      throw new Error("Actions object finalization is still leased");
    const chunks = await this.ports.repo.chunks(object.organizationId, object.id);
    if (
      chunks.some(
        (chunk) =>
          chunk.state === "pending" && Date.now() - chunk.createdAt.getTime() < 20 * 60_000,
      )
    )
      throw new Error("Actions chunk upload may still be in progress");
    return chunks;
  }
  async removeParts(object: ActionStorageObject) {
    const chunks = await this.safeChunks(object);
    if (!chunks.length) return;
    const store = await this.ports.store(object.organizationId, object.destinationId);
    for (const chunk of chunks) if (chunk.key !== object.finalKey) await store.delete(chunk.key);
    await this.ports.repo.removeChunks(object.organizationId, object.id);
  }
  async remove(object: ActionStorageObject) {
    await this.ports.repo.markDeleting(object.organizationId, object.id);
    const current = (await this.ports.repo.get(object.organizationId, object.id))!;
    const chunks = await this.safeChunks(current);
    const store = await this.ports.store(object.organizationId, object.destinationId);
    for (const key of new Set([
      ...(object.finalKey ? [object.finalKey] : []),
      ...chunks.map((chunk) => chunk.key),
    ]))
      await store.delete(key);
    await this.ports.repo.remove(object.organizationId, object.id);
  }
  async sweep() {
    for (const object of await this.ports.repo.expired()) {
      try {
        await this.remove(object);
      } catch (error) {
        this.ports.reportError(error, object.id);
      }
    }
    for (const object of await this.ports.repo.completeWithChunks()) {
      try {
        await this.removeParts(object);
      } catch (error) {
        this.ports.reportError(error, object.id);
      }
    }
  }
}
