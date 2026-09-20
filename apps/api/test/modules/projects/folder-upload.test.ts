import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { installFakeRunner, seedOwner, type SeededOwner } from "../jobs/_harness";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { archiveSourceDirectory } from "@repo/platform/source-files";
import {
  deleteFolderSession,
  getFolderSession,
} from "@repo/platform/engine/modules/projects/folder/session-store";
import type { FolderSessionResult } from "@repo/contracts";

installFakeRunner();
const app = new Hono().onError(handleApiError).route("/api/projects", projectRoutes);
const sessions: string[] = [];
let root: string, scratch: string, origin: string;
let owner: SeededOwner;
let server: ReturnType<typeof serve>;
let archive: Buffer, digest: string;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "openship-upload-http-test-"));
  scratch = join(root, "staging");
  const source = join(root, "input");
  await mkdir(source);
  await mkdir(scratch);
  vi.stubEnv("TMPDIR", scratch);
  vi.stubEnv("OPENSHIP_NATIVE", "false");
  // Incompressible bytes ensure the gzip itself crosses the reported 10 MiB
  // boundary, rather than merely expanding to that size after extraction.
  const payload = randomBytes(12 * 1024 * 1024);
  digest = sha256(payload);
  await writeFile(join(source, "payload.bin"), payload);
  const packed = await archiveSourceDirectory(source, { temporaryRoot: join(root, "archives") });
  try {
    archive = await readFile(packed.path);
  } finally {
    await packed.dispose();
  }
  expect(archive.byteLength).toBeGreaterThan(10 * 1024 * 1024);
  owner = await seedOwner();
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  origin = `http://127.0.0.1:${address.port}`;
}, 30_000);

afterEach(async () => {
  for (const id of sessions.splice(0)) {
    const session = deleteFolderSession(id);
    if (session?.stagingDir) await rm(session.stagingDir, { recursive: true, force: true });
  }
});
afterAll(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

async function open() {
  const response = await fetch(`${origin}/api/projects/folder/session`, {
    method: "POST",
    headers: { ...owner.auth, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(200);
  const target = (await response.json()) as FolderSessionResult;
  sessions.push(target.sessionId);
  expect(target.upload.absoluteUrl).toBe(
    `${origin}/api/projects/folder/upload/${target.sessionId}`,
  );
  return target;
}

function upload(target: FolderSessionResult, bytes = archive, chunked = false) {
  const body = chunked
    ? Readable.toWeb(
        Readable.from(
          (function* () {
            for (let offset = 0; offset < bytes.length; offset += 64 * 1024)
              yield bytes.subarray(offset, offset + 64 * 1024);
          })(),
        ),
      )
    : new Blob([new Uint8Array(bytes)]);
  return fetch(target.upload.absoluteUrl, {
    method: "POST",
    headers: { ...owner.auth, ...target.upload.headers },
    body,
    duplex: "half",
    signal: AbortSignal.timeout(15_000),
  } as RequestInit);
}

describe("authenticated folder upload over HTTP", () => {
  it.each([false, true])("preserves every byte above 10 MiB (chunked: %s)", async (chunked) => {
    const target = await open();
    const response = await upload(target, archive, chunked);
    expect(response.status, await response.text()).toBe(200);
    const session = getFolderSession(target.sessionId)!;
    expect(session.uploaded).toBe(true);
    expect(sha256(await readFile(join(session.stagingDir!, "payload.bin")))).toBe(digest);
    expect(await readdir(scratch)).toEqual([basename(session.stagingDir!)]);
    const duplicate = await upload(target);
    expect(duplicate.status).toBe(409);
    await duplicate.body?.cancel();
  });

  it("rejects a truncated gzip, cleans temporary files, and allows a complete retry", async () => {
    const target = await open();
    const response = await upload(target, archive.subarray(0, 10 * 1024 * 1024));
    expect(response.status, await response.text()).toBe(400);
    const session = getFolderSession(target.sessionId)!;
    expect(session.uploaded).toBe(false);
    expect(session.uploading).toBe(false);
    expect(await readdir(session.stagingDir!)).toEqual([]);
    expect(await readdir(scratch)).toEqual([basename(session.stagingDir!)]);
    const retry = await upload(target);
    expect(retry.status, await retry.text()).toBe(200);
    expect(sha256(await readFile(join(session.stagingDir!, "payload.bin")))).toBe(digest);
  });

  it("returns 413 for a declared body above the documented 300 MB limit", async () => {
    const target = await open();
    // Exercise the actual route's early header rejection without transmitting
    // 300 MB or lying to the socket client's own Content-Length validator.
    const response = await app.request(target.upload.absoluteUrl, {
      method: "POST",
      headers: { ...owner.auth, ...target.upload.headers, "Content-Length": "300000001" },
      body: new Uint8Array(),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    const session = getFolderSession(target.sessionId)!;
    expect(session.uploaded).toBe(false);
    expect(await readdir(session.stagingDir!)).toEqual([]);
  });
});
