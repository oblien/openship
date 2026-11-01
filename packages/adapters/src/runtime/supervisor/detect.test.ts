import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalExecutor } from "../../system/local-executor";
import { ENVIRONMENT_PROBE_SCRIPT } from "../../system/environment";
import { OS_RELEASE, probeOutput, type ProbeSpec } from "../../system/environment.fixtures";
import { detectSupervisor } from "./detect";

class Host extends LocalExecutor {
  constructor(private readonly spec: ProbeSpec) {
    super();
  }
  override exec = vi.fn(async (command: string) =>
    command === ENVIRONMENT_PROBE_SCRIPT
      ? probeOutput(this.spec)
      : command.includes("systemctl is-active")
        ? "active"
        : "",
  );
  override writeFile = vi.fn(async (_path: string, _content: string) => {});
  override mkdir = vi.fn(async (_path: string) => {});
}

afterEach(() => vi.restoreAllMocks());

describe("bare process supervisor privileges", () => {
  it("keeps systemd for root without another host probe", async () => {
    const host = new Host({});
    const supervisor = await detectSupervisor(host, "/tmp/workloads");
    expect(supervisor.name).toBe("systemd");
    await supervisor.start("dep-root");
    expect(host.exec.mock.calls.map(([command]) => command)).toEqual([
      ENVIRONMENT_PROBE_SCRIPT,
      "systemctl start 'openship-dep-root.service'",
    ]);
  });

  it("uses the shared privilege gate for a systemd host with passwordless sudo", async () => {
    const host = new Host({ uid: "1000", user: "deploy", home: "/home/deploy", sudo: "y" });
    const supervisor = await detectSupervisor(host, "/tmp/workloads");
    expect(supervisor.name).toBe("systemd");
    await supervisor.start("dep-sudo");
    const command = host.exec.mock.calls.at(-1)![0];
    expect(command).toMatch(/^sudo -n sh -c /);
    expect(command).toContain("systemctl start");
    expect(command).toContain("openship-dep-sudo.service");
    expect(host.exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    { uid: "1000", user: "deploy", sudo: "n" as const },
    { uid: "1000", user: "", sudo: "y" as const },
  ])("uses nohup when a system service cannot preserve the login safely: %j", async (spec) => {
    const warning = vi.spyOn(errorDiagnostics, "warn").mockImplementation(() => {});
    const host = new Host(spec);
    expect((await detectSupervisor(host, "/tmp/workloads")).name).toBe("nohup");
    expect(warning).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("NOT restart after a reboot"));
    expect(host.exec).toHaveBeenCalledTimes(1);
  });

  it("uses sudo only for service management, preserving the workload login and its metadata", async () => {
    const host = new Host({ uid: "1000", user: "deploy", home: "/home/deploy", sudo: "y" });
    const supervisor = await detectSupervisor(host, "/tmp/workloads");
    await supervisor.deploy({
      deploymentId: "dep-sudo",
      projectId: "project",
      workDir: "/tmp/workloads/releases/dep-sudo",
      startCommand: "node server.mjs",
      port: 3000,
      env: {},
    });
    const unit = host.writeFile.mock.calls.find(([, content]) => content.includes("[Service]"))!;
    expect(unit[1]).toContain("User=deploy\n");
    expect(host.exec).toHaveBeenCalledWith(
      "mkdir -p '/tmp/workloads/.artifacts' && [ -w '/tmp/workloads/.artifacts' ]",
    );
    expect(host.writeFile).toHaveBeenCalledWith(
      "/tmp/workloads/.artifacts/dep-sudo.path",
      "/tmp/workloads/releases/dep-sudo",
    );
    expect(
      host.exec.mock.calls.some(
        ([command]) =>
          command.startsWith("sudo -n ") &&
          command.includes("/etc/systemd/system/openship-dep-sudo.service"),
      ),
    ).toBe(true);
  });

  it("does not require a supported package manager to manage existing systemd services", async () => {
    const host = new Host({ osRelease: OS_RELEASE.arch });
    expect((await detectSupervisor(host, "/tmp/workloads")).name).toBe("systemd");
  });

  it("keeps the portable supervisor on hosts without systemd", async () => {
    const host = new Host({ sm: "none", uid: "1000", sudo: "y" });
    expect((await detectSupervisor(host, "/tmp/workloads")).name).toBe("nohup");
    expect(host.exec).toHaveBeenCalledTimes(1);
  });
});
