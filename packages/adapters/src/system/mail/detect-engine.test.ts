import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../../types";
import { containerState } from "../managed-image";
import { detectMailEngine } from "./detect-engine";

const missing = () => new Error("Error: No such object: openship-mail");
const host = (load = "loaded", active = "active") =>
  ["postfix", "dovecot"]
    .map((unit) => `## ${unit}\nLoadState=${load}\nActiveState=${active}`)
    .join("\n");
function executor(inspect: string | Error, units: string | Error = host()) {
  const exec = vi.fn(async (command: string) => {
    const answer = command.startsWith("docker inspect") ? inspect : units;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { exec, target: { exec } as unknown as CommandExecutor };
}

describe("mail topology requires a completed observation", () => {
  it.each([true, false])(
    "reports a confirmed container running=%s without probing legacy units",
    async (running) => {
      const e = executor(`${running}\tmail:1`);
      expect(await detectMailEngine(e.target)).toEqual({
        flavor: "container",
        running,
        image: "mail:1",
        exists: true,
      });
      expect(e.exec).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "connect ENETUNREACH 192.0.2.1:22",
    "SSH connection lost",
    "Cannot connect to the Docker daemon",
    "permission denied while trying to connect to the Docker daemon socket",
  ])("preserves an inconclusive container check: %s", async (message) => {
    const e = executor(new Error(message));
    await expect(detectMailEngine(e.target)).rejects.toThrow(message);
    expect(e.exec).toHaveBeenCalledOnce();
  });

  it.each(["", "unexpected response", "WARNING: no state followed this warning"])(
    "does not turn incomplete Docker output into stopped or missing",
    async (output) => {
      const e = executor(output);
      await expect(detectMailEngine(e.target)).rejects.toThrow("valid container state");
    },
  );

  it("ignores warnings before a valid Docker response", async () => {
    expect(
      await detectMailEngine(executor("WARNING: config unavailable\ntrue\tmail:1").target),
    ).toMatchObject({ flavor: "container", running: true });
  });

  it.each([missing(), new Error("sh: 1: docker: not found")])(
    "recognizes legacy mail after confirmed absence of the container topology",
    async (error) => {
      expect(await detectMailEngine(executor(error).target)).toMatchObject({
        flavor: "host",
        running: true,
      });
    },
  );

  it("reports a confirmed stopped legacy engine", async () => {
    expect(
      await detectMailEngine(executor(missing(), host("loaded", "inactive")).target),
    ).toMatchObject({ flavor: "host", running: false, exists: true });
  });

  it.each([host("not-found", "inactive"), "__OPENSHIP_NO_SYSTEMCTL__"])(
    "reports no engine only after both topologies are ruled out",
    async (units) => {
      expect(await detectMailEngine(executor(missing(), units).target)).toEqual({
        flavor: "none",
        running: false,
        exists: false,
        image: null,
      });
    },
  );

  it("does not report no engine when the connection disappears between the two reads", async () => {
    const e = executor(missing(), new Error("connect ENETUNREACH 192.0.2.1:22"));
    await expect(detectMailEngine(e.target)).rejects.toThrow("ENETUNREACH");
    expect(e.exec).toHaveBeenCalledTimes(2);
  });

  it.each(["", "## postfix\nLoadState=loaded\nActiveState=active\n## dovecot"])(
    "rejects incomplete legacy service state",
    async (units) => {
      await expect(detectMailEngine(executor(missing(), units).target)).rejects.toThrow(
        "complete systemd state",
      );
    },
  );

  it("preserves the existing best-effort contract for other managed-image callers", async () => {
    const e = executor(new Error("connect ENETUNREACH 192.0.2.1:22"));
    expect(await containerState(e.target, "openship-edge")).toBeNull();
    await expect(containerState(e.target, "openship-mail", { strict: true })).rejects.toThrow(
      "ENETUNREACH",
    );
  });
});
