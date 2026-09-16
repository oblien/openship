import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";

export async function capabilities(c: Context) {
  return c.json(
    await operationData(c, getPlatformKernel().servers.clusterCapabilities(operationContext(c))),
  );
}
export async function list(c: Context) {
  return c.json(
    await operationData(c, getPlatformKernel().servers.listClusters(operationContext(c))),
  );
}
export async function get(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.getCluster(operationContext(c), {
        clusterId: c.req.param("id")!,
      }),
    ),
  );
}
export async function create(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.createCluster(operationContext(c), await c.req.json()),
    ),
    201,
  );
}
export async function update(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.updateCluster(operationContext(c), {
        ...(await c.req.json()),
        clusterId: c.req.param("id")!,
      }),
    ),
  );
}
export async function verify(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.verifyCluster(operationContext(c), {
        ...(await c.req.json()),
        clusterId: c.req.param("id")!,
      }),
    ),
    202,
  );
}
export async function remove(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.removeCluster(operationContext(c), {
        ...(await c.req.json()),
        clusterId: c.req.param("id")!,
      }),
    ),
  );
}
export async function inspect(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.inspectNetwork(operationContext(c), c.req.param("id")!),
    ),
  );
}
