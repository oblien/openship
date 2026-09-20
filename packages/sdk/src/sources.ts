/** Remote source transport. Shared operations own scanning, project creation and deployment. */
import { createReadStream, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { prepareSourceDirectory, archiveSourceDirectory, assertSourceStagingOutside } from "@repo/platform/source-files";
import type { StageSourceInput, StagedSource } from "@repo/contracts";
import type { HttpClient } from "./http";
import { requestSourceSession } from "./source-client";

function detectPackageManager(dir: string): string | undefined {
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "package.json"))) return "npm";
  return undefined;
}
function detectStack(dir: string): string | undefined {
  if (existsSync(join(dir, "go.mod"))) return "go";
  if (existsSync(join(dir, "Cargo.toml"))) return "rust";
  if (existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "pyproject.toml"))) return "python";
  if (existsSync(join(dir, "package.json"))) return "node";
  return undefined;
}

export async function stageRemoteSource(http: HttpClient, input: StageSourceInput, options: { signal?: AbortSignal; onStep?: (message: string) => void } = {}): Promise<StagedSource> {
  const { signal, onStep } = options;
  signal?.throwIfAborted();
  const source = await prepareSourceDirectory(input.source, {
    signal,
    validatePath: async path => (await assertSourceStagingOutside(path)).directory,
  });
  try {
    onStep?.("Packaging folder");
    const archive = await archiveSourceDirectory(source.directory, { signal });
    try {
      // Provision only after packaging succeeds, so invalid sources cannot create
      // unused remote sessions and large archives do not consume their expiry.
      onStep?.("Creating upload session");
      const result = await requestSourceSession(http, {
        name: input.name ?? (source.temporary ? "app" : basename(source.directory)),
        projectId: input.projectId,
        packageManager: input.packageManager ?? detectPackageManager(source.directory), stack: input.stack ?? detectStack(source.directory),
      }, signal);
      const stream = createReadStream(archive.path);
      try {
        onStep?.("Uploading source");
        await http.upload(result.upload, Readable.toWeb(stream) as ReadableStream<Uint8Array>, { signal, duplex: "half" });
      } finally { stream.destroy(); }
      return { sessionId: result.sessionId, expiresAt: result.expiresAt };
    } finally { await archive.dispose(); }
  } finally { await source.dispose(); }
}
