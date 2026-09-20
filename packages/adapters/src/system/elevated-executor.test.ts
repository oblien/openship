import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { elevatedExecutor, elevateCommand, ensureOwnedDir } from "./elevated-executor";
import { probeOutput } from "./environment.fixtures";
import { sq } from "./local-shell";
import type { CommandExecutor, LogEntry } from "../types";

const ENV = "DEBIAN_FRONTEND=noninteractive DPKG_FORCE=confnew";

function fakeExecutor() {
  const exec = vi.fn(async (_command: string, _opts?: { timeout?: number }) => "out");
  const streamExec = vi.fn(async (_command: string, _onLog: (l: LogEntry) => void) => ({
    code: 0,
    output: "",
  }));
  const writeFile = vi.fn(async (_path: string, _content: string) => {});
  const readFile = vi.fn(async (_path: string) => "file-contents");
  const exists = vi.fn(async (_path: string) => true);
  const mkdir = vi.fn(async (_path: string) => {});
  const rm = vi.fn(async (_path: string) => {});
  const transferIn = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const inner = {
    exec,
    streamExec,
    writeFile,
    readFile,
    exists,
    mkdir,
    rm,
    transferIn,
    dispose,
  } as unknown as CommandExecutor;
  return { inner, exec, streamExec, writeFile, readFile, exists, mkdir, rm, transferIn };
}

describe("elevateCommand", () => {
  it("wraps a command as `sudo -n sh -c` with the apt env re-exported inside", () => {
    const wrapped = elevateCommand("apt-get install -y -qq openresty");
    expect(wrapped).toBe(
      `sudo -n sh -c ${sq(`export ${ENV}; apt-get install -y -qq openresty`)}`,
    );
    expect(wrapped.startsWith("sudo -n sh -c ")).toBe(true);
  });

  it("produces a payload the shell parses back verbatim, even with single quotes", () => {
    // These are real recipe fragments — they contain single quotes, so the
    // sq() escaping is load-bearing. Prove `sh` unquotes each to the original.
    const commands = [
      "pkill -f '[o]penresty' 2>/dev/null || true",
      "sed -i '/http *{/a lua_shared_dict analytics 16m;' /etc/openresty/nginx.conf",
      'echo "deb [signed-by=/usr/share/keyrings/openresty.gpg] http://x y" > /etc/apt/sources.list.d/openresty.list',
    ];
    for (const cmd of commands) {
      const payload = `export ${ENV}; ${cmd}`;
      // The single-quoted argument that the inner `sh -c` receives.
      const quotedArg = elevateCommand(cmd).slice("sudo -n sh -c ".length);
      const roundTrip = execFileSync("sh", ["-c", `printf %s ${quotedArg}`]).toString();
      expect(roundTrip).toBe(payload);
    }
  });
});

