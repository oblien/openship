import { describe, expect, it, vi } from "vitest";
import { ensureDockerEmulation, probeDockerExecutionPlatforms } from "./docker-platforms";
import { probeActionCapabilities } from "../actions/worker";
import type { CommandExecutor } from "../types";

function endpoint(native = "linux/amd64", already = false, installFails = false) {
  let enabled = already;
  let mounted = already;
  const exec = vi.fn(async (command: string) => {
    if (command.includes("nsenter")) {
      mounted = true;
      return "";
    }
    if (command.includes("--install")) {
      if (installFails) throw new Error("binfmt registration denied");
      enabled = true;
      return "";
    }
    if (command.includes("--read-only"))
      return enabled && mounted ? (native === "linux/amd64" ? "aarch64\n" : "x86_64\n") : "";
    return "";
  });
  return { exec, executor: { exec } as unknown as CommandExecutor };
}

describe("Docker CPU emulation", () => {
  it("routine probing does not download images or enable privileged emulators", async () => {
    const { exec, executor } = endpoint();
    expect(await probeDockerExecutionPlatforms(executor, "x64")).toEqual(["linux/amd64"]);
    expect(
      exec.mock.calls.every(
        ([command]) => !command.includes("docker pull") && !command.includes("--privileged"),
      ),
    ).toBe(true);
  });
  it("registers only the missing architecture and verifies real execution support", async () => {
    const { exec, executor } = endpoint();
    expect(await ensureDockerEmulation(executor, "x64")).toEqual(["linux/amd64", "linux/arm64"]);
    const setup = exec.mock.calls.find(([command]) => command.includes("--install"))![0];
    expect(setup).toContain("--install 'arm64'");
    expect(setup).not.toContain("--uninstall");
    expect(setup).toContain("@sha256:");
  });
  it("supports the opposite direction and leaves an existing emulator alone", async () => {
    const fresh = endpoint("linux/arm64");
    await ensureDockerEmulation(fresh.executor, "arm64");
    expect(fresh.exec.mock.calls.find(([command]) => command.includes("--install"))![0]).toContain(
      "--install 'amd64'",
    );
    const ready = endpoint("linux/amd64", true);
    await ensureDockerEmulation(ready.executor, "x64");
    expect(ready.exec.mock.calls.some(([command]) => command.includes("--privileged"))).toBe(false);
  });
  it("does not advertise capabilities when host registration failed", async () => {
    const { executor } = endpoint("linux/amd64", false, true);
    await expect(ensureDockerEmulation(executor, "x64")).rejects.toMatchObject({
      code: "DOCKER_EMULATION_UNAVAILABLE",
    });
  });
  it("does not advertise a foreign platform if Docker executes the wrong architecture", async () => {
    const executor = { exec: vi.fn(async () => "x86_64\n") } as unknown as CommandExecutor;
    expect(await probeDockerExecutionPlatforms(executor, "x64")).toEqual(["linux/amd64"]);
  });
  it("detects Docker's architecture separately from a connected Mac", async () => {
    const executor = {
      exec: vi.fn(async (command: string) =>
        command.startsWith("uname")
          ? "Darwin\narm64\ngit=yes\nnode=yes\ndocker=linux\ndockerArch=x86_64\nversion=15.5\n"
          : "aarch64\n",
      ),
    } as unknown as CommandExecutor;
    expect(await probeActionCapabilities(executor)).toMatchObject({
      os: "macos",
      architecture: "arm64",
      dockerArchitecture: "x64",
      dockerPlatforms: ["linux/amd64", "linux/arm64"],
    });
  });
});
