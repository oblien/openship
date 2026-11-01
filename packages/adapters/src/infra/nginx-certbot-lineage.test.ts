import { exec as execCallback } from "node:child_process";
import { X509Certificate } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RootChecked } from "../system/privilege";
import { makeTestCert, makeTestRenewalConf, type TestCert } from "../system/proxy/test-certs";
import { NginxProvider } from "./nginx";
import { OPENRESTY_DEFAULT_PATHS } from "./openresty-lua";

const exec = promisify(execCallback);
const DOMAIN = "app.example.com";
const temporary: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Real files and shell file operations; only Certbot and the running edge are simulated. */
async function setup(local = false) {
  const root = await mkdtemp(join(tmpdir(), "openship-certbot-lineage-"));
  temporary.push(root);
  const certDir = join(root, "live");
  const sitesDir = join(root, "sites");
  const commands: string[] = [];
  let certbot = async (_command: string): Promise<string> => "";
  const executor = {
    exec: async (command: string) => {
      commands.push(command);
      if (command.startsWith("certbot ")) return certbot(command);
      if (!/^(ls |mv |ln |chmod |readlink )/.test(command)) {
        throw new Error(`Unexpected command: ${command}`);
      }
      return (await exec(command)).stdout;
    },
    exists: async (path: string) =>
      access(path).then(
        () => true,
        () => false,
      ),
    readFile: (path: string) => readFile(path, "utf8"),
    writeFile: (path: string, content: string, options?: { mode?: number }) =>
      writeFile(path, content, options),
    mkdir: (path: string) => mkdir(path, { recursive: true }),
    rm: (path: string) => rm(path, { recursive: true, force: true }),
  } as unknown as RootChecked;
  const nginx = new NginxProvider({
    ...(local ? {} : { executor }),
    certDir,
    pinPaths: true,
    paths: { ...OPENRESTY_DEFAULT_PATHS, sitesDir },
  });
  const reload = vi
    .spyOn(nginx as unknown as { reload(): Promise<void> }, "reload")
    .mockResolvedValue(undefined);
  const old = makeTestCert([DOMAIN], { days: 10 });
  const renewed = makeTestCert([DOMAIN], { days: 90 });
  const versions = new Map<string, number>();

  async function put(name: string, pair: TestCert, tracked = false) {
    const dir = join(certDir, name);
    await mkdir(dir, { recursive: true });
    if (tracked) {
      const version = (versions.get(name) ?? 0) + 1;
      versions.set(name, version);
      const archive = join(root, "archive", name);
      await mkdir(archive, { recursive: true });
      for (const [file, content] of [
        ["cert", pair.certPem],
        ["chain", ""],
        ["fullchain", pair.certPem],
        ["privkey", pair.keyPem],
      ]) {
        await writeFile(join(archive, `${file}${version}.pem`), content, { mode: 0o600 });
        await rm(join(dir, `${file}.pem`), { force: true });
        await symlink(`../../archive/${name}/${file}${version}.pem`, join(dir, `${file}.pem`));
      }
      await mkdir(join(root, "renewal"), { recursive: true });
      await writeFile(join(root, "renewal", `${name}.conf`), makeTestRenewalConf(certDir, name));
    } else {
      await writeFile(join(dir, "fullchain.pem"), pair.certPem);
      await writeFile(join(dir, "privkey.pem"), pair.keyPem, { mode: 0o600 });
    }
    return dir;
  }

  await put(DOMAIN, old);
  await nginx.registerRoute({ domain: DOMAIN, targetUrl: "http://127.0.0.1:3009", tls: true });
  reload.mockClear();
  commands.length = 0;
  return {
    nginx,
    executor,
    root,
    commands,
    certDir,
    reload,
    old,
    renewed,
    put,
    certbot: (run: typeof certbot) => {
      certbot = run;
    },
    served: () => readFile(join(certDir, DOMAIN, "fullchain.pem"), "utf8"),
  };
}

