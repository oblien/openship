import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildImage,
  managedImagesAreFromSource,
  setManagedImagesFromSource,
  swapManagedImage,
} from "./managed-image";
import type { CommandExecutor } from "../types";

afterEach(() => {
  setManagedImagesFromSource("edge", false);
  setManagedImagesFromSource("mail", false);
});

describe("setManagedImagesFromSource / managedImagesAreFromSource", () => {
  it("defaults to false and round-trips the flag per component", () => {
    expect(managedImagesAreFromSource("edge")).toBe(false);
    expect(managedImagesAreFromSource("mail")).toBe(false);

    // Per component: flipping one MUST NOT flip the other, or a from-source mail box
    // would divert a pullable published edge into the from-source backstop.
    setManagedImagesFromSource("edge", true);
    expect(managedImagesAreFromSource("edge")).toBe(true);
    expect(managedImagesAreFromSource("mail")).toBe(false);

    setManagedImagesFromSource("mail", true);
    setManagedImagesFromSource("edge", false);
    expect(managedImagesAreFromSource("edge")).toBe(false);
    expect(managedImagesAreFromSource("mail")).toBe(true);
  });
});

describe("buildImage", () => {
  function exec(code = 0) {
    const commands: string[] = [];
    const executor = {
      streamExec: vi.fn(async (cmd: string) => {
        commands.push(cmd);
        return { code, output: "" };
      }),
    } as unknown as CommandExecutor;
    return { executor, commands };
  }

  it("builds with a plain, unadorned docker build (no forced BuildKit, no platform)", async () => {
    const { executor, commands } = exec();
    await buildImage(
      executor,
      "img:tag",
      { dockerfile: "apps/edge/Dockerfile", context: "/repo" },
      () => {},
      "edge",
    );
    expect(commands).toHaveLength(1);
    // Plain `docker build`: forcing DOCKER_BUILDKIT hard-fails a docker CLI with no
    // buildx plugin; the unadorned command falls back to the legacy builder instead.
    expect(commands[0].startsWith("docker build ")).toBe(true);
    expect(commands[0]).not.toContain("DOCKER_BUILDKIT");
    // Build runs on the box that will RUN the image (same-arch), so never cross-arch.
    expect(commands[0]).not.toContain("--platform");
    expect(commands[0]).toContain("-t 'img:tag'");
    // Dockerfile path is context-joined, context is the final positional arg.
    expect(commands[0]).toContain("-f '/repo/apps/edge/Dockerfile'");
    expect(commands[0].endsWith("'/repo'")).toBe(true);
  });

  it("throws a build-specific error on a non-zero exit", async () => {
    const { executor } = exec(1);
    await expect(
      buildImage(executor, "img:tag", { dockerfile: "D", context: "/repo" }, () => {}, "edge"),
    ).rejects.toThrow(/Could not build the edge image/);
  });
});

describe("swapManagedImage — from-source backstop", () => {
  /** An executor whose image-inspect reports the target absent, and records commands. */
  function absentTarget() {
    const commands: string[] = [];
    const executor = {
      exec: vi.fn(async (cmd: string) => {
        commands.push(cmd);
        return ""; // imageExistsLocally → absent
      }),
      streamExec: vi.fn(async (cmd: string) => {
        commands.push(cmd);
        return { code: 0, output: "" };
      }),
    } as unknown as CommandExecutor;
    return { executor, commands };
  }

  it("does NOT pull an absent from-source tag — stays on the old image and reports why", async () => {
    setManagedImagesFromSource("edge", true);
    const { executor, commands } = absentTarget();
    const start = vi.fn(async () => true);
    const messages: string[] = [];

    const res = await swapManagedImage(executor, {
      kind: "edge",
      from: "img:old",
      to: "img:new-dev.abc",
      label: "edge",
      onLog: (l) => messages.push(l.message),
      start,
    });

    expect(res).toEqual({ swapped: false, down: false });
    expect(commands.some((c) => c.startsWith("docker pull"))).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(messages.join("\n")).toMatch(/from-source edge image .* isn't on this server/);
  });

  it("pulls an absent tag as before when NOT from source (prod)", async () => {
    const { executor, commands } = absentTarget();
    const start = vi.fn(async () => true);

    const res = await swapManagedImage(executor, {
      kind: "edge",
      from: "img:old",
      to: "img:new",
      label: "edge",
      onLog: () => {},
      start,
    });

    expect(commands.some((c) => c.startsWith("docker pull"))).toBe(true);
    expect(res.swapped).toBe(true);
  });

  it("uses THIS component's flag — a from-source mail flag doesn't gate an edge swap", async () => {
    // Mail is from source, edge is not (the mixed dev/prod box). An edge swap must
    // still pull, proving the backstop keys off the swap's own kind, not any flag.
    setManagedImagesFromSource("mail", true);
    const { executor, commands } = absentTarget();

    const res = await swapManagedImage(executor, {
      kind: "edge",
      from: "img:old",
      to: "img:new",
      label: "edge",
      onLog: () => {},
      start: vi.fn(async () => true),
    });

    expect(commands.some((c) => c.startsWith("docker pull"))).toBe(true);
    expect(res.swapped).toBe(true);
  });
});
