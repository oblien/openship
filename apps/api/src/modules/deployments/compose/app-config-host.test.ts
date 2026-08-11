import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandExecutor } from "@repo/adapters";

/**
 * An app template's generated config files are bind-mounted by HOST path, so the one
 * thing that must never happen is writing them with an executor that reaches a
 * different machine than the Docker daemon. On a Compose install `platform.executor`
 * for a plain local target is a LocalExecutor — the api CONTAINER — and a write there
 * SUCCEEDS, after which Docker mounts an empty directory over the file the service
 * needs. That failure mode has no error to follow, which is how it hid inside #490.
 */
const h = vi.hoisted(() => ({
  withHostExecutor: vi.fn(async (fn: (e: CommandExecutor) => Promise<void>) =>
    fn({ tag: "host-channel" } as unknown as CommandExecutor),
  ),
}));

vi.mock("../../../lib/ssh-manager", () => ({
  sshManager: { withHostExecutor: h.withHostExecutor },
}));

const { APP_CONFIG_HOST_ROOT, appConfigHostPath, withAppConfigHost, writeAppConfigFile } =
  await import("./app-config-host");

const LOCAL = { tag: "local-executor" } as unknown as CommandExecutor;
const REMOTE = { tag: "remote-ssh" } as unknown as CommandExecutor;

describe("withAppConfigHost", () => {
  // Block body on purpose: `mockClear()` returns the mock, and a function returned
  // from beforeEach is taken as its teardown and called with no arguments.
  beforeEach(() => {
    h.withHostExecutor.mockClear();
  });

  it("writes through the host channel when the target is this box", async () => {
    const seen: CommandExecutor[] = [];
    const { ran } = await withAppConfigHost(
      // The executor a local target carries is the container's own filesystem; the
      // point of the branch is that it is NOT the one used.
      { executor: LOCAL, localHost: true, isCloud: false },
      async (host) => void seen.push(host),
    );
    expect(ran).toBe(true);
    expect(h.withHostExecutor).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ tag: "host-channel" }]);
  });

  it("uses the server's own executor for a remote target", async () => {
    const seen: CommandExecutor[] = [];
    const { ran } = await withAppConfigHost(
      { executor: REMOTE, localHost: false, isCloud: false },
      async (host) => void seen.push(host),
    );
    expect(ran).toBe(true);
    expect(seen).toEqual([REMOTE]);
    // A remote box's files must never be written over the LOCAL host channel.
    expect(h.withHostExecutor).not.toHaveBeenCalled();
  });

  it("propagates an unusable host channel instead of writing somewhere else", async () => {
    h.withHostExecutor.mockRejectedValueOnce(new Error("host channel unreachable"));
    await expect(
      withAppConfigHost({ executor: LOCAL, localHost: true, isCloud: false }, async () => {}),
    ).rejects.toThrow(/host channel unreachable/);
  });

  it("runs nothing on cloud, which mounts no host paths", async () => {
    const fn = vi.fn();
    expect(await withAppConfigHost({ executor: LOCAL, localHost: true, isCloud: true }, fn)).toEqual(
      { ran: false },
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it("runs nothing for a remote target with no executor", async () => {
    const fn = vi.fn();
    expect(
      await withAppConfigHost({ executor: null, localHost: false, isCloud: false }, fn),
    ).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("appConfigHostPath", () => {
  it("nests by project and service under the host root", () => {
    expect(appConfigHostPath("proj1", "kong", "/etc/kong/kong.yml")).toBe(
      `${APP_CONFIG_HOST_ROOT}/proj1/kong/etc/kong/kong.yml`,
    );
  });

  it("sanitizes a service name that could reshape the path", () => {
    expect(appConfigHostPath("proj1", "a/b c", "/x.yml")).toBe(
      `${APP_CONFIG_HOST_ROOT}/proj1/a_b_c/x.yml`,
    );
  });

  it("refuses a traversal in the template-supplied container path", () => {
    // Template-authored and written on the HOST — escaping the root would write
    // anywhere root can.
    expect(() => appConfigHostPath("proj1", "kong", "/../../etc/cron.d/x")).toThrow(/traversal/);
  });
});

describe("writeAppConfigFile", () => {
  it("names the requirement, the file and the underlying error on failure", async () => {
    const writer = {
      writeFile: async () => {
        throw new Error("Timed out while waiting for handshake");
      },
    } as unknown as CommandExecutor;

    await expect(
      writeAppConfigFile(writer, "/var/lib/openship/app-config/p/kong/kong.yml", "x", "kong", "/kong.yml"),
    ).rejects.toThrow(
      /Service "kong".*\/kong\.yml.*HOST path.*Timed out while waiting for handshake/s,
    );
  });

  it("passes the content straight through on success", async () => {
    const calls: Array<[string, string]> = [];
    const writer = {
      writeFile: async (p: string, c: string) => void calls.push([p, c]),
    } as unknown as CommandExecutor;
    await writeAppConfigFile(writer, "/host/kong.yml", "_format_version: '3.0'", "kong", "/kong.yml");
    expect(calls).toEqual([["/host/kong.yml", "_format_version: '3.0'"]]);
  });
});
