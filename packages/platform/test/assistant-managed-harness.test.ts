import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "@repo/adapters";
import type { AssistantNativeClient } from "../src/engine/modules/assistant/native-target";
import { managedHarness } from "../src/engine/modules/assistant/managed-harness";

function fixture() {
  const files = new Map<string, string>();
  const directory = "/private/member/assistant-setup";
  let status = { running: false, started: false, ok: false };
  const setup = vi.fn(async () => {
    status = { running: true, started: true, ok: false };
  });
  const update = vi.fn(async () => {
    status = { running: true, started: true, ok: false };
  });
  const withAgent = vi.fn(() => ({ setupStatus: async () => status, setup, update }));
  const native = {
    healthy: vi.fn(() => true),
    close: vi.fn(),
    mindwire: { withAgent },
  } as unknown as AssistantNativeClient;
  const connect = vi.fn(async () => native);
  const tools = managedHarness({
    directory,
    connect,
    executor: {
      exists: async (path: string) => files.has(path),
      readFile: async (path: string) => files.get(path)!,
    } as CommandExecutor,
  });
  return {
    tools,
    files,
    directory,
    native,
    connect,
    setup,
    update,
    withAgent,
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}

describe("managed Cloud harness installation", () => {
  it("does not connect or install when settings inspect a fresh runtime", async () => {
    const f = fixture();
    expect(await f.tools.state("codex")).toBeUndefined();
    expect(await f.tools.executable("codex")).toBeUndefined();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.setup).not.toHaveBeenCalled();
  });

  it("uses Mindwire setup, rejoins a running job, reports failure and repairs on explicit retry", async () => {
    const f = fixture();
    await f.tools.start("claude");
    expect(f.withAgent).toHaveBeenCalledWith("claude-code");
    expect(f.setup).toHaveBeenCalledTimes(1);
    await f.tools.start("claude");
    expect(f.setup).toHaveBeenCalledTimes(1);
    f.files.set(`${f.directory}/service.json`, "private service record");
    expect(await f.tools.state("claude")).toEqual({ state: "installing" });
    f.setStatus({ running: false, started: true, ok: false });
    expect(await f.tools.state("claude")).toEqual({ state: "failed" });
    expect(f.update).not.toHaveBeenCalled();
    await f.tools.start("claude");
    expect(f.update).toHaveBeenCalledTimes(1);
    f.setStatus({ running: false, started: true, ok: true });
    expect(await f.tools.state("claude")).toBeUndefined();
    await f.tools.close();
    expect(f.native.close).toHaveBeenCalledTimes(1);
  });

  it("can repair a previously successful installation that no longer passes the execution probe", async () => {
    const f = fixture();
    f.setStatus({ running: false, started: true, ok: true });
    await f.tools.start("codex");
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it("reads exact private managed versions without placing selections in the scoped execution profile", async () => {
    const f = fixture();
    f.files.set(
      `${f.directory}/toolchains/codex/selected.json`,
      JSON.stringify({ version: "0.166.0" }),
    );
    f.files.set(
      `${f.directory}/toolchains/claude/selected.json`,
      JSON.stringify({ version: "2.2.0" }),
    );
    expect(await f.tools.executable("codex")).toBe(
      `${f.directory}/toolchains/codex/versions/0.166.0/bin/codex`,
    );
    expect(await f.tools.executable("claude")).toBe(
      `${f.directory}/toolchains/claude/versions/2.2.0/bin/claude`,
    );
    expect(f.connect).not.toHaveBeenCalled();
    for (const version of ["../../other-member", "/bin/sh", "0.166.0;touch /tmp/unsafe", null]) {
      f.files.set(`${f.directory}/toolchains/codex/selected.json`, JSON.stringify({ version }));
      await expect(f.tools.executable("codex")).rejects.toThrow("Invalid managed agent version");
    }
  });

  it("recovers a failed connection and reconnects an unhealthy installation transport", async () => {
    const f = fixture();
    f.connect.mockRejectedValueOnce(new Error("Runtime offline"));
    await expect(f.tools.start("codex")).rejects.toThrow("Runtime offline");
    await f.tools.start("codex");
    expect(f.connect).toHaveBeenCalledTimes(2);
    vi.mocked(f.native.healthy).mockReturnValueOnce(false);
    await f.tools.start("codex");
    expect(f.native.close).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(3);
  });

  it("shares one reconnect when both providers refresh after a transport failure", async () => {
    const f = fixture();
    f.files.set(`${f.directory}/service.json`, "private service record");
    await f.tools.state("codex");
    vi.mocked(f.native.healthy).mockReturnValue(false);
    f.connect.mockResolvedValue({ ...f.native, healthy: () => true });
    let finishClose!: () => void;
    vi.mocked(f.native.close).mockReturnValue(
      new Promise<void>((resolve) => {
        finishClose = resolve;
      }),
    );
    const refresh = Promise.all([f.tools.state("codex"), f.tools.state("claude")]);
    await vi.waitFor(() => expect(f.native.close).toHaveBeenCalled());
    finishClose();
    await refresh;
    expect(f.native.close).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(2);
  });
});
