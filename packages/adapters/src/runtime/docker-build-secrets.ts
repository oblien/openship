import { createHash } from "node:crypto";
import { isValidEnvKey, shellQuote } from "@repo/core";
import { providerFailureMessage } from "@repo/core/diagnostics";
import type { BuildConfig, CommandExecutor } from "../types";

// PATH must stay image-owned (including node_modules/.bin); forced colour breaks
// machine-readable build output. Apply the same policy to every generated recipe.
const EXCLUDED = new Set(["FORCE_COLOR", "TERM", "PATH"]);
const TARGET = "/run/secrets/openship-build-env";

function secretId(config: Pick<BuildConfig, "sessionId">): string {
  // BuildKit deliberately excludes secret contents from its cache key. An opaque
  // attempt ID re-runs environment-dependent steps without publishing a digest of
  // guessable credentials. Package download caches remain reusable.
  return `openship-env-${createHash("sha256").update(config.sessionId).digest("hex")}`;
}

/** No value enters a Dockerfile, build argument, context archive or image history. */
export function buildEnvMount(config: BuildConfig): string {
  // Custom builder images may declare USER. The mount is private to this RUN,
  // so allow that build user to read it without granting host access.
  return `--mount=type=secret,id=${secretId(config)},target=${TARGET},mode=0444,required=true `;
}

export const BUILD_ENV_SOURCE = `set +x && . ${TARGET} && `;

export function dockerBuildSecrets(config: BuildConfig): ReadonlyMap<string, string> {
  const env = Object.fromEntries(
    Object.entries(config.envVars).filter(([key]) => isValidEnvKey(key) && !EXCLUDED.has(key)),
  );
  if (Object.values(env).some((value) => value.includes("\0")))
    throw new Error("Build environment values cannot contain NUL bytes.");
  if (!env.NO_COLOR) env.NO_COLOR = "1";
  const content =
    Object.entries(env)
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join("\n") + "\n";
  // Matches BuildKit's secrets provider limit, before opening a session or writing
  // anything remotely. Never include the rejected payload in an error.
  if (Buffer.byteLength(content) > 500 * 1024)
    throw new Error("The build environment exceeds BuildKit's 500 KiB secret limit.");
  return new Map([[secretId(config), content]]);
}

/** CLI transport for the same secret payload the Engine API serves over gRPC. */
export async function withDockerBuildSecrets<T>(
  executor: CommandExecutor,
  secrets: ReadonlyMap<string, string>,
  run: (flags: string, cleanupCommand: string) => Promise<T>,
): Promise<T> {
  if (!secrets.size) return run("", "");
  const dir = (await executor.exec("mktemp -d /tmp/openship-build-secrets.XXXXXXXXXX")).trim();
  if (!/^\/tmp\/openship-build-secrets\.[A-Za-z0-9]+$/.test(dir))
    throw new Error("Could not create a private directory for build secrets.");
  const cleanup = `rm -rf -- ${shellQuote(dir)}`;
  try {
    const flags: string[] = [];
    let index = 0;
    for (const [id, content] of secrets) {
      const path = `${dir}/${index++}`;
      try {
        await executor.writeFile(path, content, { mode: 0o600 });
      } catch (error) {
        throw new Error(
          providerFailureMessage(error, "Could not transfer the build environment securely"),
        );
      }
      flags.push(`--secret ${shellQuote(`id=${id},src=${path}`)}`);
    }
    return await run(flags.join(" "), cleanup);
  } finally {
    await executor.exec(cleanup);
  }
}
