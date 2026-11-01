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

vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withHostExecutor: h.withHostExecutor },
}));

const {
  APP_CONFIG_HOST_ROOT,
  appConfigHostPath,
  appConfigHostServiceRoot,
  withAppConfigHost,
  writeAppConfigFile,
} = await import("@repo/platform/engine/modules/deployments/compose/app-config-host");

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
    expect(
      await withAppConfigHost({ executor: LOCAL, localHost: true, isCloud: true }, fn),
    ).toEqual({ ran: false });
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
    expect(appConfigHostPath("proj1", "..", "/x.yml")).toBe(
      `${APP_CONFIG_HOST_ROOT}/proj1/_/x.yml`,
    );
  });

  it("sanitizes both ownership segments for the private service root", () => {
    expect(appConfigHostServiceRoot("../project", "..")).toBe(
      `${APP_CONFIG_HOST_ROOT}/.._project/_`,
    );
  });

  it("refuses a traversal in the template-supplied container path", () => {
    // Template-authored and written on the HOST — escaping the root would write
    // anywhere root can.
    expect(() => appConfigHostPath("proj1", "kong", "/../../etc/cron.d/x")).toThrow(
      /generated-config-path-invalid/,
    );
  });

  it.each(["relative.yml", "/etc/app.yml:rw", "/etc/app.yml\nnext", "/"])(
    "refuses unsafe bind target %j",
    (path) => {
      expect(() => appConfigHostPath("proj1", "kong", path)).toThrow(
        /generated-config-path-invalid/,
      );
    },
  );

  it("refuses non-normalized targets before deriving a host path", () => {
    expect(() => appConfigHostPath("proj1", "kong", "/etc//kong.yml")).toThrow(
      /generated-config-path-invalid/,
    );
  });
});

describe("writeAppConfigFile", () => {
  it("names the requirement, the file and the underlying error on failure", async () => {
    const writer = {
      exec: async () => "",
      mkdir: async () => undefined,
      rename: async () => undefined,
      rm: async () => undefined,
      writeFile: async () => {
        throw new Error("Timed out while waiting for handshake");
      },
    } as unknown as CommandExecutor;

    await expect(
      writeAppConfigFile(
        writer,
        "/var/lib/openship/app-config/p/kong/kong.yml",
        "x",
        "kong",
        "/kong.yml",
      ),
    ).rejects.toThrow(
      /Service "kong".*\/kong\.yml.*HOST path.*Timed out while waiting for handshake/s,
    );
  });

  it("atomically replaces the target and protects its host directory", async () => {
    const writes: Array<[string, string, { mode?: number } | undefined]> = [];
    const renames: Array<[string, string]> = [];
    const removals: string[] = [];
    const mkdir = vi.fn(async () => undefined);
    const exec = vi.fn(async () => "");
    const writer = {
      exec,
      mkdir,
      writeFile: async (p: string, c: string, opts?: { mode?: number }) =>
        void writes.push([p, c, opts]),
      rename: async (from: string, to: string) => void renames.push([from, to]),
      rm: async (path: string) => void removals.push(path),
    } as unknown as CommandExecutor;
    await writeAppConfigFile(
      writer,
      "/host/kong.yml",
      "_format_version: '3.0'",
      "kong",
      "/kong.yml",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toMatch(/^\/host\/kong\.yml\.openship-[\w-]+\.tmp$/);
    expect(writes[0]?.slice(1)).toEqual(["_format_version: '3.0'", { mode: 0o644 }]);
    expect(mkdir).toHaveBeenCalledWith("/host");
    expect(exec).toHaveBeenCalledWith("chmod 0700 -- '/host'");
    expect(renames).toEqual([[writes[0]![0], "/host/kong.yml"]]);
    expect(removals).toEqual([writes[0]![0]]);
  });

  it("fails closed when the target file channel cannot rename atomically", async () => {
    const writeFile = vi.fn(async () => undefined);
    const rm = vi.fn(async () => undefined);
    const writer = { writeFile, rm } as unknown as CommandExecutor;

    await expect(
      writeAppConfigFile(writer, "/host/kong.yml", "secret", "kong", "/kong.yml"),
    ).rejects.toThrow(/does not support atomic rename/);

    expect(writeFile).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledOnce();
  });
});
