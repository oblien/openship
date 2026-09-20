import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";

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
