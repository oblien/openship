import { beforeEach, expect, it, vi } from "vitest";
import type { CommandExecutor } from "../types";
import { privilegedExecutor } from "../system/privilege";
import { protectedBuildCacheHostExecutor } from "./docker-build-cache-executor";
import { DOCKER_BUILD_STORAGE_COMMAND, dockerBuildStorageCommand } from "./docker-build-cache";
vi.mock("../system/privilege", () => ({ privilegedExecutor: vi.fn() }));
const gate = vi.mocked(privilegedExecutor);
beforeEach(() => vi.clearAllMocks());
function fixture(elevation: "root" | "sudo" | "none" = "sudo") {
  const login = { exec: vi.fn(async () => "/docker root") } as unknown as CommandExecutor;
  const host = {
    exec: vi.fn(async () => "measured"),
    writeFile: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
  gate.mockResolvedValue({
    supported: true,
    value: { executor: host, elevation, profile: {} },
  } as never);
  return { login, host };
}
it("resolves the user's Docker storage before running quoted filesystem reads under sudo", async () => {
  const h = fixture();
  const cache = await protectedBuildCacheHostExecutor(h.login);
  await expect(cache.exec(DOCKER_BUILD_STORAGE_COMMAND, { timeout: 1234 })).resolves.toBe(
    "measured",
  );
  expect(h.login.exec).toHaveBeenCalledExactlyOnceWith(
    "docker info --format '{{.DockerRootDir}}'",
    { timeout: 1234 },
  );
  expect(h.host.exec).toHaveBeenCalledExactlyOnceWith(dockerBuildStorageCommand("/docker root"), {
    timeout: 1234,
  });
  expect(vi.mocked(h.host.exec).mock.calls[0]![0]).not.toContain("docker info");
  expect(gate).toHaveBeenCalledWith(h.login, "Managing remote Docker build cache", {
    onRefusedHost: "proceed",
  });
});
it("elevates only the dedicated cache view and preserves the original executor", async () => {
  const h = fixture();
  const cache = await protectedBuildCacheHostExecutor(h.login);
  await cache.exec("du -sk -- '/cache/project'");
  await cache.writeFile("/cache/stamp", "saved");
  expect(h.host.exec).toHaveBeenCalledWith("du -sk -- '/cache/project'", undefined);
  expect(h.host.writeFile).toHaveBeenCalledWith("/cache/stamp", "saved");
  expect(h.login.exec).not.toHaveBeenCalled();
  expect(cache).not.toBe(h.login);
});
it("retains an already-root executor without changing Docker context", async () => {
  const h = fixture("root");
  await expect(protectedBuildCacheHostExecutor(h.login)).resolves.toBe(h.login);
});
it.each(["relative", "", "/valid\nwrong"])(
  "refuses an invalid daemon path %j before privileged filesystem access",
  async (path) => {
    const h = fixture();
    vi.mocked(h.login.exec).mockResolvedValue(path);
    const cache = await protectedBuildCacheHostExecutor(h.login);
    await expect(cache.exec(DOCKER_BUILD_STORAGE_COMMAND)).rejects.toMatchObject({
      code: "BUILD_STORAGE_UNKNOWN",
    });
    expect(h.host.exec).not.toHaveBeenCalled();
  },
);
it("rejects a login without root/sudo before host cache writes", async () => {
  const h = fixture("none");
  await expect(protectedBuildCacheHostExecutor(h.login)).rejects.toMatchObject({
    code: "BUILD_METADATA_PROTECTION_UNAVAILABLE",
  });
  expect(h.login.exec).not.toHaveBeenCalled();
  expect(h.host.exec).not.toHaveBeenCalled();
});
it("keeps privilege refusal explicit", async () => {
  const h = fixture();
  gate.mockResolvedValue({ supported: false, reason: "Passwordless sudo is unavailable" } as never);
  await expect(protectedBuildCacheHostExecutor(h.login)).rejects.toThrow(
    "Passwordless sudo is unavailable",
  );
  expect(h.host.exec).not.toHaveBeenCalled();
});
