import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("@repo/adapters", () => ({
  HOST_STATE_DIR: "/root/.openship",
  privilegedExecutor: async () => ({
    supported: true,
    value: { executor: { exec: h.exec }, elevation: "root", profile: { loginUser: "root" } },
  }),
}));
import { readState } from "@repo/platform/engine/modules/mail/mail-state";

beforeEach(() => {
  h.exec.mockReset();
});

describe("mail status reads cannot infer absence from an unavailable state file", () => {
  it.each([
    "connect ENETUNREACH 192.0.2.1:22",
    "SSH connection lost",
    "cat: /root/.openship/mail-state.json: Permission denied",
  ])("preserves the failed observation: %s", async (message) => {
    h.exec.mockRejectedValueOnce(new Error(message));
    await expect(readState({} as never, { strict: true })).rejects.toThrow(message);
    expect(h.exec).toHaveBeenCalledOnce();
    expect(h.exec.mock.calls[0][0]).toBe("cat '/root/.openship/mail-state.json'");
  });

  it("returns no state only when the target confirms that the file is absent", async () => {
    h.exec.mockRejectedValueOnce(
      new Error("cat: /root/.openship/mail-state.json: No such file or directory"),
    );
    expect(await readState({} as never, { strict: true })).toBeNull();
  });

  it.each(['{"version":', '{"version":999}'])(
    "does not offer a fresh installation for unreadable saved state",
    async (raw) => {
      h.exec.mockResolvedValueOnce(raw);
      await expect(readState({} as never, { strict: true })).rejects.toThrow(
        "saved mail setup state could not be read",
      );
    },
  );

  it("recovers on a later successful read without writing any server state", async () => {
    h.exec.mockRejectedValueOnce(new Error("connect ENETDOWN"));
    await expect(readState({} as never, { strict: true })).rejects.toThrow("ENETDOWN");
    h.exec.mockResolvedValueOnce(
      JSON.stringify({ version: 1, serverId: "srv-1", domain: "example.com" }),
    );
    expect(await readState({} as never, { strict: true })).toMatchObject({
      serverId: "srv-1",
      domain: "example.com",
    });
    expect(h.exec.mock.calls.every(([command]) => command.startsWith("cat "))).toBe(true);
  });
});
