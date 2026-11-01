import type { CommandExecutor } from "../types";
import { diagnostics } from "@repo/core/diagnostics";
import { sq } from "./build-pipeline";

export const SOFTWARE_CACHE_ROOT = "/opt/oblien/build-cache";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
interface SoftwareImage {
  path: string;
  digest: string;
  image: string;
  sourceDigest: string;
}

/** Only literal native-platform FROMs are candidates. Complex Dockerfiles keep
 * normal resolution; an optimization must never change their platform/frontend. */
export function softwareImageCandidates(raw: string): Array<SoftwareImage & { reference: string }> {
  if (!raw.trim()) return [];
  const data = JSON.parse(raw) as {
    pack?: { version?: unknown; platform?: unknown; images?: SoftwareImage[] };
    platform?: unknown;
    dockerfile?: unknown;
  };
  const pack = data?.pack;
  if (
    pack?.version !== 2 ||
    pack.platform !== data.platform ||
    !["linux/amd64", "linux/arm64"].includes(String(pack.platform)) ||
    !Array.isArray(pack.images) ||
    pack.images.length > 8 ||
    typeof data.dockerfile !== "string" ||
    pack.images.some(
      (entry) =>
        !entry ||
        typeof entry.path !== "string" ||
        !/^images\/[a-z0-9][a-z0-9-]{0,100}$/.test(entry.path) ||
        typeof entry.image !== "string" ||
        !/^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry.image) ||
        !digestPattern.test(entry.digest) ||
        !digestPattern.test(entry.sourceDigest),
    )
  )
    throw new Error("Unsupported build software image manifest");
  const dockerfile = data.dockerfile;
  if (
    /^\s*#\s*syntax\s*=/im.test(dockerfile) ||
    /^\s*FROM\s+.*(?:--platform|\\)/im.test(dockerfile)
  )
    return [];
  const references = new Set(
    [
      ...dockerfile.matchAll(/^\s*FROM[ \t]+([^\s]+)(?:[ \t]+AS[ \t]+[a-zA-Z0-9_.-]+)?[ \t]*$/gim),
    ].map((match) => match[1]!),
  );
  const normalize = (reference: string) =>
    reference.replace(/^(?:docker\.io\/|index\.docker\.io\/)/, "").replace(/^library\//, "");
  return [...references].flatMap((reference) => {
    const [ref, pinnedDigest] = reference.split("@");
    const entry = pack.images!.find((image) =>
      normalize(image.image) === normalize(ref!) && (!pinnedDigest || pinnedDigest === image.sourceDigest),
    );
    return entry ? [{ ...entry, reference }] : [];
  });
}

export function readSoftwareCacheCommand(dockerfile: string): string {
  return `python3 - ${sq(dockerfile)} <<'OPENSHIP_CACHE_PY'
import json, os, subprocess, sys
root = '${SOFTWARE_CACHE_ROOT}'
mount = subprocess.run(['findmnt', '-rn', '--mountpoint', root, '-o', 'OPTIONS'], capture_output=True, text=True)
if mount.returncode == 0 and 'ro' in mount.stdout.strip().split(','):
    def bounded(path, limit):
        with open(path, 'rb') as source:
            data = source.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Software metadata exceeds limit')
        return data.decode('utf-8')
    pack = json.loads(bounded(root + '/manifest.json', 65536))
    for entry in pack['images']:
        layout = os.path.realpath(root + '/' + entry['path'])
        if not layout.startswith(root + '/images/'):
            raise ValueError('Software path escapes image directory')
        for path in ['oci-layout', 'index.json', 'blobs/sha256/' + entry['digest'].removeprefix('sha256:')]:
            file = os.path.realpath(layout + '/' + path)
            if not file.startswith(layout + '/') or not os.path.isfile(file):
                raise ValueError('Software image is incomplete')
        manifest = json.loads(bounded(layout + '/blobs/sha256/' + entry['digest'].removeprefix('sha256:'), 1048576))
        for blob in [manifest['config'], *manifest['layers']]:
            file = os.path.realpath(layout + '/blobs/sha256/' + blob['digest'].removeprefix('sha256:'))
            if not file.startswith(layout + '/blobs/sha256/') or not os.path.isfile(file) or os.stat(file).st_size != blob['size']:
                raise ValueError('Software image has a missing blob')
    machine = os.uname().machine
    platform = {'x86_64':'linux/amd64', 'aarch64':'linux/arm64'}.get(machine)
    print(json.dumps({'pack':pack, 'platform':platform, 'dockerfile':bounded(sys.argv[1], 1048576)}))
OPENSHIP_CACHE_PY`;
}

/** Revalidate mutable tags against their current registry digest. Missing packs,
 * changed tags, and unavailable metadata use normal registry resolution. No
 * source image, writable Docker DB, or private build cache is substituted. */
export async function readSoftwareCache(
  executor: CommandExecutor,
  dockerfile: string,
  signal?: AbortSignal,
): Promise<{ args: string; unavailable: boolean }> {
  try {
    signal?.throwIfAborted();
    const raw = await executor.exec(readSoftwareCacheCommand(dockerfile), { timeout: 5_000 });
    if (!raw.trim()) return { args: "", unavailable: true };
    const candidates = softwareImageCandidates(raw);
    const args: string[] = [];
    for (const entry of candidates) {
      signal?.throwIfAborted();
      const current = await executor.exec(
        `docker buildx imagetools inspect ${sq(entry.image)} --format '{{.Manifest.Digest}}'`,
        { timeout: 10_000 },
      );
      if (current.trim() === entry.sourceDigest)
        args.push(
          ` --build-context ${sq(`${entry.reference}=oci-layout://${SOFTWARE_CACHE_ROOT}/${entry.path}@${entry.digest}`)}`,
        );
    }
    signal?.throwIfAborted();
    return { args: args.join(""), unavailable: false };
  } catch (error) {
    signal?.throwIfAborted();
    diagnostics.warn(
      "adapters/runtime/docker-software-cache",
      "Shared public build images unavailable; using normal registry resolution",
      error,
    );
    return { args: "", unavailable: true };
  }
}
