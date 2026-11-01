import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { buildCatalog } from "../packages/core/scripts/gen-catalog";
import { runAppPrepareCommand } from "../packages/platform/src/engine/modules/deployments/compose/app-prepare";

const run = promisify(execFile);
const docker = async (...args: string[]) =>
  (
    await run("docker", args, {
      timeout: 180_000,
      maxBuffer: 2 * 1024 * 1024,
    })
  ).stdout.trim();

/** Exercises the actual catalog image, argv and preparation hook on a disposable
 * volume. Credentials belong only to this test; no production API is involved. */
export async function smokeMinio(): Promise<void> {
  const app = buildCatalog().apps.find((app) => app.id === "minio")!;
  const service = app.services![0]!;
  const step = app.prepare![0]!;
  const name = "openship-minio-smoke-" + randomUUID();
  const volume = name + "-data";
  const marker = randomUUID();
  const platform = process.env.CATALOG_TEST_PLATFORM;
  let volumeCreated = false;
  const start = async () => {
    await docker(
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "openship.test=catalog-minio",
      "--memory",
      "512m",
      "--cpus",
      "0.5",
      "--network",
      "none",
      ...(platform ? ["--platform", platform] : []),
      "--mount",
      "type=volume,source=" + volume + ",target=/data",
      "-e",
      "MINIO_ROOT_USER=openship-smoke",
      "-e",
      "MINIO_ROOT_PASSWORD=smoke-" + marker,
      "-e",
      "OPENSHIP_BUCKET=uploads",
      "-e",
      "OPENSHIP_SMOKE_MARKER=" + marker,
      service.image!,
      ...service.commandArgv!,
    );
    const prepared = await runAppPrepareCommand(step, {
      exec: async (command, options) =>
        (
          await run("docker", ["exec", name, "sh", "-c", command], {
            timeout: options?.timeout,
            maxBuffer: 2 * 1024 * 1024,
          })
        ).stdout,
    });
    if (prepared !== "uploads") throw new Error("Catalog bucket setup did not succeed");
    await docker("exec", name, "sh", "-c", "mc ready local >/dev/null");
    // Test the web console as well as S3: a running container is not sufficient.
    await docker("exec", name, "sh", "-c", "wget -q -O /dev/null http://127.0.0.1:9001/");
  };
  try {
    await docker("pull", ...(platform ? ["--platform", platform] : []), service.image!);
    await docker("volume", "create", "--label", "openship.test=catalog-minio", volume);
    volumeCreated = true;
    await start();
    await docker(
      "exec",
      name,
      "sh",
      "-c",
      "printf '%s' \"$OPENSHIP_SMOKE_MARKER\" | mc pipe local/uploads/persist.txt >/dev/null",
    );
    await docker("rm", "-f", name);
    await start();
    if ((await docker("exec", name, "sh", "-c", "mc cat local/uploads/persist.txt")) !== marker)
      throw new Error("Object did not survive container replacement");
    console.log("MinIO: catalog setup, console, authenticated S3 and persisted object passed");
  } finally {
    await docker("rm", "-f", name).catch(() => {});
    if (volumeCreated) await docker("volume", "rm", volume).catch(() => {});
  }
}

if (import.meta.main) {
  try {
    await smokeMinio();
  } catch (error) {
    // Child-process errors can include ephemeral credentials from argv.
    console.error(
      error instanceof Error && !("cmd" in error)
        ? error.message
        : "MinIO smoke failed; inspect the failing Docker operation",
    );
    process.exitCode = 1;
  }
}
