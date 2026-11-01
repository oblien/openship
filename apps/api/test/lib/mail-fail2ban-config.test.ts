import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const script = resolve(import.meta.dirname, "../../../email/docker/configure-fail2ban-db.py");
const roots: string[] = [];
const settings = "etc/fail2ban/openship-postgresql.conf";
const credentials = "etc/fail2ban/openship-postgresql.pgpass";
async function root() {
  const path = await mkdtemp(join(tmpdir(), "openship-fail2ban-config-"));
  roots.push(path);
  return path;
}
const run = (root: string, values: Record<string, string> = {}) =>
  execFileSync("python3", [script, root], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENSHIP_MAIL_DB_HOST: "127.0.0.1",
      OPENSHIP_MAIL_DB_PORT: "5432",
      VMAIL_DB_BIND_PASSWD: "test-password",
      ...values,
    },
    stdio: "pipe",
  });
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("fail2ban sidecar connection configuration", () => {
  it("writes private TCP settings and preserves existing PostgreSQL password files", async () => {
    const directory = await root();
    const original = "*:*:*:postgres:retained-password\n*:*:*:vmail:retained-mail-password\n";
    for (const path of ["root/.pgpass", "var/lib/postgresql/.pgpass"]) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), original, { mode: 0o600 });
    }
    const log = run(directory);
    expect(log).not.toContain("test-password");
    expect(await readFile(join(directory, credentials), "utf8")).toBe(
      "127.0.0.1:5432:fail2ban:fail2ban:test-password\n",
    );
    expect(await readFile(join(directory, settings), "utf8")).toContain(
      "export PGPASSFILE=/etc/fail2ban/openship-postgresql.pgpass\n",
    );
    for (const path of [settings, credentials])
      expect((await stat(join(directory, path))).mode & 0o777).toBe(0o600);
    for (const path of ["root/.pgpass", "var/lib/postgresql/.pgpass"])
      expect(await readFile(join(directory, path), "utf8")).toBe(original);
  });

  it("reconciles changed ports on each boot and escapes password-file delimiters", async () => {
    const directory = await root();
    const password = "test:back\\slash'quote";
    for (const port of ["5432", "5544", "5432"]) {
      run(directory, { VMAIL_DB_BIND_PASSWD: password, OPENSHIP_MAIL_DB_PORT: port });
      expect(await readFile(join(directory, settings), "utf8")).toContain(
        `export PGPORT=${port}\n`,
      );
      expect(await readFile(join(directory, credentials), "utf8")).toBe(
        `127.0.0.1:${port}:fail2ban:fail2ban:test\\:back\\\\slash'quote\n`,
      );
    }
  });

  it("supports IPv6 without using wildcard credentials", async () => {
    const directory = await root();
    run(directory, { OPENSHIP_MAIL_DB_HOST: "::1" });
    expect(await readFile(join(directory, credentials), "utf8")).toBe(
      "\\:\\:1:5432:fail2ban:fail2ban:test-password\n",
    );
    expect(await readFile(join(directory, settings), "utf8")).toContain("export PGHOST=::1\n");
  });

  it.each([
    { OPENSHIP_MAIL_DB_HOST: "/var/run/postgresql" },
    { OPENSHIP_MAIL_DB_HOST: "localhost;echo bad" },
    { OPENSHIP_MAIL_DB_PORT: "0" },
    { OPENSHIP_MAIL_DB_PORT: "65536" },
    { OPENSHIP_MAIL_DB_PORT: "5432;exit 0" },
    { VMAIL_DB_BIND_PASSWD: "" },
    { VMAIL_DB_BIND_PASSWD: "secret\nextra-record" },
  ])("rejects invalid connection input before writing files: %j", async (values) => {
    const directory = await root();
    expect(() => run(directory, values)).toThrow();
    await expect(stat(join(directory, settings))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(directory, credentials))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses credential symlinks without replacing or changing the target", async () => {
    const directory = await root();
    const outside = join(await root(), "outside.pgpass");
    await writeFile(outside, "retained", { mode: 0o600 });
    await mkdir(join(directory, "etc/fail2ban"), { recursive: true });
    await symlink(outside, join(directory, credentials));
    expect(() => run(directory)).toThrow(/must stay inside/);
    expect(await readFile(outside, "utf8")).toBe("retained");
  });
});
