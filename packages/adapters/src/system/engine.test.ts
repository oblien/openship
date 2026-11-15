import { describe, expect, it, vi } from "vitest";

import { detectContainerEngine, parseEngineName } from "./engine";
import type { ExecOnly } from "../types";

/**
 * These pin the ONE thing the naming depends on: the engine word that reaches
 * the operator's log has to come from what the box actually answers, not from
 * what the component is called. Every shape below was captured live — Docker
 * CLI 6.0.2 and Podman 6.0.2 on the same Mac, real-dockerd shapes from the
 * documented plain output — and the `--format` probes that ALSO would have
 * answered this were verified to fail on both CLIs (the structs strip
 * Platform/Components), which is why the plain text is the ground truth.
 */
function box(answers: Array<[string, string | Error]>): ExecOnly {
  return {
    exec: vi.fn(async (cmd: string) => {
      for (const [needle, out] of answers) {
        if (!cmd.includes(needle)) continue;
        if (out instanceof Error) throw out;
        return out;
      }
      return "";
    }),
  } as unknown as ExecOnly;
}

const REAL_DOCKERD = [
  "Client: Docker Engine - Community",
  " Version:    29.7.1",
  " Server: Docker Engine - Community",
  "  Engine:",
  "   Version:    29.7.1",
].join("\n");

const PODMAN_SHIM = [
  "Client:        Podman Engine",
  "Version:       5.8.2",
  "",
  "Server:       Podman Engine",
  "Version:      5.8.2",
].join("\n");

const DOCKER_CLI_TO_PODMAN = [
  "Client: Docker Engine - Community",
  " Version:    29.7.1",
  "",
  "Server:       Podman Engine",
  "Version:      5.8.2",
].join("\n");

describe("parseEngineName", () => {
  it("names dockerd from its server section", () => {
    expect(parseEngineName(REAL_DOCKERD)).toBe("docker");
  });

  it("names the podman shim from its client section", () => {
    expect(parseEngineName(PODMAN_SHIM)).toBe("podman");
  });

  // The case the component name hides: a REAL docker CLI pointed at Podman's
  // socket. The daemon's word must beat the CLI's own.
  it("prefers the server section's engine over the client's", () => {
    expect(parseEngineName(DOCKER_CLI_TO_PODMAN)).toBe("podman");
  });

  it("keeps the CLI's name when the daemon never answers", () => {
    expect(parseEngineName("Client: Docker Engine - Community\n Version: 29.7.1")).toBe("docker");
    expect(parseEngineName("Client:        Podman Engine\nVersion:       5.8.2")).toBe("podman");
  });

  it("reads section-less --version one-liners", () => {
    expect(parseEngineName("Docker version 29.7.1, build abc1234")).toBe("docker");
    expect(parseEngineName("podman version 5.8.2")).toBe("podman");
  });

  it("returns null when nothing names an engine", () => {
    expect(parseEngineName("")).toBeNull();
    // Error noise that merely contains the word docker does not name it — the
    // detector's section guard exists because of exactly this shape.
    expect(parseEngineName("sh: 1: docker: not found")).toBeNull();
    expect(parseEngineName("command not found")).toBeNull();
  });

  // A box may legitimately have BOTH CLIs: `podman --version` appended to a
  // docker answer must not rename a daemon that named itself Docker.
  it("ignores trailing podman mentions after a docker server section", () => {
    expect(parseEngineName(`${REAL_DOCKERD}\npodman version 6.0.2`)).toBe("docker");
  });
});

describe("detectContainerEngine", () => {
  it("short-circuits on the shim's own --version output — no second probe", async () => {
    const executor = box([["docker --version", "podman version 5.8.2"]]);
    expect(await detectContainerEngine(executor, "podman version 5.8.2")).toBe("podman");
    expect(executor.exec).not.toHaveBeenCalled();
  });

  it("asks the daemon which engine it serves when the CLI is real docker", async () => {
    const executor = box([
      ["docker --version", "Docker version 29.7.1, build abc1234"],
      ["docker version", DOCKER_CLI_TO_PODMAN],
    ]);
    expect(await detectContainerEngine(executor, "Docker version 29.7.1, build abc1234")).toBe(
      "podman",
    );
  });

  it("keeps docker when a real dockerd answers", async () => {
    const executor = box([
      ["docker --version", "Docker version 29.7.1, build abc1234"],
      ["docker version", REAL_DOCKERD],
    ]);
    expect(await detectContainerEngine(executor, "Docker version 29.7.1, build abc1234")).toBe(
      "docker",
    );
  });

  it("falls back to podman when the docker CLI is absent", async () => {
    const executor = box([
      ["docker version", "sh: 1: docker: not found"],
      ["podman --version", "podman version 6.0.2"],
    ]);
    expect(await detectContainerEngine(executor, null)).toBe("podman");
  });

  it("returns null when no engine exists to name", async () => {
    const executor = box([
      ["docker version", "sh: 1: docker: not found"],
      ["podman --version", new Error("sh: 1: podman: not found")],
    ]);
    expect(await detectContainerEngine(executor, null)).toBeNull();
  });
});