describe("elevatedExecutor", () => {
  it("elevates exec and streamExec", async () => {
    const { inner, exec, streamExec } = fakeExecutor();
    const el = elevatedExecutor(inner);

    await el.exec("apt-get update -qq");
    expect(exec).toHaveBeenCalledWith(elevateCommand("apt-get update -qq"), undefined);

    await el.streamExec("systemctl enable openresty && systemctl start openresty", () => {});
    expect(streamExec.mock.calls[0]?.[0]).toBe(
      elevateCommand("systemctl enable openresty && systemctl start openresty"),
    );
  });

  // Staging is where the secrets are. Every elevated write puts its plaintext on the
  // target's disk unelevated before root can move it — a TLS private key, the ACME EAB
  // HMAC key, mail-state.json's credentials — so the three properties below are the
  // security contract of this decorator, not incidental mechanics.
  const stageDirOf = (staged: string) => staged.slice(0, staged.lastIndexOf("/"));

  it("creates the private 0700 staging dir BEFORE the plaintext is written", async () => {
    const { inner, writeFile, exec } = fakeExecutor();

    await elevatedExecutor(inner).writeFile("/etc/openresty/nginx.conf", "worker_processes 1;");

    const staged = String(writeFile.mock.calls[0]?.[0]);
    const dir = stageDirOf(staged);

    // Exact, because every token is load-bearing: `-m 700` applies the mode at creation so
    // the content never exists in a readable directory, and no `-p` means a path someone
    // planted is an error rather than somewhere we write a secret. Unelevated, so the dir
    // belongs to the login user and the cleanup below works even when sudo is what failed.
    expect(String(exec.mock.calls[0]?.[0])).toBe(`mkdir -m 700 ${sq(dir)}`);
    expect(exec.mock.invocationCallOrder[0]!).toBeLessThan(
      writeFile.mock.invocationCallOrder[0]!,
    );
    // 96 bits from randomBytes: /tmp is world-LISTABLE even when our dir isn't, so the
    // visible name must be both unguessable and free of any hint about the target path.
    expect(dir).toMatch(/^\/tmp\/\.openship-elev-[0-9a-f]{24}$/);
    expect(staged).toBe(`${dir}/payload`);
    expect(writeFile.mock.calls[0]?.[1]).toBe("worker_processes 1;");
  });

  it("publishes root-owned, then removes the staging dir", async () => {
    const { inner, writeFile, exec } = fakeExecutor();

    await elevatedExecutor(inner).writeFile("/etc/openresty/nginx.conf", "worker_processes 1;");

    const staged = String(writeFile.mock.calls[0]?.[0]);
    // `mv` preserves ownership — by rename and by cross-device copy alike — so without the
    // chown the published file lands under /etc owned by the LOGIN user, and a non-root
    // account on a sudo host can rewrite root's nginx.conf after we wrote it.
    expect(String(exec.mock.calls[1]?.[0])).toBe(
      elevateCommand(
        `mkdir -p ${sq("/etc/openresty")} && chown 0:0 ${sq(staged)} && ` +
          `mv -f ${sq(staged)} ${sq("/etc/openresty/nginx.conf")}`,
      ),
    );
    expect(String(exec.mock.calls[2]?.[0])).toBe(`rm -rf ${sq(stageDirOf(staged))}`);
  });

  it("creates a private-mode payload before publishing a secret", async () => {
    const { inner, writeFile, exec } = fakeExecutor();

    await elevatedExecutor(inner).writeFile("/etc/postfix/sasl_passwd", "relay-secret", {
      mode: 0o600,
    });

    const staged = String(writeFile.mock.calls[0]?.[0]);
    expect(writeFile).toHaveBeenCalledWith(staged, "relay-secret", { mode: 0o600 });
    expect(writeFile.mock.invocationCallOrder[0]!).toBeLessThan(exec.mock.invocationCallOrder[1]!);
    // The content travels through the file channel, never argv/process listings.
    expect(exec.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
      "relay-secret",
    );
  });

  it("removes the staged plaintext when the elevated publish fails, and still throws", async () => {
    const { inner, writeFile, exec } = fakeExecutor();
    // Sudo refusing is the case that left a TLS key readable in /tmp for the life of the
    // box: the move never ran, nothing cleaned up, and the caller saw only the error.
    exec.mockImplementation(async (command: string) => {
      if (command.startsWith("sudo")) throw new Error("sudo: a password is required");
      return "out";
    });

    await expect(elevatedExecutor(inner).writeFile("/etc/x", "hunter2")).rejects.toThrow(
      /password is required/,
    );

    const dir = stageDirOf(String(writeFile.mock.calls[0]?.[0]));
    expect(exec.mock.calls.map((call) => String(call[0]))).toContain(`rm -rf ${sq(dir)}`);
  });

  it("elevates mkdir and rm", async () => {
    const { inner, exec } = fakeExecutor();
    const el = elevatedExecutor(inner);

    await el.mkdir("/etc/openresty");
    await el.rm("/usr/local/openresty");

    expect(exec.mock.calls[0]?.[0]).toBe(elevateCommand(`mkdir -p ${sq("/etc/openresty")}`));
    expect(exec.mock.calls[1]?.[0]).toBe(elevateCommand(`rm -rf ${sq("/usr/local/openresty")}`));
  });

  // The safety property of elevating reads: a read that already worked is untouched —
  // same call, same path, same result, no second round-trip. Everything that depended on
  // the old pass-through behaviour depended on this case, so it is pinned first.
  it("passes a read that succeeds straight through, with no sudo", async () => {
    const { inner, readFile, exists, transferIn, exec } = fakeExecutor();
    const el = elevatedExecutor(inner);

    await el.readFile("/etc/os-release");
    await el.exists("/etc/openresty");
    await el.transferIn("/local", "/remote");

    expect(readFile).toHaveBeenCalledWith("/etc/os-release");
    expect(exists).toHaveBeenCalledWith("/etc/openresty");
    expect(transferIn).toHaveBeenCalled();
    // none of those routed through an elevated exec
    expect(exec).not.toHaveBeenCalled();
  });

  // …and the case that made this necessary. Certbot chmods /etc/letsencrypt/live to 0700
  // root, so a non-root SFTP read of a cert is REFUSED — and every caller reads a failed
  // read as absence, so a box with a valid certificate reported having none and re-issued
  // it on each deploy until Let's Encrypt's duplicate limit stopped issuing at all.
  it("retries a REFUSED read as root, so a 0700 cert dir reports what is actually there", async () => {
    const { inner, readFile, exec } = fakeExecutor();
    readFile.mockRejectedValue(new Error("EACCES: permission denied, open '/etc/letsencrypt/live/x/fullchain.pem'"));
    exec.mockResolvedValue("-----BEGIN CERTIFICATE-----");

    const el = elevatedExecutor(inner);
    const pem = await el.readFile("/etc/letsencrypt/live/x/fullchain.pem");

    expect(pem).toBe("-----BEGIN CERTIFICATE-----");
    expect(String(exec.mock.calls[0]?.[0])).toBe(
      elevateCommand(`cat ${sq("/etc/letsencrypt/live/x/fullchain.pem")}`),
    );
  });

  it("reports a genuinely missing file with the original error, not sudo's", async () => {
    const { inner, readFile, exists, exec } = fakeExecutor();
    readFile.mockRejectedValue(new Error("ENOENT: no such file or directory"));
    exists.mockResolvedValue(false);
    exec.mockRejectedValue(new Error("cat: /nope: No such file or directory"));

    const el = elevatedExecutor(inner);

    // The unelevated message is the useful one for an absent path; sudo's would replace a
    // clear "not there" with a shell error about the tool used to look.
    await expect(elevatedExecutor(inner).readFile("/nope")).rejects.toThrow(/ENOENT/);
    await expect(el.exists("/nope")).resolves.toBe(false);
  });

  it("asks root before calling a path absent", async () => {
    const { inner, exists, exec } = fakeExecutor();
    exists.mockResolvedValue(false);
    exec.mockResolvedValue("");

    expect(await elevatedExecutor(inner).exists("/etc/letsencrypt/live/x")).toBe(true);
    expect(String(exec.mock.calls[0]?.[0])).toBe(
      elevateCommand(`test -e ${sq("/etc/letsencrypt/live/x")}`),
    );
  });

  it("forwards optional executor methods transparently", async () => {
    const { inner } = fakeExecutor();
    const rawExec = vi.fn(async () => ({
      stdout: {} as never,
      stderr: {} as never,
      onClose: Promise.resolve(0),
      kill: () => {},
    }));
    (inner as unknown as { rawExec: unknown }).rawExec = rawExec;

    const el = elevatedExecutor(inner) as unknown as { rawExec: (c: string) => Promise<unknown> };
    await el.rawExec("docker ps");
    expect(rawExec).toHaveBeenCalledWith("docker ps");
  });
});

