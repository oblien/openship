import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { operationEvents } from "../../lib/operation-stream";

export const clusterStorage = {
  async backup(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.configureClusterStorageBackup(operationContext(c), {
          ...(await c.req.json()),
          clusterId: c.req.param("id")!,
        }),
      ),
      202,
    );
  },
  async get(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.getClusterStorage(operationContext(c), {
          clusterId: c.req.param("id")!,
          observe: c.req.query("observe") === "true",
        }),
      ),
    );
  },
  async setup(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.setupClusterStorage(operationContext(c), {
          ...(await c.req.json()),
          clusterId: c.req.param("id")!,
        }),
      ),
      202,
    );
  },
  async retry(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.retryClusterStorage(operationContext(c), {
          ...(await c.req.json()),
          clusterId: c.req.param("id")!,
        }),
      ),
      202,
    );
  },
  async remove(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.removeClusterStorage(operationContext(c), {
          ...(await c.req.json()),
          clusterId: c.req.param("id")!,
        }),
      ),
      202,
    );
  },
  events(c: Context) {
    return operationEvents(c, (signal) =>
      getPlatformKernel().servers.openClusterStorageEvents(
        operationContext(c),
        c.req.param("id")!,
        { signal },
      ),
    );
  },
};
export const clusterRuntime = {
  async get(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.getClusterRuntime(operationContext(c), {
          clusterId: c.req.param("id")!,
        }),
      ),
    );
  },
  async setup(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.setupClusterRuntime(operationContext(c), {
          ...(await c.req.json()),
          clusterId: c.req.param("id")!,
        }),
      ),
      202,
    );
  },
  async retry(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.retryClusterRuntime(operationContext(c), {
          ...(await c.req.json()),
          clusterId: c.req.param("id")!,
        }),
      ),
      202,
    );
  },
  async remove(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.removeClusterRuntime(operationContext(c), {
          ...(await c.req.json()),
          clusterId: c.req.param("id")!,
        }),
      ),
      202,
    );
  },
  events(c: Context) {
    return operationEvents(c, (signal) =>
      getPlatformKernel().servers.openClusterRuntimeEvents(
        operationContext(c),
        c.req.param("id")!,
        { signal },
      ),
    );
  },
};

export const networks = {
  async capabilities(c: Context) {
    return c.json(
      await operationData(c, getPlatformKernel().servers.networkCapabilities(operationContext(c))),
    );
  },
  async list(c: Context) {
    return c.json(
      await operationData(c, getPlatformKernel().servers.listNetworks(operationContext(c))),
    );
  },
  async get(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.getNetwork(operationContext(c), {
          networkId: c.req.param("id")!,
        }),
      ),
    );
  },
  async create(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.createNetwork(operationContext(c), await c.req.json()),
      ),
      201,
    );
  },
  async update(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.updateNetwork(operationContext(c), {
          ...(await c.req.json()),
          networkId: c.req.param("id")!,
        }),
      ),
    );
  },
  async verify(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.verifyNetwork(operationContext(c), {
          ...(await c.req.json()),
          networkId: c.req.param("id")!,
        }),
      ),
      202,
    );
  },
  async remove(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.removeNetwork(operationContext(c), {
          ...(await c.req.json()),
          networkId: c.req.param("id")!,
        }),
      ),
    );
  },
};
export const computeClusters = {
  async list(c: Context) {
    return c.json(
      await operationData(c, getPlatformKernel().servers.listComputeClusters(operationContext(c))),
    );
  },
  async get(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.getComputeCluster(operationContext(c), {
          clusterId: c.req.param("id")!,
        }),
      ),
    );
  },
  async create(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.createComputeCluster(operationContext(c), await c.req.json()),
      ),
      201,
    );
  },
  async update(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.updateComputeCluster(operationContext(c), {
          ...(await c.req.json()),
          clusterId: c.req.param("id")!,
        }),
      ),
    );
  },
  async remove(c: Context) {
    return c.json(
      await operationData(
        c,
        getPlatformKernel().servers.removeComputeCluster(operationContext(c), {
          ...(await c.req.json()),
          clusterId: c.req.param("id")!,
        }),
      ),
    );
  },
};
