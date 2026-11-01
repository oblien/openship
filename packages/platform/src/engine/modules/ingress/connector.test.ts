import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "@repo/adapters";
import type { IngressConnection } from "@repo/db";
import { manageConnector } from "./connector";
const c = { id: "igc_test", tunnelId: "tunnel-test" } as IngressConnection;
const owner = JSON.stringify({ connectionId: c.id, tunnelId: c.tunnelId });
function executor(
  options: {
    mode?: string;
    present?: boolean;
    foreign?: boolean;
    uid?: string;
    dockerUnavailable?: boolean;
    unit?: string;
    sameToken?: boolean;
    active?: boolean;
    dockerExists?: boolean;
  } = {},
) {
  const files = new Map<string, { content: string; mode?: number }>();
  const exec = vi.fn(async (cmd: string) => {
    if (cmd === "id -u") return options.uid ?? "0";
    if (cmd.includes("sudo -n true")) return "no";
    if (cmd === "uname -s") return "Linux";
    if (cmd === "uname -m") return "aarch64";
    if (cmd.includes("cat ") && cmd.includes("/owner.json")) return options.foreign ? "{}" : owner;
    if (cmd.includes("cat ") && cmd.includes("/runtime"))
      return options.mode === "docker" ? "docker" : "systemd";
    if (cmd.includes("cat ") && cmd.includes(".service")) return options.unit ?? "foreign service";
    if (cmd.includes("test -e") && cmd.includes(".service")) return options.unit ? "yes" : "no";
    if (cmd.includes("test -e") && cmd.includes("/etc/openship/ingress/"))
      return options.present ? "yes" : "no";
    if (cmd.includes("test -f") && cmd.includes("/runtime")) return options.present ? "yes" : "no";
    if (cmd.includes("systemctl --version")) return options.mode ?? "systemd 252";
    if (cmd.includes("command -v docker"))
      return options.mode === "docker" || options.mode === "systemd 240" ? "yes" : "no";
    if (cmd.includes("cmp -s")) return options.sameToken ? "yes" : "no";
    if (cmd.includes("systemctl is-active")) return options.active ? "active" : "inactive";
    if (cmd.includes("docker inspect")) return c.id;
    if (cmd.includes("docker ps")) {
      if (options.dockerUnavailable) throw new Error("Docker unavailable");
      return options.dockerExists ? "openship-cloudflare-igc_test" : "";
    }
    if (cmd.startsWith("mktemp")) return "/tmp/openship-ingress.ABC123";
    if (cmd.includes("test -f")) return "no";
    return "";
  });
  const writeFile = vi.fn(async (path: string, content: string, opts?: { mode?: number }) => {
    files.set(path, { content, mode: opts?.mode });
  });
  return {
    exec,
    writeFile,
    rm: vi.fn(async () => {}),
    files,
    adapter: { exec, writeFile, rm: vi.fn(async () => {}) } as unknown as CommandExecutor,
  };
}
describe("destination-owned cloudflared connector", () => {
  it("installs a checksum-verified native binary and a credential-isolated service without logging the token", async () => {
    const e = executor();
    await manageConnector(e.adapter, c, "sensitive-token");
    expect(e.files.get("/tmp/openship-ingress.ABC123/token")).toEqual({
      content: "sensitive-token",
      mode: 0o600,
    });
    const unit = e.files.get("/tmp/openship-ingress.ABC123/unit")?.content ?? "";
    expect(unit).toContain("\nDynamicUser=yes\n");
    expect(unit).toContain("LoadCredential=token:/etc/openship/ingress/igc_test/token");
    expect(unit).toContain(
      "--token-file /run/credentials/openship-cloudflare-igc_test.service/token",
    );
    const commands = e.exec.mock.calls.map(([cmd]) => cmd);
    expect(commands.join("\n")).not.toContain("sensitive-token");
    expect(commands.join("\n")).not.toContain("docker run");
    expect(commands.join("\n")).toContain("cloudflared-linux-arm64");
    const checksum = commands.find((cmd) => cmd.includes("sha256sum -c -"))!;
    const bytes = execFileSync("sh", ["-c", checksum.split("|")[0]]).toString();
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes).not.toContain("\\n");
    expect(bytes).toContain("/tmp/openship-ingress.ABC123/cloudflared");
  });
  it.each(["docker", "systemd 240"])(
    "uses a pinned nonprivileged Docker fallback on %s without a Docker socket mount",
    async (mode) => {
      const e = executor({ mode });
      await manageConnector(e.adapter, c, "sensitive-token");
      const run = e.exec.mock.calls.map(([cmd]) => cmd).find((cmd) => cmd.includes("docker run"))!;
      expect(run).toContain("@sha256:");
      expect(run).toContain("--network host");
      expect(run).toContain("--read-only");
      expect(run).toContain("--cap-drop ALL");
      expect(run).toContain("--user 65532:65532");
      expect(run).toContain("readonly");
      expect(run).not.toContain("docker.sock");
      expect(run).not.toContain("--privileged");
      expect(run).not.toContain("sensitive-token");
    },
  );
  it("does not delete ownership metadata when the Docker daemon cannot confirm cleanup", async () => {
    const e = executor({ mode: "docker", present: true, dockerUnavailable: true });
    await expect(manageConnector(e.adapter, c, null, true)).rejects.toThrow("Docker unavailable");
    expect(e.exec.mock.calls.some(([cmd]) => cmd.includes("rm -rf"))).toBe(false);
  });
  it("refuses foreign directories and changed service units before modifying them", async () => {
    for (const options of [
      { present: true, foreign: true },
      { present: true, unit: "foreign service" },
    ]) {
      const e = executor(options);
      await expect(manageConnector(e.adapter, c, null, true)).rejects.toThrow(
        /owned|edited outside/,
      );
      expect(
        e.exec.mock.calls.some(([cmd]) => cmd.includes("disable --now") || cmd.includes("rm -rf")),
      ).toBe(false);
    }
  });
  it("leaves a healthy native connector running on retry and reloads it after token rotation", async () => {
    const initial = executor();
    await manageConnector(initial.adapter, c, "token");
    const unit = initial.files.get("/tmp/openship-ingress.ABC123/unit")!.content;
    const unchanged = executor({ present: true, unit, active: true, sameToken: true });
    await manageConnector(unchanged.adapter, c, "token");
    expect(unchanged.exec.mock.calls.some(([cmd]) => cmd.includes("systemctl restart"))).toBe(
      false,
    );
    const rotated = executor({ present: true, unit, active: true, sameToken: false });
    await manageConnector(rotated.adapter, c, "new-token");
    expect(rotated.exec.mock.calls.some(([cmd]) => cmd.includes("systemctl restart"))).toBe(true);
  });
  it("recreates only its owned Docker connector after token rotation", async () => {
    const unchanged = executor({
      mode: "docker",
      present: true,
      dockerExists: true,
      sameToken: true,
    });
    await manageConnector(unchanged.adapter, c, "token");
    expect(unchanged.exec.mock.calls.some(([cmd]) => cmd.includes("docker rm"))).toBe(false);
    const rotated = executor({
      mode: "docker",
      present: true,
      dockerExists: true,
      sameToken: false,
    });
    await manageConnector(rotated.adapter, c, "new-token");
    expect(rotated.exec.mock.calls.some(([cmd]) => cmd.includes("docker rm -f"))).toBe(true);
    expect(rotated.exec.mock.calls.some(([cmd]) => cmd.includes("docker run"))).toBe(true);
  });
  it("requires host privileges and rejects shell-unsafe identities before any command", async () => {
    const e = executor({ uid: "1000" });
    await expect(manageConnector(e.adapter, c, "token")).rejects.toThrow(
      /root or passwordless sudo/,
    );
    expect(e.writeFile).not.toHaveBeenCalled();
    const safe = executor();
    await expect(
      manageConnector(safe.adapter, { ...c, id: "'; touch /tmp/owned" }, "token"),
    ).rejects.toThrow(/identity/);
    expect(safe.exec).not.toHaveBeenCalled();
  });
});
