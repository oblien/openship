/** HTTP envelopes over the shared DNS credential operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { operationContext, operationData } from "../../lib/operation-context";

const operations = () => getPlatformKernel().dns;
export async function listProviders(c: Context) {
  return c.json({ data: await operationData(c, operations().listProviders(operationContext(c))) });
}
export async function listCredentials(c: Context) {
  return c.json({
    data: await operationData(c, operations().listCredentials(operationContext(c))),
  });
}
export async function getCredential(c: Context) {
  return c.json({
    data: await operationData(c, operations().getCredential(operationContext(c), param(c, "id"))),
  });
}
export async function addCredential(c: Context) {
  return c.json(
    {
      data: await operationData(
        c,
        operations().addCredential(operationContext(c), await c.req.json()),
      ),
    },
    201,
  );
}
export async function removeCredential(c: Context) {
  return c.json(
    await operationData(c, operations().removeCredential(operationContext(c), param(c, "id"))),
  );
}
export async function verifyZone(c: Context) {
  return c.json(
    await operationData(c, operations().verifyZone(operationContext(c), await c.req.json())),
  );
}

export async function listIngressConnections(c: Context) {
  return c.json(
    await operationData(
      c,
      operations().listIngressConnections(operationContext(c), {
        serverId: c.req.query("serverId"),
      }),
    ),
  );
}
export async function discoverIngress(c: Context) {
  return c.json(
    await operationData(c, operations().discoverIngress(operationContext(c), await c.req.json())),
  );
}
export async function connectIngress(c: Context) {
  return c.json(
    await operationData(c, operations().connectIngress(operationContext(c), await c.req.json())),
    202,
  );
}
export async function retryIngress(c: Context) {
  return c.json(
    await operationData(c, operations().retryIngress(operationContext(c), param(c, "id"))),
    202,
  );
}
export async function removeIngress(c: Context) {
  return c.json(
    await operationData(c, operations().removeIngress(operationContext(c), param(c, "id"))),
    202,
  );
}
export async function getDomainIngress(c: Context) {
  return c.json(
    await operationData(
      c,
      operations().getDomainIngress(operationContext(c), { domainId: param(c, "id") }),
    ),
  );
}
export async function setDomainIngress(c: Context) {
  const body = await c.req.json();
  return c.json(
    await operationData(
      c,
      operations().setDomainIngress(operationContext(c), { ...body, domainId: param(c, "id") }),
    ),
    202,
  );
}

export async function updateIngress(c: Context) {
  const body = await c.req.json();
  return c.json(
    await operationData(
      c,
      operations().updateIngress(operationContext(c), { ...body, id: param(c, "id") }),
    ),
  );
}