describe("Certbot renewal after adopting a certificate", () => {
  test.each([false, true])(
    "renews an import on the first attempt using an unused name (leftover names: %s)",
    async (leftovers) => {
      const s = await setup();
      const occupied = new Set([DOMAIN]);
      if (leftovers) {
        const archive = join(s.root, "archive", `${DOMAIN}-0001`);
        await mkdir(archive, { recursive: true });
        await writeFile(join(archive, "cert1.pem"), s.old.certPem);
        await mkdir(join(s.root, "renewal"), { recursive: true });
        await writeFile(join(s.root, "renewal", `${DOMAIN}-0002.conf`), "broken record\n");
        await symlink("missing-directory", join(s.certDir, `${DOMAIN}-0003`));
        for (const suffix of ["0001", "0002", "0003"]) occupied.add(`${DOMAIN}-${suffix}`);
      }
      s.certbot(async (command) => {
        const name = command.match(/'--cert-name' '([^']+)'/)![1]!;
        // Certbot chooses its suffix from renewal/*.conf. An occupied live or
        // archive directory alone instead fails storage after the ACME order.
        if (occupied.has(name)) throw new Error(`live directory exists for ${name}`);
        expect(await s.served()).toBe(s.old.certPem);
        const dir = await s.put(name, s.renewed, true);
        return `Certificate is saved at: ${dir}/fullchain.pem\n`;
      });

      const result = await s.nginx.renewCert(DOMAIN);

      expect(result.expiresAt).toBe(
        new X509Certificate(s.renewed.certPem).validToDate.toISOString(),
      );
      expect(await s.served()).toBe(s.renewed.certPem);
      const issued = await readlink(join(s.certDir, DOMAIN, "fullchain.pem"));
      expect(issued).toBe(
        join(s.certDir, `${DOMAIN}-${leftovers ? "0004" : "0001"}`, "fullchain.pem"),
      );
      expect(s.commands.filter((command) => command.startsWith("certbot "))).toHaveLength(1);
    },
  );

  test.each([
    "missing-cert",
    "dangling-chain",
    "incomplete-record",
    "wrong-record-path",
    "missing-authenticator",
  ])("uses the healthy lineage when a newer certificate has a %s", async (damage) => {
    const s = await setup();
    const healthy = `${DOMAIN}-0001`;
    const broken = `${DOMAIN}-0002`;
    await s.put(healthy, s.renewed, true);
    const dir = await s.put(broken, makeTestCert([DOMAIN], { days: 180 }), true);
    const confPath = join(s.root, "renewal", `${broken}.conf`);
    if (damage === "missing-cert") await rm(join(dir, "cert.pem"));
    else if (damage === "dangling-chain") await rm(join(s.root, "archive", broken, "chain1.pem"));
    else {
      const conf = await readFile(confPath, "utf8");
      await writeFile(
        confPath,
        damage === "incomplete-record"
          ? "[renewalparams]\nserver = https://acme-v02.api.letsencrypt.org/directory\n"
          : damage === "wrong-record-path"
            ? conf.replace(`cert = ${dir}/cert.pem`, `cert = ${s.certDir}/${healthy}/cert.pem`)
            : conf.replace("authenticator = standalone\n", ""),
      );
    }

    const result = await s.nginx.renewCert(DOMAIN);

    expect(result.expiresAt).toBe(new X509Certificate(s.renewed.certPem).validToDate.toISOString());
    expect(await s.served()).toBe(s.renewed.certPem);
    expect(s.commands.filter((command) => command.startsWith("certbot "))).toEqual([
      `certbot 'renew' '--cert-name' '${healthy}' '--standalone' '--http-01-port' '49180' '--non-interactive' '--no-random-sleep-on-renew'`,
    ]);
  });

  test("serves and reports the issued sibling lineage instead of the old imported pair", async () => {
    const s = await setup();
    s.certbot(async () => {
      const dir = await s.put(`${DOMAIN}-0001`, s.renewed, true);
      return `Successfully received certificate.\nCertificate is saved at: ${dir}/fullchain.pem\nKey is saved at: ${dir}/privkey.pem\n`;
    });

    const result = await s.nginx.provisionCert(DOMAIN, { force: true });

    expect(result.expiresAt).toBe(new X509Certificate(s.renewed.certPem).validToDate.toISOString());
    expect(await s.served()).toBe(s.renewed.certPem);
    expect(await readlink(join(s.certDir, DOMAIN, "fullchain.pem"))).toBe(
      join(s.certDir, `${DOMAIN}-0001`, "fullchain.pem"),
    );
    expect(s.reload).toHaveBeenCalled();
  });

  test("recovers an already-issued sibling and renews its actual name without a forced reissue", async () => {
    const s = await setup();
    await s.put(`${DOMAIN}-0001`, s.renewed, true);
    // ConfigObj also writes quoted values and inline comments, e.g. for custom paths.
    const confPath = join(s.root, "renewal", `${DOMAIN}-0001.conf`);
    const conf = await readFile(confPath, "utf8");
    await writeFile(
      confPath,
      conf.replace(/^(\w+) = (.+)$/gm, '$1 = "$2" # saved by Certbot') +
        `post_hook = '''sh -c 'printf "%s" "certificate renewed"'\n# a multiline hook\n'''\n`,
    );

    const result = await s.nginx.renewCert(DOMAIN);

    expect(s.commands.filter((c) => c.startsWith("certbot "))).toEqual([
      `certbot 'renew' '--cert-name' '${DOMAIN}-0001' '--standalone' '--http-01-port' '49180' '--non-interactive' '--no-random-sleep-on-renew'`,
    ]);
    expect(await s.served()).toBe(s.renewed.certPem);
    expect(result.expiresAt).toBe(new X509Certificate(s.renewed.certPem).validToDate.toISOString());

    // Future Certbot updates must reach the served path; copying the PEM once would fail this.
    const next = makeTestCert([DOMAIN], { days: 120 });
    await s.put(`${DOMAIN}-0001`, next, true);
    expect(await s.served()).toBe(next.certPem);
    expect((await s.nginx.verifyCert(DOMAIN)).expiresAt).toBe(
      new X509Certificate(next.certPem).validToDate.toISOString(),
    );
  });

  test("keeps explicitly installed certificates authoritative after adopting a lineage", async () => {
    const s = await setup();
    const lineage = await s.put(`${DOMAIN}-0001`, s.renewed, true);
    await s.nginx.renewCert(DOMAIN);
    const manual = makeTestCert([DOMAIN], { days: 60 });

    await s.nginx.installCert(DOMAIN, manual);

    expect(await s.served()).toBe(manual.certPem);
    expect(await readFile(join(lineage, "fullchain.pem"), "utf8")).toBe(s.renewed.certPem);
    expect((await s.nginx.verifyCert(DOMAIN)).expiresAt).toBe(
      new X509Certificate(manual.certPem).validToDate.toISOString(),
    );
  });

  test("removes only the replaced lineage's renewal config and preserves its archive", async () => {
    const s = await setup();
    await s.put(DOMAIN, s.old, true);
    const renewalConf = join(s.root, "renewal", `${DOMAIN}.conf`);
    const otherConf = join(s.root, "renewal", "other.example.com.conf");
    await writeFile(otherConf, "unrelated renewal");
    const archiveCert = join(s.root, "archive", DOMAIN, "fullchain1.pem");
    const archiveBefore = await readFile(archiveCert, "utf8");

    await s.nginx.installCert(DOMAIN, s.renewed);

    await expect(readFile(renewalConf, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(otherConf, "utf8")).toBe("unrelated renewal");
    expect(await readFile(archiveCert, "utf8")).toBe(archiveBefore);
    expect(await s.served()).toBe(s.renewed.certPem);
  });

  test("does not remove renewal ownership when certificate validation fails", async () => {
    const s = await setup();
    await s.put(DOMAIN, s.old, true);
    const conf = join(s.root, "renewal", `${DOMAIN}.conf`);
    const before = await readFile(conf, "utf8");
    await expect(
      s.nginx.installCert(DOMAIN, { ...s.old, keyPem: s.renewed.keyPem }),
    ).rejects.toThrow(/Invalid certificate/);
    expect(await readFile(conf, "utf8")).toBe(before);
    expect(await s.served()).toBe(s.old.certPem);
    expect(s.reload).not.toHaveBeenCalled();
  });

  test("does not report successful installation when obsolete renewal cleanup fails", async () => {
    const s = await setup();
    await s.put(DOMAIN, s.old, true);
    const conf = join(s.root, "renewal", `${DOMAIN}.conf`);
    const remove = s.executor.rm.bind(s.executor);
    vi.spyOn(s.executor, "rm").mockImplementation(async (path) => {
      if (path === conf) throw new Error("renewal cleanup permission denied");
      return remove(path);
    });
    await expect(s.nginx.installCert(DOMAIN, s.renewed)).rejects.toThrow(
      /renewal cleanup permission denied/,
    );
    expect(await readFile(conf, "utf8")).toBeTruthy();
    expect(await s.served()).toBe(s.old.certPem);
    expect(await readlink(join(s.certDir, DOMAIN, "privkey.pem"))).toBe(
      `../../archive/${DOMAIN}/privkey1.pem`,
    );
    expect(s.reload).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "restores managed links and renewal ownership after reload failure (local: %s)",
    async (local) => {
      const s = await setup(local);
      await s.put(DOMAIN, s.old, true);
      const conf = join(s.root, "renewal", `${DOMAIN}.conf`);
      const original = await readFile(conf, "utf8");
      s.reload.mockRejectedValueOnce(new Error("edge reload rejected"));

      await expect(s.nginx.installCert(DOMAIN, s.renewed)).rejects.toThrow(/edge reload rejected/);

      expect(await s.served()).toBe(s.old.certPem);
      expect(await readFile(conf, "utf8")).toBe(original);
      for (const name of ["fullchain", "privkey"]) {
        expect(await readlink(join(s.certDir, DOMAIN, `${name}.pem`))).toBe(
          `../../archive/${DOMAIN}/${name}1.pem`,
        );
      }
      expect((await stat(join(s.certDir, DOMAIN, "privkey.pem"))).mode & 0o777).toBe(0o600);
      await expect(s.nginx.installCert(DOMAIN, s.renewed)).resolves.toMatchObject({
        verified: true,
      });
      await expect(readFile(conf, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("restores both old links after certificate publication stops between the PEM moves", async () => {
    const s = await setup();
    await s.put(DOMAIN, s.old, true);
    const execute = s.executor.exec.bind(s.executor);
    vi.spyOn(s.executor, "exec").mockImplementation(async (command) => {
      if (command.startsWith("mv -f ") && command.includes(".staging-")) {
        const source = command.match(/^mv -f '([^']+)'/)![1]!;
        await rename(source, join(s.certDir, DOMAIN, "fullchain.pem"));
        throw new Error("certificate publication interrupted");
      }
      return execute(command);
    });

    await expect(s.nginx.installCert(DOMAIN, s.renewed)).rejects.toThrow(/publication interrupted/);
    expect(await s.served()).toBe(s.old.certPem);
    expect(await readlink(join(s.certDir, DOMAIN, "fullchain.pem"))).toBe(
      `../../archive/${DOMAIN}/fullchain1.pem`,
    );
    expect(await readlink(join(s.certDir, DOMAIN, "privkey.pem"))).toBe(
      `../../archive/${DOMAIN}/privkey1.pem`,
    );
    expect(await readFile(join(s.root, "renewal", `${DOMAIN}.conf`), "utf8")).toBeTruthy();
    expect(s.reload).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    "restores a previous manual pair with a private key mode after failed replacement (local: %s)",
    async (local) => {
      const s = await setup(local);
      s.reload.mockRejectedValueOnce(new Error("edge reload rejected"));
      await expect(s.nginx.installCert(DOMAIN, s.renewed)).rejects.toThrow(/edge reload rejected/);
      expect(await s.served()).toBe(s.old.certPem);
      expect(await readFile(join(s.certDir, DOMAIN, "privkey.pem"), "utf8")).toBe(s.old.keyPem);
      expect((await stat(join(s.certDir, DOMAIN, "privkey.pem"))).mode & 0o777).toBe(0o600);
    },
  );

  test("renews the linked lineage even when its certificate has already expired", async () => {
    const s = await setup();
    await s.put(`${DOMAIN}-0001`, s.renewed, true);
    await s.nginx.renewCert(DOMAIN);
    s.commands.length = 0;
    vi.setSystemTime(Date.now() + 100 * 86400_000);
    const next = makeTestCert([DOMAIN], { days: 180 });
    s.certbot(async () => {
      await s.put(`${DOMAIN}-0001`, next, true);
      return "Congratulations, all renewals succeeded.";
    });

    expect((await s.nginx.renewCert(DOMAIN)).verified).toBe(true);
    expect(s.commands.find((c) => c.startsWith("certbot "))).toContain(
      `'renew' '--cert-name' '${DOMAIN}-0001'`,
    );
    expect(await s.served()).toBe(next.certPem);
  });

  test("does not select a newer-numbered untracked or wrong-host certificate", async () => {
    const s = await setup();
    await s.put(`${DOMAIN}-0001`, s.renewed, true);
    await s.put(`${DOMAIN}-0002`, makeTestCert([DOMAIN], { days: 180 }));
    await s.put(`${DOMAIN}-0003`, makeTestCert(["elsewhere.example.com"], { days: 180 }), true);

    await s.nginx.renewCert(DOMAIN);

    expect(s.commands.find((c) => c.startsWith("certbot "))).toContain(
      `'renew' '--cert-name' '${DOMAIN}-0001'`,
    );
    expect(await s.served()).toBe(s.renewed.certPem);
  });

  test("recovers a broken original renewal record left by importing certificate files", async () => {
    const s = await setup();
    await s.put(DOMAIN, s.old, true);
    await s.nginx.installCert(DOMAIN, s.old);
    await s.put(`${DOMAIN}-0001`, s.renewed, true);

    const result = await s.nginx.renewCert(DOMAIN);

    expect(s.commands.find((c) => c.startsWith("certbot "))).toContain(
      `'renew' '--cert-name' '${DOMAIN}-0001'`,
    );
    expect(result.expiresAt).toBe(new X509Certificate(s.renewed.certPem).validToDate.toISOString());
    expect(await s.served()).toBe(s.renewed.certPem);
  });

  test.each(["other.example.com-0001", `${DOMAIN}-backup`, `../${DOMAIN}-0001`])(
    "rejects a certificate path outside this hostname's lineages: %s",
    async (name) => {
      const s = await setup();
      s.certbot(async () => {
        const dir = await s.put(name, s.renewed, true);
        return `Certificate is saved at: ${dir}/fullchain.pem\n`;
      });
      await expect(s.nginx.provisionCert(DOMAIN, { force: true })).rejects.toThrow(
        /unexpected certificate directory/,
      );
      expect(await s.served()).toBe(s.old.certPem);
    },
  );

  test.each(["wrong-host", "wrong-key", "missing"])(
    "rejects a reported %s sibling instead of claiming success using the old certificate",
    async (kind) => {
      const s = await setup();
      s.certbot(async () => {
        const wrong = makeTestCert(["elsewhere.example.com"]);
        const dir = join(s.certDir, `${DOMAIN}-0001`);
        if (kind !== "missing") {
          await s.put(
            `${DOMAIN}-0001`,
            kind === "wrong-host"
              ? wrong
              : {
                  certPem: s.renewed.certPem,
                  keyPem: wrong.keyPem,
                },
            true,
          );
        }
        return `Certificate is saved at: ${dir}/fullchain.pem\n`;
      });

      await expect(s.nginx.provisionCert(DOMAIN, { force: true })).rejects.toThrow(/certificate/i);
      expect(await s.served()).toBe(s.old.certPem);
      expect(s.reload).not.toHaveBeenCalled();
    },
  );
});
