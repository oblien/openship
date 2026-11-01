import { vi } from "vitest";

import type { DockerRuntime } from "../../src/runtime/docker";

/** These tests exercise context/stream semantics; the real worker lifecycle is
 * covered by cloud-build-limits and the Docker Cloud capacity E2E journey. */
export function stubProtectedBuildWorker(runtime: DockerRuntime, probe = true): void {
  const host = runtime as unknown as Record<string, any>;
  const executor = host.connectionOptions?.executor;
  if (!executor) return;
  const exec = executor.exec.bind(executor);
  executor.exec = vi.fn((command: string, options: unknown) =>
    command.startsWith("docker info --format")
      ? Promise.resolve(JSON.stringify({ OSType: "linux", SecurityOptions: ["name=seccomp"] }))
      : exec(command, options),
  );
  host.buildCacheHostExecutor = vi.fn(async () => executor);
  host.startProtectedBuildWorker = vi.fn(async () => {});
  host.cleanupProtectedBuildWorker = vi.fn(async () => {});
  if (probe) host.remoteBuildKitAvailable = vi.fn(async () => true);
}
