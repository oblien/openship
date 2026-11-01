import {
  AppError,
  ACTION_CONTAINER_PLATFORMS,
  shellQuote as q,
  type ActionArchitecture,
  type ActionContainerPlatform,
} from "@repo/core";
import type { CommandExecutor } from "../types";

// Multi-architecture upstream installer, pinned so a registry tag cannot change host setup.
export const DOCKER_BINFMT_IMAGE =
  "tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0";
// BusyBox 1.37.0, pinned by platform so classic Docker can cache both architectures.
// Execute a real foreign binary instead of trusting buildx or binfmt registrations.
const probes: Record<ActionContainerPlatform, { image: string; uname: string }> = {
  "linux/amd64": {
    image: "busybox@sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4",
    uname: "x86_64",
  },
  "linux/arm64": {
    image: "busybox@sha256:d82c2ab94640ded77cf76514ce6a84870761105058a4a9e51b05a8a79be97a6c",
    uname: "aarch64",
  },
};

export function dockerArchitecture(value: string | undefined): ActionArchitecture | undefined {
  if (value === "amd64" || value === "x86_64" || value === "x64") return "x64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return undefined;
}

const foreignPlatform = (native: ActionArchitecture): ActionContainerPlatform =>
  native === "x64" ? "linux/arm64" : "linux/amd64";

/** Routine inspection is unprivileged, uses cached images and never installs emulators. */
export async function probeDockerExecutionPlatforms(
  executor: CommandExecutor,
  native: ActionArchitecture,
): Promise<ActionContainerPlatform[]> {
  const platforms = [ACTION_CONTAINER_PLATFORMS[native]];
  const platform = foreignPlatform(native);
  const probe = probes[platform];
  // A missing image or an exec-format error means unverified support, not a
  // broken native runner. No host mounts, Docker socket or network are exposed.
  const output = await executor.exec(
    `if docker image inspect ${q(probe.image)} >/dev/null 2>&1; then docker run --rm --pull=never --platform ${q(platform)} --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 32 --memory 128m ${q(probe.image)} uname -m 2>/dev/null || true; fi`,
    { timeout: 30_000 },
  );
  if (output.trim() === probe.uname) platforms.push(platform);
  return platforms;
}

/** Explicit administrator setup, also used on disposable Cloud runner VMs. */
export async function ensureDockerEmulation(
  executor: CommandExecutor,
  native: ActionArchitecture,
): Promise<ActionContainerPlatform[]> {
  const platform = foreignPlatform(native);
  const probe = probes[platform];
  await executor.exec(
    `docker image inspect ${q(probe.image)} >/dev/null 2>&1 || docker pull --platform ${q(platform)} ${q(probe.image)}`,
    { timeout: 180_000 },
  );
  const before = await probeDockerExecutionPlatforms(executor, native);
  if (before.includes(platform)) return before;
  const nativeProbe = probes[ACTION_CONTAINER_PLATFORMS[native]];
  await executor.exec(
    `docker image inspect ${q(nativeProbe.image)} >/dev/null 2>&1 || docker pull ${q(nativeProbe.image)}`,
    { timeout: 180_000 },
  );
  await executor.exec(
    `docker image inspect ${q(DOCKER_BINFMT_IMAGE)} >/dev/null 2>&1 || docker pull ${q(DOCKER_BINFMT_IMAGE)}`,
    { timeout: 180_000 },
  );
  // Only add the missing emulator. Never reset Docker or uninstall registrations.
  let installError: unknown;
  let installOutput = "";
  try {
    // Keep binfmt_misc mounted in the Docker host's mount namespace. Otherwise
    // a minimal host loses registrations when the short-lived installer exits.
    // This is part of the explicit admin setup, never a routine capability read.
    await executor.exec(
      `docker run --rm --pull=never --privileged --pid=host --network none --memory 128m ${q(nativeProbe.image)} nsenter -t 1 -m -r -- sh -c ${q("test -f /proc/sys/fs/binfmt_misc/status || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc")}`,
      { timeout: 30_000 },
    );
    installOutput = await executor.exec(
      `docker run --rm --pull=never --privileged --network none --memory 256m ${q(DOCKER_BINFMT_IMAGE)} --install ${q(platform.split("/")[1]!)}`,
      { timeout: 90_000 },
    );
  } catch (error) {
    // diagnostics-ignore: Concurrent setup may already have succeeded. The execution probe below verifies it; failure propagates with this original cause.
    installError = error;
  }
  const after = await probeDockerExecutionPlatforms(executor, native);
  if (!after.includes(platform)) {
    const error = new AppError(
      "Docker could not enable CPU emulation. This server must allow privileged binfmt setup. Native jobs remain available.",
      409,
      "DOCKER_EMULATION_UNAVAILABLE",
    );
    error.cause =
      installError ??
      new Error(
        installOutput.trim().slice(0, 4096) ||
          "The requested Docker platform did not execute after setup",
      );
    throw error;
  }
  return after;
}
