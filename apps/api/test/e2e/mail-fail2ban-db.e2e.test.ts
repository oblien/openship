/** Real ban/unban operations against the sidecar; no host firewall or production mail changes. */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const email = resolve(import.meta.dirname, "../../../email");
const suffix = randomUUID().slice(0, 12);
const db = `openship-fail2ban-db-${suffix}`;
const custom = `openship-fail2ban-custom-${suffix}`;
const runner = `openship-fail2ban-client-${suffix}`;
const password = "e2e:back\\slash'quote";
const rootPassword = "e2e-sidecar-root-password";
const config = "/etc/fail2ban/openship-postgresql.conf";
const helper = "/usr/local/bin/fail2ban_banned_db";
let directory: string;

async function docker(args: string[], allowFail = false) {
  try {
    const { stdout, stderr } = await exec("docker", args, {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    if (!allowFail) throw error;
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
async function query(sql: string, port: number) {
  return (
    await docker([
      "exec",
      "--env",
      `PGPASSWORD=${rootPassword}`,
      runner,
      "psql",
      "-X",
      "-w",
      "-h",
      "127.0.0.1",
      "-p",
      String(port),
      "-U",
      "postgres",
      "-d",
      "fail2ban",
      "-tAc",
      sql,
    ])
  ).stdout.trim();
}
async function configure(port: number, secret = password) {
  return docker([
    "exec",
    "--env",
    `VMAIL_DB_BIND_PASSWD=${secret}`,
    "--env",
    `OPENSHIP_MAIL_DB_PORT=${port}`,
    runner,
    "python3",
    "/opt/openship-mail/configure-fail2ban-db.py",
  ]);
}
async function action(...args: string[]) {
  // Deliberately no inherited mail/PG variables: also exercises scheduled and
  // direct invocations. Real psql must read the dedicated password file.
  return docker(
    [
      "exec",
      runner,
      "env",
      "-i",
      "PATH=/usr/bin:/usr/local/bin:/bin",
      "HOME=/root",
      "bash",
      helper,
      ...args,
    ],
    true,
  );
}

describeDockerE2E("fail2ban PostgreSQL sidecar actions", () => {
  beforeAll(async () => {
    await requireDocker();
    directory = await mkdtemp(join(tmpdir(), "openship-fail2ban-e2e-"));
    await docker([
      "run",
      "-d",
      "--name",
      db,
      "--memory",
      "256m",
      "--cpus",
      "0.5",
      "--env",
      `POSTGRES_PASSWORD=${rootPassword}`,
      "--env",
      "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
      "--env",
      "POSTGRES_DB=fail2ban",
      "postgres:16-alpine",
    ]);
    await docker([
      "run",
      "-d",
      "--name",
      custom,
      "--network",
      `container:${db}`,
      "--memory",
      "256m",
      "--cpus",
      "0.5",
      "--env",
      `POSTGRES_PASSWORD=${rootPassword}`,
      "--env",
      "POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256",
      "--env",
      "POSTGRES_DB=fail2ban",
      "postgres:16-alpine",
      "postgres",
      "-p",
      "5544",
    ]);
    await docker([
      "run",
      "-d",
      "--name",
      runner,
      "--network",
      `container:${db}`,
      "--memory",
      "256m",
      "--cpus",
      "0.5",
      "--entrypoint",
      "sleep",
      "postgres:17",
      "3600",
    ]);
    await docker([
      "exec",
      runner,
      "bash",
      "-c",
      "apt-get update -qq && apt-get install -y --no-install-recommends python3 >/dev/null",
    ]);
    await docker(["exec", runner, "mkdir", "-p", "/etc/fail2ban", "/opt/openship-mail"]);
    await docker([
      "cp",
      join(email, "docker/configure-fail2ban-db.py"),
      `${runner}:/opt/openship-mail/configure-fail2ban-db.py`,
    ]);
    await docker([
      "cp",
      join(email, "engine/samples/fail2ban/bin/fail2ban_banned_db"),
      `${runner}:${helper}`,
    ]);
    await docker([
      "cp",
      join(email, "engine/samples/fail2ban/sql/fail2ban.pgsql"),
      `${runner}:/tmp/fail2ban.sql`,
    ]);
    await writeFile(
      join(directory, "role.sql"),
      `CREATE ROLE fail2ban LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password.replaceAll("'", "''")}';\nALTER DATABASE fail2ban OWNER TO fail2ban;\n`,
    );
    await docker(["cp", join(directory, "role.sql"), `${runner}:/tmp/role.sql`]);
    for (const port of [5432, 5544]) {
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          if ((await query("SELECT 1", port)) === "1") {
            ready = true;
            break;
          }
        } catch {
          /* wait for authenticated readiness */
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(ready, `PostgreSQL did not start on ${port}`).toBe(true);
      await docker([
        "exec",
        "--env",
        `PGPASSWORD=${rootPassword}`,
        runner,
        "psql",
        "-X",
        "-w",
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "/tmp/role.sql",
      ]);
      await docker([
        "exec",
        "--env",
        `PGPASSWORD=${password}`,
        runner,
        "psql",
        "-X",
        "-w",
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        "fail2ban",
        "-d",
        "fail2ban",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "/tmp/fail2ban.sql",
      ]);
    }
  }, 300_000);

  afterAll(async () => {
    for (const name of [runner, custom, db]) await docker(["rm", "-fv", name], true);
    if (directory) await rm(directory, { recursive: true, force: true });
  }, 120_000);

  it.each([5432, 5544])(
    "starts a jail, bans once, unbans and stops over TCP on port %i",
    async (port) => {
      expect((await configure(port)).stdout).not.toContain(password);
      expect((await action("start", "dovecot-iredmail")).code).toBe(0);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await action(
          "ban",
          "192.0.2.10",
          "143,993",
          "tcp",
          "dovecot-iredmail",
          "3",
          "test log",
        );
        expect(result.code, result.stderr).toBe(0);
      }
      expect(await query("SELECT count(*) FROM banned WHERE ip='192.0.2.10'", port)).toBe("1");
      expect(await query("SELECT failures FROM banned WHERE ip='192.0.2.10'", port)).toBe("3");
      expect((await action("unban", "192.0.2.10")).code).toBe(0);
      expect(await query("SELECT count(*) FROM banned", port)).toBe("0");
      expect((await action("stop", "dovecot-iredmail")).code).toBe(0);
      expect(await query("SELECT count(*) FROM jails", port)).toBe("0");
    },
  );

  it("refuses bad credentials without reporting a successful ban", async () => {
    await configure(5432, "wrong-test-password");
    const result = await action("ban", "192.0.2.11", "143,993", "tcp", "dovecot-iredmail", "3");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("password authentication failed");
    expect(result.stdout).not.toContain("Stored.");
    expect(await query("SELECT count(*) FROM banned", 5432)).toBe("0");
  });

  it("reports SQL write errors instead of success and recovers after a new boot", async () => {
    await configure(5544);
    const result = await action(
      "ban",
      "192.0.2.12",
      "143,993",
      "tcp",
      "dovecot-iredmail",
      "not-an-integer",
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("Stored.");
    expect(await query("SELECT count(*) FROM banned", 5544)).toBe("0");
    await configure(5432);
    expect((await action("start", "dovecot-iredmail")).code).toBe(0);
    expect(await query("SELECT count(*) FROM jails", 5432)).toBe("1");
  });

  it("also honors the private config when ambient libpq settings point elsewhere", async () => {
    await configure(5544);
    const result = await docker(
      [
        "exec",
        "--env",
        "PGHOST=/missing/socket",
        "--env",
        "PGHOSTADDR=203.0.113.1",
        "--env",
        "PGPORT=1",
        "--env",
        "PGPASSWORD=wrong",
        "--env",
        "PGSERVICE=missing-service",
        runner,
        "bash",
        helper,
        "cleanup",
        "dovecot-iredmail",
      ],
      true,
    );
    expect(result.code, result.stderr).toBe(0);
    expect((await docker(["exec", runner, "stat", "-c", "%a", config])).stdout.trim()).toBe("600");
  });

  it("processes the scheduled unban query without inherited container variables", async () => {
    await configure(5544);
    expect(
      (await action("ban", "192.0.2.13", "143,993", "tcp", "dovecot-iredmail", "3")).code,
    ).toBe(0);
    await query("UPDATE banned SET remove=1 WHERE ip='192.0.2.13'", 5544);
    // Only the firewall daemon callback is stubbed. The helper's pending query
    // and callback's delete both use real PostgreSQL with password auth.
    await writeFile(
      join(directory, "fail2ban-client"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> /tmp/unban-calls\nexec bash /usr/local/bin/fail2ban_banned_db unban "$4"\n',
    );
    await docker([
      "cp",
      join(directory, "fail2ban-client"),
      `${runner}:/usr/local/bin/fail2ban-client`,
    ]);
    await docker(["exec", runner, "chmod", "+x", "/usr/local/bin/fail2ban-client"]);
    const result = await action("unban_db");
    expect(result.code, result.stderr).toBe(0);
    expect(await query("SELECT count(*) FROM banned", 5544)).toBe("0");
    expect((await docker(["exec", runner, "cat", "/tmp/unban-calls"])).stdout.trim()).toBe(
      "set dovecot-iredmail unbanip 192.0.2.13",
    );
  });

  it("preserves the standalone PostgreSQL selection when no container config exists", async () => {
    await configure(5544);
    await docker(["exec", runner, "mv", config, `${config}.disabled`]);
    try {
      await docker(["exec", runner, "mkdir", "-p", "/var/lib/postgresql"]);
      await docker([
        "exec",
        runner,
        "cp",
        "/etc/fail2ban/openship-postgresql.pgpass",
        "/var/lib/postgresql/.pgpass",
      ]);
      const result = await docker(
        [
          "exec",
          "--env",
          "PGHOST=127.0.0.1",
          "--env",
          "PGPORT=5544",
          runner,
          "bash",
          helper,
          "start",
          "native-jail",
        ],
        true,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(await query("SELECT count(*) FROM jails WHERE name='native-jail'", 5544)).toBe("1");
    } finally {
      await docker(["exec", runner, "mv", `${config}.disabled`, config]);
    }
  });

  it("reports failed scheduled callbacks and keeps their database records pending", async () => {
    await configure(5544);
    expect(
      (await action("ban", "192.0.2.14", "143,993", "tcp", "dovecot-iredmail", "3")).code,
    ).toBe(0);
    await query("UPDATE banned SET remove=1 WHERE ip='192.0.2.14'", 5544);
    await writeFile(join(directory, "fail2ban-client"), "#!/bin/sh\nexit 3\n");
    await docker([
      "cp",
      join(directory, "fail2ban-client"),
      `${runner}:/usr/local/bin/fail2ban-client`,
    ]);
    await docker(["exec", runner, "chmod", "+x", "/usr/local/bin/fail2ban-client"]);
    const result = await action("unban_db");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Failed to unban");
    expect(result.stdout).not.toContain("Unbanned ");
    expect(
      await query("SELECT count(*) FROM banned WHERE ip='192.0.2.14' AND remove=1", 5544),
    ).toBe("1");
  });
});
