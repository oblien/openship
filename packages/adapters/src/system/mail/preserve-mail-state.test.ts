import { describe, expect, it, vi } from "vitest";
import { preserveMailState } from "./preserve-mail-state";
import { MAIL_CONTAINER_MOUNTS } from "../../infra/mail-container";

vi.mock("../environment", () => ({
  resolveEnvironment: async () => ({ isRoot: false, canSudo: true }),
}));

describe("mail state preservation identity checks", () => {
  it.each([
    "",
    "broken\ttrue\t[]",
    `${"a".repeat(64)}\tunknown\t[]`,
    `${"a".repeat(64)}\ttrue\tnull`,
  ])("refuses an unverified container before mutating it (%s)", async (raw) => {
    const exec = vi.fn(async () => raw);
    await expect(preserveMailState({ exec } as never, "openship-mail")).rejects.toThrow();
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("keeps a live container untouched when the retained mounts already match", async () => {
    const mounted = MAIL_CONTAINER_MOUNTS.map((m) => ({
      Type: "bind",
      Source: m.host,
      Destination: m.container,
    }));
    const exec = vi.fn(async () => `${"a".repeat(64)}\ttrue\t${JSON.stringify(mounted)}`);
    await preserveMailState({ exec } as never, "openship-mail");
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it("refuses an operator's custom log mount instead of replacing it", async () => {
    const exec = vi.fn(
      async () =>
        `${"a".repeat(64)}\ttrue\t${JSON.stringify([
          { Type: "bind", Source: "/custom-mail-logs", Destination: "/var/log" },
        ])}`,
    );
    await expect(preserveMailState({ exec } as never, "openship-mail")).rejects.toThrow(
      "custom mount",
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("pins the login user's rootless daemon before filesystem privilege is elevated", async () => {
    const exec = vi.fn(async (command: string) => {
      if (command.includes("{{json .Mounts}}")) return `${"a".repeat(64)}\ttrue\t[]`;
      if (command.includes("printenv DOCKER_HOST")) return "unix:///run/user/1000/docker.sock\n";
      return "";
    });
    await preserveMailState({ exec } as never, "openship-mail");
    const mutation = exec.mock.calls[2]![0];
    expect(mutation).toContain("sudo -n sh -c");
    expect(mutation).toContain("docker --host");
    expect(mutation).toContain("unix:///run/user/1000/docker.sock");
    expect(mutation).not.toContain("docker stop");
    expect(mutation).not.toContain("docker cp");
  });
  it("refuses a remote Docker context before touching local host state", async () => {
    const exec = vi.fn(async (command: string) =>
      command.includes("{{json .Mounts}}") ? `${"a".repeat(64)}\ttrue\t[]` : "ssh://other-host",
    );
    await expect(preserveMailState({ exec } as never, "openship-mail")).rejects.toThrow(
      "local Docker socket",
    );
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
