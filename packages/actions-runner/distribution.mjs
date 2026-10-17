/** Build-time OCI transport. Installed products use only the embedded workers. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const maximumLayer = 256 * 1024 * 1024;
const maximumExpandedLayer = 1024 * 1024 * 1024;
const mediaTypes = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const layerTypes = [
  "application/vnd.oci.image.layer.v1.tar+gzip",
  "application/vnd.docker.image.rootfs.diff.tar.gzip",
];

export function validateRunnerArtifact(value) {
  if (
    value?.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.source) ||
    !/^ghcr\.io\/[a-z0-9_.-]+\/[a-z0-9_.-]+@sha256:[a-f0-9]{64}$/.test(value.image)
  )
    throw new Error("Invalid pinned Actions worker release");
  return value;
}

async function bytes(response, maximum) {
  if (!response.ok) throw new Error(`Actions worker registry returned HTTP ${response.status}`);
  if (!response.body) throw new Error("Actions worker registry returned an empty response");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximum) throw new Error("Actions worker registry response is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** No Docker CLI, Go toolchain, or product runtime credentials are needed. */
export async function installRunnerArtifact(
  descriptor,
  destination,
  { verify, fetchImpl = fetch, names },
) {
  validateRunnerArtifact(descriptor);
  const [repository, imageDigest] = descriptor.image.slice("ghcr.io/".length).split("@");
  const registry = `https://ghcr.io/v2/${repository}`;
  let authorization;
  const request = async (url, accept) => {
    const headers = {
      ...(accept ? { Accept: accept } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    };
    let response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (response.status === 401 && !authorization) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      await response.body?.cancel();
      const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
      const service = /service="([^"]+)"/.exec(challenge)?.[1];
      const scope = /scope="([^"]+)"/.exec(challenge)?.[1];
      // Credentials are anonymous and scoped to this public package only.
      if (
        !challenge.startsWith("Bearer ") ||
        realm !== "https://ghcr.io/token" ||
        service !== "ghcr.io" ||
        scope !== `repository:${repository}:pull`
      )
        throw new Error("Unexpected Actions worker registry authentication challenge");
      const tokenUrl = new URL(realm);
      tokenUrl.search = new URLSearchParams({ service, scope }).toString();
      const token = JSON.parse(
        await bytes(await fetchImpl(tokenUrl, { signal: AbortSignal.timeout(30_000) }), 64 * 1024),
      );
      if (typeof token.token !== "string" || !token.token || token.token.length > 16_384)
        throw new Error("Actions worker registry returned an invalid pull token");
      authorization = `Bearer ${token.token}`;
      response = await fetchImpl(url, {
        headers: { ...headers, Authorization: authorization },
        signal: AbortSignal.timeout(120_000),
      });
    }
    return response;
  };
  const manifestBytes = await bytes(
    await request(`${registry}/manifests/${imageDigest}`, mediaTypes.join(", ")),
    1024 * 1024,
  );
  if (`sha256:${createHash("sha256").update(manifestBytes).digest("hex")}` !== imageDigest)
    throw new Error("Actions worker image digest verification failed");
  const manifest = JSON.parse(manifestBytes);
  const layer = manifest.layers?.[0];
  if (
    manifest.schemaVersion !== 2 ||
    !mediaTypes.includes(manifest.mediaType) ||
    manifest.layers?.length !== 1 ||
    !digestPattern.test(layer?.digest) ||
    !layerTypes.includes(layer?.mediaType) ||
    !Number.isSafeInteger(layer?.size) ||
    layer.size <= 0 ||
    layer.size > maximumLayer
  )
    throw new Error("Actions worker image must contain one verified worker archive layer");
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = mkdtempSync(join(dirname(destination), ".actions-worker-"));
  const archive = join(temporary, "layer.tar.gz");
  const staged = join(temporary, "dist");
  try {
    const response = await request(`${registry}/blobs/${layer.digest}`);
    if (!response.ok || !response.body)
      throw new Error(`Actions worker download returned HTTP ${response.status}`);
    let received = 0;
    const hash = createHash("sha256");
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        received += chunk.length;
        if (received > layer.size)
          return done(new Error("Actions worker archive exceeds its declared size"));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      meter,
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
    );
    if (received !== layer.size || `sha256:${hash.digest("hex")}` !== layer.digest)
      throw new Error("Actions worker archive digest verification failed");
    // GNU tar invokes gzip from PATH for -z; BSD tar does not. Decompress once
    // with Node so product builds need only tar, with the same behavior on both.
    const expandedArchive = join(temporary, "layer.tar");
    let expanded = 0;
    await pipeline(
      createReadStream(archive),
      createGunzip(),
      new Transform({
        transform(chunk, _encoding, done) {
          expanded += chunk.length;
          if (expanded > maximumExpandedLayer)
            return done(new Error("Actions worker archive expands beyond its size limit"));
          done(null, chunk);
        },
      }),
      createWriteStream(expandedArchive, { flags: "wx", mode: 0o600 }),
    );
    mkdirSync(staged);
    // Extract each expected member to an explicitly opened file. Even a malformed
    // archive cannot write symlinks, absolute paths or unrelated build files.
    for (const name of names) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Invalid Actions worker asset name");
      const fd = openSync(
        join(staged, name),
        "wx",
        name.startsWith("openship-actions-") ? 0o755 : 0o644,
      );
      try {
        const result = spawnSync("tar", ["-xOf", expandedArchive, `dist/${name}`], {
          stdio: ["ignore", fd, "pipe"],
          encoding: "utf8",
          timeout: 60_000,
        });
        if (result.error)
          throw new Error("Actions worker extraction requires a working tar executable", {
            cause: result.error,
          });
        if (result.status !== 0)
          throw new Error(
            `Could not extract Actions worker asset ${name}: ${result.stderr.trim().slice(0, 512)}`,
          );
      } finally {
        closeSync(fd);
      }
    }
    verify(staged);
    const previous = join(temporary, "previous");
    let moved = false;
    try {
      renameSync(destination, previous);
      moved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      renameSync(staged, destination);
    } catch (error) {
      if (moved) renameSync(previous, destination);
      throw error;
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
