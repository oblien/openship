import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { MAIL_CONTAINER_MOUNTS } from "@repo/adapters";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, expect, it } from "vitest";
import { shellQuote as sq } from "@repo/core";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
for (const targetFlavor of ["host", "container"] as const) {
  const prefix = `openship-e2e-mail-backup-${targetFlavor}-${process.pid.toString(36)}`;
  const source = `${prefix}-source`;
  const target = `${prefix}-target`;
  const network = `${prefix}-net`;
  const image = "openship-mail-backup-test:1602";
  let keys = "";
  async function docker(args: string[]) {
    return exec("docker", args, { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  }

  describeDockerE2E(`mail backup and migration to a ${targetFlavor} mail engine`, () => {
    beforeAll(async () => {
      await requireDocker();
      await docker([
        "build",
        "-f",
        join(root, "apps/api/test/e2e/fixtures/mail-backup/Dockerfile"),
        "-t",
        image,
        root,
      ]);
      if (targetFlavor === "container") {
        await docker([
          "build",
          "-f",
          join(root, "apps/api/test/e2e/fixtures/mail-backup/Dockerfile.host"),
          "-t",
          "openship-mail-backup-host:1602",
          root,
        ]);
        await docker([
          "build",
          "-f",
          join(root, "apps/api/test/e2e/fixtures/mail-backup/Dockerfile.engine"),
          "-t",
          "openship-mail-backup-engine:1602",
          root,
        ]);
        await docker(["pull", "postgres:16-alpine"]);
      }
      keys = await mkdtemp(join(tmpdir(), "openship-mail-key-"));
      await exec(
        "bun",
        [
          "build",
          join(root, "apps/api/test/e2e/fixtures/mail-backup/roundtrip.ts"),
          "--target=bun",
          "--external=cpu-features",
          "--external=@electric-sql/pglite",
          `--outdir=${keys}`,
        ],
        { cwd: root },
      );
      await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(keys, "key")]);
      // Both hosts are disposable; no outside SMTP/DNS or host Docker socket.
      await docker(["network", "create", "--internal", network]);
      for (const name of [source, target]) {
        await docker([
          "run",
          "-d",
          "--name",
          name,
          "--hostname",
          "mail.example.test",
          "--privileged",
          "--cgroupns=private",
          "--tmpfs",
          "/run",
          "--tmpfs",
          "/run/lock",
          "--network",
          network,
          ...(name === target ? ["--network-alias", "mail-target"] : []),
          ...(name === target && targetFlavor === "container"
            ? [
                "-v",
                `${prefix}-docker:/var/lib/docker`,
                "openship-mail-backup-host:1602",
                "--host=unix:///var/run/docker.sock",
                "--bridge=none",
                "--iptables=false",
                "--storage-driver=vfs",
              ]
            : [image]),
        ]);
        const deadline = Date.now() + 60_000;
        for (;;) {
          try {
            await docker(
              name === target && targetFlavor === "container"
                ? ["exec", name, "docker", "info"]
                : ["exec", name, "systemctl", "is-active", "--quiet", "multi-user.target"],
            );
            break;
          } catch (error) {
            if (Date.now() >= deadline) throw error;
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      if (targetFlavor === "container") {
        const save = spawn("docker", [
          "save",
          "openship-mail-backup-engine:1602",
          "postgres:16-alpine",
        ]);
        const load = spawn("docker", ["exec", "-i", target, "docker", "load"]);
        const errors: Buffer[] = [];
        save.stderr.on("data", (chunk) => errors.push(chunk));
        load.stderr.on("data", (chunk) => errors.push(chunk));
        load.stdout.resume();
        const closed = [save, load].map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code) =>
                code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString())),
              );
            }),
        );
        await Promise.all([pipeline(save.stdout, load.stdin), ...closed]);
        const command = [
          ...MAIL_CONTAINER_MOUNTS.map((mount) => `mkdir -p ${sq(mount.host)}`),
          "docker create --name mail-seed openship-mail-backup-engine:1602",
          ...MAIL_CONTAINER_MOUNTS.filter(
            (mount) => mount.seed && mount.container.startsWith("/etc/"),
          ).map((mount) => `docker cp mail-seed:${mount.container}/. ${sq(mount.host)}`),
          "docker rm mail-seed",
          "docker run -d --network host --name openship-mail-db -e POSTGRES_DB=vmail -e POSTGRES_PASSWORD=mail-fixture-db-root postgres:16-alpine",
          `docker run -d --network host --hostname mail.example.test --name openship-mail ${MAIL_CONTAINER_MOUNTS.map((mount) => `-v ${sq(`${mount.host}:${mount.container}${mount.readonly ? ":ro" : ""}`)}`).join(" ")} openship-mail-backup-engine:1602`,
          "for attempt in $(seq 1 100); do if docker exec openship-mail-db pg_isready -U postgres -d vmail >/dev/null 2>&1 && docker exec openship-mail test -S /run/supervisor.sock; then exit 0; fi; sleep 0.1; done; docker logs openship-mail >&2; docker logs openship-mail-db >&2; df -h /var/lib/docker >&2; exit 1",
        ].join("\n");
        await docker(["exec", target, "sh", "-ec", command]);
      }
      // Copy the small bundle and its portable database assets. Bind mounts would
      // require the daemon to share the checkout's filesystem (remote/Colima do not).
      await docker([
        "exec",
        source,
        "mkdir",
        "-p",
        "/workspace/node_modules/@electric-sql/pglite",
        "/workspace/apps/email/engine/samples/iredmail",
      ]);
      await docker(["cp", join(keys, "roundtrip.js"), `${source}:/workspace/roundtrip.js`]);
      await docker([
        "cp",
        `${join(root, "node_modules/@electric-sql/pglite")}/.`,
        `${source}:/workspace/node_modules/@electric-sql/pglite`,
      ]);
      await docker(["cp", join(root, "packages/db/drizzle"), `${source}:/workspace/drizzle`]);
      await docker([
        "cp",
        join(root, "apps/email/engine/samples/iredmail/iredmail.pgsql"),
        `${source}:/workspace/apps/email/engine/samples/iredmail/iredmail.pgsql`,
      ]);
      await docker(["cp", join(keys, "key"), `${source}:/tmp/mail-test-key`]);
      const publicKey = await readFile(join(keys, "key.pub"), "utf8");
      await docker([
        "exec",
        target,
        "sh",
        "-ec",
        `install -d -m 0700 /root/.ssh; printf %s ${sq(publicKey)} > /root/.ssh/authorized_keys; chmod 0600 /root/.ssh/authorized_keys; ${targetFlavor === "container" ? "/usr/sbin/sshd" : "systemctl start ssh"}`,
      ]);
      // The fixture models a bare host: PID 1 is real systemd in a private
      // cgroup namespace. Remove only this fixture's Docker marker so the normal
      // host resolver selects LocalExecutor, exactly as on the reported install.
      await docker(["exec", source, "rm", "-f", "/.dockerenv"]);
    }, 900_000);

    afterAll(async () => {
      for (const name of [source, target]) await docker(["rm", "-f", name]).catch(() => {});
      await docker(["network", "rm", network]).catch(() => {});
      if (targetFlavor === "container")
        await docker(["volume", "rm", `${prefix}-docker`]).catch(() => {});
      if (keys) await rm(keys, { recursive: true, force: true });
    });

    it("restores attachments, folders, mail databases, DKIM and target registration through the shared backup workers", async () => {
      let result;
      try {
        result = await docker([
        "exec",
        "-w",
        "/workspace",
        "-e",
        "NODE_ENV=test",
        "-e",
        "DEPLOY_MODE=bare",
        "-e",
        "CLOUD_MODE=false",
        "-e",
        "INTERNAL_TOKEN=mail-fixture-internal-token-00000000000000000000",
        "-e",
        "BETTER_AUTH_SECRET=mail-fixture-controller-secret-00000000000000000000",
        "-e",
        "BACKUP_ALLOW_LOCAL_DESTINATION=true",
        "-e",
        "BACKUP_LOCAL_ROOT=/var/lib/openship/backups",
        "-e",
        "OPENSHIP_MIGRATIONS_DIR=/workspace/drizzle",
        "-e",
        `MAIL_TEST_TARGET_FLAVOR=${targetFlavor}`,
        source,
        "bun",
        "roundtrip.js",
        ]);
      } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        const inspect = targetFlavor === "container"
          ? "docker exec openship-mail sh -c 'supervisorctl status; cat /tmp/supervisord.log /tmp/postfix*.log; postfix status; postfix check; ps aux'"
          : "systemctl status postfix dovecot amavis; journalctl --no-pager -n 60 -u postfix -u dovecot -u amavis";
        const diagnostics = await docker(["exec", target, "sh", "-c", inspect]).catch(
          (diagnosticError: Error & { stdout?: string; stderr?: string }) => diagnosticError,
        );
        throw new Error([
          failure.message,
          failure.stdout,
          failure.stderr,
          diagnostics.stdout,
          diagnostics.stderr,
        ].filter(Boolean).join("\n"), { cause: error });
      }
      expect(result.stdout, result.stderr).toContain("MAIL_BACKUP_ROUNDTRIP_OK");
    }, 300_000);
  });
}