/**
 * The two shapes that broke a remote non-root deploy (issue #514): the directory
 * is absent under a `/opt` the user can't create in, or present and root-owned
 * because Docker created it for the edge's bind mount.
 */
describe("ensureOwnedDir", () => {
  const PATH = "/opt/openship/static";

  /** A target that denies unelevated writes unless the tree is already ours. */
  function target(opts: { canSudo: boolean; alreadyWritable?: boolean; loginUser?: string }) {
    const commands: string[] = [];
    const user = opts.loginUser ?? "deploy";
    const executor = {
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        // `resolveEnvironment`'s single-shot probe: a non-root box whose passwordless-sudo
        // capability is exactly what this case declares.
        if (command.includes("opsh_begin")) {
          return probeOutput({ uid: "1000", user, home: `/home/${user}`, sudo: opts.canSudo ? "y" : "n" });
        }
        // The chown owner comes from an UNELEVATED `id -un`, separate from the probe.
        if (command === "id -un") return `${user}\n`;
        if (command.startsWith("sudo -n ")) return "";
        if (command.includes("mkdir -p") && !opts.alreadyWritable) {
          throw new Error("mkdir: cannot create directory '/opt/openship': Permission denied");
        }
        return "";
      }),
    } as unknown as CommandExecutor;
    return { executor, commands };
  }

  it("creates the directory and hands it to the login user when sudo is available", async () => {
    const { executor, commands } = target({ canSudo: true });

    await ensureOwnedDir(executor, PATH);

    // Unwrap the one level of quoting elevateCommand added.
    const inner = commands.find((c) => c.startsWith("sudo -n sh -c "))!.replace(/'\\''/g, "'");
    expect(inner).toContain(`p='${PATH}'`);
    // Without it, a failed mkdir falls through and the chown's exit status is
    // what the caller sees.
    expect(inner).toContain("set -e");
    // Walks up to the TOPMOST dir it had to create: an `mv` needs write
    // permission on the PARENT, so a leaf-only chown would still fail.
    expect(inner).toMatch(/top=\$d/);
    expect(inner).toContain("dirname");
    // The owner comes from the UNELEVATED `id -un`, not from `$SUDO_USER`, which a
    // sudoers env_delete can strip.
    expect(inner).toContain(`chown -R 'deploy' "\${top:-$p}"`);
    expect(inner).not.toContain("SUDO_USER");
  });

  it("falls back to $SUDO_USER when the login probe says nothing", async () => {
    const { executor, commands } = target({ canSudo: true, loginUser: "" });

    await ensureOwnedDir(executor, PATH);

    const inner = commands.find((c) => c.startsWith("sudo -n sh -c "))!.replace(/'\\''/g, "'");
    // Left unexpanded on purpose: an empty owner must fail loudly at chown rather
    // than default to root, which would hand the tree back to a user who still
    // cannot write it.
    expect(inner).toContain('chown -R "$SUDO_USER" "${top:-$p}"');
  });

  it("stays unelevated when the directory is already writable", async () => {
    const { executor, commands } = target({ canSudo: true, alreadyWritable: true });

    await ensureOwnedDir(executor, PATH);

    expect(commands).toEqual([`mkdir -p '${PATH}' && [ -w '${PATH}' ]`]);
  });

  it("names the commands an operator must run when there is no sudo", async () => {
    const { executor } = target({ canSudo: false });

    await expect(ensureOwnedDir(executor, PATH)).rejects.toThrow(
      /sudo mkdir -p \/opt\/openship\/static/,
    );
  });
});
