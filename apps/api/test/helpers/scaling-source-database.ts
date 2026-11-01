import { randomUUID } from "node:crypto";
import {
  DockerRuntime,
  resolveExecutor,
  resolveProducerForService,
  uploadIncrementalArtifact,
  type BackupDestination,
  type RecordedBackupArtifact,
  type ServiceHandle,
} from "@repo/adapters";
import { eventually, exec, type ScalingLab } from "./scaling-lab";

/** A real pre-existing Docker database, captured by the shipped backup producer
 * and incremental uploader. No generated dump or fabricated recovery bytes. */
export async function scalingSourceDatabase(
  lab: ScalingLab,
  engine: "postgres" | "redis",
  project: { id: string; slug: string },
) {
  const image =
    engine === "postgres"
      ? "postgres:17.11-bookworm"
      : "redis:7.4.11-bookworm@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f";
  const env: Record<string, string> =
    engine === "postgres"
      ? {
          POSTGRES_USER: "app",
          POSTGRES_DB: "app",
          POSTGRES_PASSWORD: "disposable-import-password",
        }
      : {};
  const container = await lab.container({
    Image: image,
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    ...(engine === "redis" ? { Cmd: ["redis-server", "--save", "", "--appendonly", "no"] } : {}),
    HostConfig: {
      Tmpfs: { [engine === "postgres" ? "/var/lib/postgresql/data" : "/data"]: "size=256m" },
    },
  });
  const command = (args: string[]) => exec(lab.docker, container, args);
  const read = () =>
    command(
      engine === "postgres"
        ? [
            "psql",
            "-U",
            "app",
            "-d",
            "app",
            "-X",
            "-tAc",
            "SELECT value FROM acceptance WHERE id = 1",
          ]
        : ["redis-cli", "--raw", "GET", "acceptance:imported"],
    );
  try {
    await eventually(
      `the original ${engine} database`,
      () =>
        command(
          engine === "postgres"
            ? ["pg_isready", "-h", "127.0.0.1", "-U", "app", "-d", "app"]
            : ["redis-cli", "PING"],
        ),
      Boolean,
      60_000,
    );
    await command(
      engine === "postgres"
        ? [
            "psql",
            "-U",
            "app",
            "-d",
            "app",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            "CREATE TABLE acceptance (id integer PRIMARY KEY, value text NOT NULL); INSERT INTO acceptance VALUES (1, 'legacy-postgres');",
          ]
        : [
            "sh",
            "-ec",
            "redis-cli SET acceptance:imported legacy-redis; redis-cli SET acceptance:expires expiring PX 86400000; redis-cli -n 1 SET acceptance:numbered separate-database",
          ],
    );
    const service: ServiceHandle = {
      id: randomUUID(),
      projectId: project.id,
      projectSlug: project.slug,
      name: `original-${engine}`,
      image,
      env,
      volumes: [],
      containerId: container.id,
      containerRunning: true,
      namespaceVolumes: true,
    };
    return {
      container,
      read: async () => (await read()).trim(),
      async capture(destination: BackupDestination, runId: string) {
        const runtime = await DockerRuntime.create({ transport: "socket" });
        try {
          const producer = resolveProducerForService(service);
          if (producer.kind !== (engine === "postgres" ? "pg_dump" : "redis_rdb"))
            throw new Error(
              `The existing ${engine} service did not select its native backup producer.`,
            );
          const artifacts: RecordedBackupArtifact[] = [];
          for await (const artifact of producer.produce(
            service,
            resolveExecutor("docker", runtime),
            { compression: "none" },
          )) {
            artifacts.push(
              await uploadIncrementalArtifact(
                destination,
                { projectSlug: project.slug, serviceName: service.name, runId },
                artifact,
                [],
                [],
              ),
            );
          }
          if (artifacts.length !== 1)
            throw new Error("Expected one verified database backup artifact.");
          return artifacts;
        } finally {
          await runtime.dispose();
        }
      },
      // Keep the labelled container registered for the lab's final cleanup.
      dispose: () => container.stop({ t: 5 }),
    };
  } catch (error) {
    await container.stop({ t: 5 }).catch(() => {});
    throw error;
  }
}
