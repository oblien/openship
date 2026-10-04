import type { Platform } from "./platform";
import type { RuntimeAdapter } from "./runtime/types";

/** Install-time policy. Unlike the host-control toggle, Settings cannot override it. */
export function isRemoteOnlyInstance(): boolean {
  return process.env.OPENSHIP_REMOTE_ONLY === "true" || process.env.OPENSHIP_REMOTE_ONLY === "1";
}

export const REMOTE_ONLY_MESSAGE =
  "This control plane manages remote servers only. Select a connected server; local workloads, host operations, and local routing are disabled.";

async function unavailable(): Promise<never> {
  throw new Error(REMOTE_ONLY_MESSAGE);
}

/** No local runtime is constructed or probed. Unsupported operations must not report success. */
export function createRemoteOnlyPlatform(): Platform {
  const runtime: RuntimeAdapter = {
    name: "remote-only",
    capabilities: new Set(),
    supports: () => false,
    build: unavailable,
    cancelBuild: unavailable,
    getBuildLogs: unavailable,
    deploy: unavailable,
    stop: unavailable,
    start: unavailable,
    restart: unavailable,
    destroy: unavailable,
    getContainerInfo: unavailable,
    getRuntimeLogs: unavailable,
    streamRuntimeLogs: unavailable,
    getUsage: unavailable,
    getContainerIp: unavailable,
    archive: unavailable,
    purge: unavailable,
  };
  return {
    target: "selfhosted",
    localHost: false,
    runtime,
    executor: null,
    system: null,
    routing: { registerRoute: unavailable, removeRoute: unavailable },
    ssl: {
      provisionCert: unavailable,
      renewCert: unavailable,
      installCert: unavailable,
      verifyCert: unavailable,
    },
  };
}
