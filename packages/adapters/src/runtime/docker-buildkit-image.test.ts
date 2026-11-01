import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../types";
import {
  prepareProtectedBuildKitImage,
  requireProtectedBuildHost,
  resolveBuildKitImage,
  setDefaultBuildKitImage,
} from "./docker-buildkit-image";

const image = "registry.example/openship-buildkit:next";
const guarded = [
  {
    Config: {
      Labels: { "org.openship.build-metadata-policy": "1" },
      Entrypoint: ["/usr/local/bin/openship-buildkitd"],
    },
  },
];
function fixture(
  info: unknown = { OSType: "linux", SecurityOptions: ["name=seccomp,profile=builtin"] },
) {
  const exec = vi.fn(async (command: string) =>
    JSON.stringify(command.startsWith("docker info") ? info : guarded),
  );
  return { exec, executor: { exec } as unknown as CommandExecutor };
}
afterEach(() => {
  vi.unstubAllEnvs();
  setDefaultBuildKitImage("ghcr.io/oblien/openship-buildkit:latest");
});

describe("remote BuildKit protection prerequisites", () => {
  it("accepts Linux server Docker regardless of the desktop/control-plane OS", async () => {
    await expect(requireProtectedBuildHost(fixture().executor)).resolves.toBeUndefined();
  });
  it.each([
    { OSType: "windows", SecurityOptions: [] },
    { OSType: "linux", SecurityOptions: ["name=rootless"] },
    { OSType: "linux" },
    { OSType: "linux", SecurityOptions: [null] },
    null,
  ])("fails closed on unsupported or incomplete server information: %s", async (info) => {
    await expect(requireProtectedBuildHost(fixture(info).executor)).rejects.toMatchObject({
      code: "BUILD_METADATA_PROTECTION_UNAVAILABLE",
    });
  });
  it("keeps an unavailable daemon distinct from a supported one", async () => {
    const h = fixture();
    const cause = new Error("server disconnected");
    h.exec.mockRejectedValue(cause);
    await expect(requireProtectedBuildHost(h.executor)).rejects.toMatchObject({ cause });
  });
  it("shares the existing image registry/version precedence and refreshes source pins", () => {
    let version = "v1";
    setDefaultBuildKitImage(() => `${image}-${version}`);
    expect(resolveBuildKitImage()).toBe(`${image}-v1`);
    version = "v2";
    expect(resolveBuildKitImage()).toBe(`${image}-v2`);
    vi.stubEnv("OPENSHIP_BUILDKIT_IMAGE", "mirror.example/buildkit@sha256:verified");
    expect(resolveBuildKitImage()).toBe("mirror.example/buildkit@sha256:verified");
  });
  it("delivers the exact selected pin before acquiring and verifying its entrypoint", async () => {
    const h = fixture();
    const delivery = vi.fn(async () => {});
    const acquire = vi.fn(async () => {});
    setDefaultBuildKitImage(image, delivery);
    const log = vi.fn();
    await expect(prepareProtectedBuildKitImage(h.executor, acquire, log)).resolves.toBe(image);
    expect(delivery).toHaveBeenCalledWith(h.executor, image, log);
    expect(delivery.mock.invocationCallOrder[0]).toBeLessThan(acquire.mock.invocationCallOrder[0]!);
    expect(acquire).toHaveBeenCalledExactlyOnceWith(image);
    expect(h.exec).toHaveBeenCalledExactlyOnceWith(`docker image inspect '${image}'`);
  });
  it.each(
    [
      [{ Config: { Entrypoint: ["/usr/bin/buildkitd"] } }],
      [
        {
          Config: {
            Labels: { "org.openship.build-metadata-policy": "0" },
            Entrypoint: guarded[0]!.Config.Entrypoint,
          },
        },
      ],
      [{ Config: { Labels: guarded[0]!.Config.Labels, Entrypoint: ["/usr/bin/buildkitd"] } }],
      [],
    ].map((config) => ({ config })),
  )("never accepts an unguarded or obsolete worker image: $config", async ({ config }) => {
    const h = fixture();
    h.exec.mockResolvedValue(JSON.stringify(config));
    setDefaultBuildKitImage(image);
    await expect(
      prepareProtectedBuildKitImage(
        h.executor,
        vi.fn(async () => {}),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "BUILD_METADATA_PROTECTION_UNAVAILABLE" });
  });
  it("does not replace a missing release artifact with unguarded upstream BuildKit", async () => {
    const h = fixture();
    setDefaultBuildKitImage(image);
    const acquire = vi.fn(async () => {
      throw new Error("manifest not found");
    });
    await expect(prepareProtectedBuildKitImage(h.executor, acquire, vi.fn())).rejects.toMatchObject(
      { code: "BUILD_METADATA_PROTECTION_UNAVAILABLE" },
    );
    expect(acquire).toHaveBeenCalledExactlyOnceWith(image);
    expect(h.exec).not.toHaveBeenCalled();
  });
});
