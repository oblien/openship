import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { elevatedExecutor, elevateCommand, ensureOwnedDir } from "./elevated-executor";
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

  it("stages writeFile to a temp then moves it into place as root", async () => {
    const { inner, writeFile, exec } = fakeExecutor();
    const el = elevatedExecutor(inner);

    await el.writeFile("/etc/openresty/nginx.conf", "worker_processes 1;");

    // 1. staged into a user-writable temp (unelevated write)
    const staged = writeFile.mock.calls[0]!;
    expect(String(staged[0])).toMatch(/^\/tmp\/\.openship-elev-/);
    expect(staged[1]).toBe("worker_processes 1;");

    // 2. moved into place via a single elevated command
    const mv = String(exec.mock.calls[0]?.[0]);
    expect(mv.startsWith("sudo -n sh -c ")).toBe(true);
    expect(mv).toContain("mkdir -p");
    expect(mv).toContain("mv -f");
    expect(mv).toContain(sq("/etc/openresty/nginx.conf"));
  });

  it("elevates mkdir and rm", async () => {
    const { inner, exec } = fakeExecutor();
    const el = elevatedExecutor(inner);

    await el.mkdir("/etc/openresty");
    await el.rm("/usr/local/openresty");

    expect(exec.mock.calls[0]?.[0]).toBe(elevateCommand(`mkdir -p ${sq("/etc/openresty")}`));
    expect(exec.mock.calls[1]?.[0]).toBe(elevateCommand(`rm -rf ${sq("/usr/local/openresty")}`));
  });

  it("passes reads and transfers straight through (no sudo)", async () => {
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
  function target(opts: { canSudo: boolean; alreadyWritable?: boolean }) {
    const commands: string[] = [];
    const executor = {
      exec: vi.fn(async (command: string) => {
        commands.push(command);
        if (command === "id -u") return "1000";
        if (command.startsWith("sudo -n true")) return opts.canSudo ? "yes" : "no";
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
    expect(inner).toContain(`mkdir -p '${PATH}'`);
    // $top, not the leaf: an `mv` needs write permission on the PARENT.
    expect(inner).toContain(`while [ ! -d "$d" ]; do top="$d"; d=$(dirname "$d"); done`);
    expect(inner).toContain(`chown -R "$SUDO_USER" "$top"`);
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
