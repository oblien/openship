import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const email = resolve(import.meta.dirname, "../../../email");
const script = join(email, "docker/reconcile-db-port.py");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const directory = await mkdtemp(join(tmpdir(), "openship-mail-port-test-"));
  roots.push(directory);
  return directory;
}
async function file(root: string, path: string, content: string) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, { mode: 0o640 });
  return destination;
}
const run = (root: string, port: string) =>
  execFileSync("python3", [script, port, root], { encoding: "utf8", stdio: "pipe" });
const settings =
  ["vmail", "amavisd", "iredapd", "iredadmin"]
    .map(
      (prefix) =>
        `${prefix}_db_server = "127.0.0.1"\n${prefix}_db_port = "5432"\n${prefix}_db_password = "literal 5432 port=995"`,
    )
    .join("\n") + "\nlisten_port = 7777\n";

async function fixture() {
  const directory = await root();
  const paths: string[] = [];
  const sample = async (name: string, destination: string) => {
    const text = (await readFile(join(email, "engine/samples", name), "utf8"))
      .replaceAll("PH_SQL_SERVER_ADDRESS", "127.0.0.1")
      .replaceAll("PH_SQL_SERVER_PORT", "5432")
      .replaceAll("PH_AMAVISD_PERL_SQL_DBI", "Pg");
    paths.push(await file(directory, destination, text));
  };
  for (const name of await readdir(join(email, "engine/samples/postfix/pgsql"))) {
    await sample(`postfix/pgsql/${name}`, `etc/postfix/pgsql/${name}`);
  }
  for (const name of [
    "dovecot-sql.conf",
    "dovecot-used-quota.conf",
    "dovecot-last-login.conf",
    "dovecot-share-folder.conf",
  ]) {
    await sample(`dovecot/${name}`, `etc/dovecot/${name}`);
  }
  await sample("amavisd/amavisd.conf", "etc/amavis/conf.d/50-user");
  paths.push(await file(directory, "opt/iredapd/settings.py", settings));
  return { directory, paths };
}

describe("mail database port reconciliation", () => {
  it("updates actual Postfix, Dovecot, Amavis and iRedAPD configs and can return to the default", async () => {
    const { directory, paths } = await fixture();
    const originals = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    for (const port of ["5433", "5435", "5432"]) {
      run(directory, port);
      for (const [index, path] of paths.entries()) {
        const expected = originals[index]!.replaceAll("5432", port).replaceAll(
          `literal ${port} port=995`,
          "literal 5432 port=995",
        );
        expect(await readFile(path, "utf8"), path).toBe(expected);
        expect((await stat(path)).mode & 0o777).toBe(0o640);
      }
      const before = await Promise.all(paths.map((path) => stat(path)));
      run(directory, port);
      expect(
        (await Promise.all(paths.map((path) => stat(path)))).map((s) => [s.ino, s.mtimeMs]),
      ).toEqual(before.map((s) => [s.ino, s.mtimeMs]));
    }
  });

  it("preserves listeners, SQL credentials, foreign database endpoints, and fail2ban actions", async () => {
    const directory = await root();
    const untouched = {
      "etc/postfix/main.cf": "relayhost = [relay.example]:5432\n",
      "etc/postfix/pgsql/remote.cf": "hosts = db.example:5432\npassword = 5432\n",
      "etc/dovecot/listeners.conf":
        "service imap-login {\n  inet_listener imap {\n    port = 143\n  }\n}\n",
      "etc/dovecot/remote.conf":
        "connect = host=db.example port=5432 dbname=vmail password=' port=5432'\n",
      "etc/amavis/conf.d/60-listeners": "$inet_socket_port = [10024,10026];\n$password = '5432';\n",
      "etc/fail2ban/jail.local": 'action = banned_db[name=sshd, port="5432", protocol=tcp]\n',
      "opt/iredapd/settings.py":
        'vmail_db_server = "db.example"\nvmail_db_port = "5432"\nlisten_port = 7777\n',
    };
    for (const [path, content] of Object.entries(untouched)) await file(directory, path, content);
    run(directory, "5433");
    for (const [path, content] of Object.entries(untouched))
      expect(await readFile(join(directory, path), "utf8")).toBe(content);
  });

  it.each(["0", "65536", "5432.5", "5e3", "invalid", "5432;exit 0"])(
    "refuses invalid port %s before touching configuration",
    async (port) => {
      const directory = await root();
      const path = await file(directory, "opt/iredapd/settings.py", settings);
      expect(() => run(directory, port)).toThrow(/decimal port between 1 and 65535/);
      expect(await readFile(path, "utf8")).toBe(settings);
    },
  );

  it("removes stale settings bytecode while preserving permissions and skipping config symlinks", async () => {
    const { directory } = await fixture();
    const settingsPath = join(directory, "opt/iredapd/settings.py");
    await chmod(settingsPath, 0o600);
    const before = await stat(settingsPath);
    const bytecode = await file(
      directory,
      "opt/iredapd/__pycache__/settings.cpython-311.pyc",
      "old-bytecode",
    );
    const outside = await file(await root(), "outside.conf", "hosts = 127.0.0.1:5432\n");
    await symlink(outside, join(directory, "etc/postfix/pgsql/symlink.cf"));
    run(directory, "5433");
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    expect((await stat(settingsPath)).uid).toBe(before.uid);
    expect((await stat(settingsPath)).gid).toBe(before.gid);
    expect(await readFile(outside, "utf8")).toBe("hosts = 127.0.0.1:5432\n");
    await expect(stat(bytecode)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(directory, "opt/iredapd"))).toEqual(["__pycache__", "settings.py"]);
  });
});
