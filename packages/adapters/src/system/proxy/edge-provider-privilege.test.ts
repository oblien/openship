import { afterEach, describe, expect, it, vi } from "vitest";

import { OS_RELEASE, probeOutput } from "../environment.fixtures";
import { invalidateEnvironment } from "../environment";
import { containerEdgeProvider } from "./ensure-container-edge";
import type { CommandExecutor } from "../../types";

/**
 * Privilege for the edge a deploy actually drives.
 *
 * This is the one failure in the whole host-resolver area that produced NO error. Every
 * side of the container-edge path needs root on a non-root login — vhosts land in
 * root-owned `/var/lib/openship/edge`, `/etc/letsencrypt` is 0700, `docker exec` needs
 * the daemon socket — and `edgeContainerExecutor`'s docstring said privilege was the
 * caller's problem, which no caller then solved. Routing gaps never fail a deploy, so a
 * deploy to `deploy@host` built the app, ran it, reported success, and routed nothing.
 *
 * The provider's executor is reached through a cast because it is private and should
 * stay private: what is under test is the WIRING decided in `containerEdgeProvider`, and
 * asserting it any other way would mean driving a full vhost write to observe one
 * command prefix.
 */
function probeHost(spec: Parameters<typeof probeOutput>[0]) {
  const commands: string[] = [];
  const executor = {
    exec: vi.fn(async (command: string) => {
      commands.push(command);
      return command.includes("opsh_begin") ? probeOutput(spec) : "";
    }),
    streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async () => true),
    mkdir: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
  return { executor, commands };
}

/** The provider's own executor — the composition of elevation and `docker exec`. */
async function providerExecutor(executor: CommandExecutor): Promise<CommandExecutor> {
  const provider = await containerEdgeProvider(executor, "openship-edge");
  return (provider as unknown as { executor: CommandExecutor }).executor;
}

const ROOT = { osRelease: OS_RELEASE.ubuntu2404 };
const NON_ROOT_SUDO = {
  osRelease: OS_RELEASE.ubuntu2404,
  uid: "1000",
  user: "deploy",
  home: "/home/deploy",
  sudo: "y" as const,
};
const NON_ROOT_NO_SUDO = { ...NON_ROOT_SUDO, sudo: "n" as const };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("containerEdgeProvider privilege", () => {
  it("elevates UNDER the container layer, so file ops are elevated too", async () => {
    const { executor, commands } = probeHost(NON_ROOT_SUDO);
    const edge = await providerExecutor(executor);

    await edge.exec("openresty -s reload");
    // Elevation on the OUTSIDE would produce the same string for `exec` and leave
    // `writeFile` — which passes through to the inner executor — unelevated. The order
    // is what makes both halves work, so it is pinned rather than implied.
    const reload = commands.at(-1)!;
    expect(reload.startsWith("sudo -n sh -c ")).toBe(true);
    expect(reload).toContain("docker exec");

    await edge.writeFile("/var/lib/openship/edge/sites/app.conf", "server {}");
    // Staged as the login user, published into the root-owned dir as root, then cleaned
    // up. Every one of those runs on the HOST with no `docker exec`: the staging dir must
    // be on the same side of the mount as the file, or a dir created in the container
    // would leave the host's staging dir to be made — 0755 — by the write itself.
    const staging = commands.filter((c) => c.includes("openship-elev"));
    expect(staging.some((c) => c.includes("docker exec"))).toBe(false);
    expect(staging[0]).toMatch(/^mkdir -m 700 /);
    expect(staging[1]).toMatch(/^sudo -n sh -c .*chown 0:0 .* && mv -f /);
    expect(staging.at(-1)).toMatch(/^rm -rf /);
  });

  it("leaves a root login byte-for-byte as it was", async () => {
    const { executor, commands } = probeHost(ROOT);
    const edge = await providerExecutor(executor);

    await edge.exec("openresty -s reload");
    expect(commands.at(-1)).toBe("docker exec 'openship-edge' sh -c 'openresty -s reload'");
  });

  // Routing is best-effort by design, so an unprivileged box must still get whatever it
  // can — but the reason has to be SAID. Failing silently is what shipped; failing the
  // deploy would be a different regression, because the app itself is fine.
  it("names the privilege problem instead of failing, when the login can't elevate", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { executor, commands } = probeHost(NON_ROOT_NO_SUDO);
    const edge = await providerExecutor(executor);

    await edge.exec("openresty -s reload");
    expect(commands.at(-1)).not.toContain("sudo");

    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toMatch(/passwordless sudo/);
    expect(said).toMatch(/routing will be incomplete|deploy continues/i);
  });

  // A box the resolver cannot measure at all (a login banner, an sshd ForceCommand) is
  // still a box whose files we may be able to write. `detectOpenRestyPaths` throwing here
  // is what turned a firewalled host channel into a failed deploy in #490; a probe that
  // cannot answer must degrade the same way.
  it("continues unelevated when the host cannot be measured", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const executor = {
      exec: vi.fn(async () => {
        throw new Error("All configured authentication methods failed");
      }),
      streamExec: vi.fn(async () => ({ code: 1, output: "" })),
      writeFile: vi.fn(async () => {}),
      readFile: vi.fn(async () => ""),
      exists: vi.fn(async () => false),
      mkdir: vi.fn(async () => {}),
      rm: vi.fn(async () => {}),
    } as unknown as CommandExecutor;

    await expect(providerExecutor(executor)).resolves.toBeDefined();
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toMatch(/could not check this host's privileges/);
    // The work, not just the cause: this is the one arm where nothing about the host was
    // measured, so the step being degraded is the only thing the operator can act on.
    expect(said).toMatch(/Configuring routing and TLS/);
    // The consequence, not just the cause: "couldn't measure" alone tells an operator
    // nothing about why their domain 502s.
    expect(said).toMatch(/routing will be incomplete/);
    invalidateEnvironment(executor);
  });
});
