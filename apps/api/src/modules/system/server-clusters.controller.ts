import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { operationEvents } from "../../lib/operation-stream";

export function preparationEvents(c: Context) {
  return operationEvents(c, (signal) =>
    getPlatformKernel().servers.openManagedNetworkPreparationEvents(
      operationContext(c),
      c.req.param("preparationId")!,
      { signal },
    ),
  );
}
export function managedOperationEvents(c: Context) {
  return operationEvents(c, (signal) =>
    getPlatformKernel().servers.openManagedNetworkOperationEvents(
      operationContext(c),
      c.req.param("operationId")!,
      { signal },
    ),
  );
}
export function clusterEvents(c: Context) {
  return operationEvents(c, (signal) =>
    getPlatformKernel().servers.openClusterEvents(operationContext(c), { signal }),
  );
}

export async function prepareManaged(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.prepareManagedNetwork(operationContext(c), await c.req.json()),
    ),
    202,
  );
}

export async function reviseManagedAccess(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.reviseManagedNetworkAccess(operationContext(c), {
        ...(await c.req.json()),
        preparationId: c.req.param("preparationId")!,
      }),
    ),
    202,
  );
}
export async function managedPreparation(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.getManagedNetworkPreparation(operationContext(c), {
        preparationId: c.req.param("preparationId")!,
      }),
    ),
  );
}
export async function managedPreparations(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.listManagedNetworkPreparations(operationContext(c)),
    ),
  );
}

export async function discardPreparation(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.discardManagedNetworkPreparation(operationContext(c), {
        ...(await c.req.json()),
        preparationId: c.req.param("preparationId")!,
      }),
    ),
  );
}

export async function discardPlan(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.discardManagedNetworkPlan(operationContext(c), {
        ...(await c.req.json()),
        operationId: c.req.param("operationId")!,
      }),
    ),
  );
}

export async function removePreparationMember(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.removeManagedNetworkPreparationMember(operationContext(c), {
        ...(await c.req.json()),
        preparationId: c.req.param("preparationId")!,
        serverId: c.req.param("serverId")!,
      }),
    ),
    202,
  );
}

export async function removeOperationMember(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.removeManagedNetworkOperationMember(operationContext(c), {
        ...(await c.req.json()),
        operationId: c.req.param("operationId")!,
        serverId: c.req.param("serverId")!,
      }),
    ),
    202,
  );
}

export async function planManaged(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.planManagedNetwork(operationContext(c), await c.req.json()),
    ),
    201,
  );
}
export async function managedOperation(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.getManagedNetworkOperation(operationContext(c), {
        operationId: c.req.param("operationId")!,
      }),
    ),
  );
}
export async function applyManaged(c: Context) {
  return c.json(
    await operationData(
      c,
      getPlatformKernel().servers.applyManagedNetwork(operationContext(c), {
        ...(await c.req.json()),
        operationId: c.req.param("operationId")!,
      }),
    ),
    202,
  );
}

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
