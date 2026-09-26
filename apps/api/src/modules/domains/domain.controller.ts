/** HTTP paths, status codes, and envelopes over the shared domain operations. */
import type { Context } from "hono";
import type { TAddDomainBody } from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { param } from "../../lib/controller-helpers";
import { permission } from "../../lib/permission";
import { getRequestContext } from "../../lib/request-context";
import { operationContext, operationData, applyOperationContext } from "../../lib/operation-context";
import { maybeProxyCloudProject } from "../../lib/cloud/project-router";
import { streamSSE } from "../../lib/sse";

const operations = () => getPlatformKernel().domains;
const force = (c: Context) => ({ force: ["true", "1"].includes(c.req.query("force") ?? "") });
const target = (c: Context) => ({ serverId: c.req.query("serverId")?.trim() || undefined });

export async function list(c: Context) {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: projectId, action: "read" });
  const proxied = await maybeProxyCloudProject(c, projectId, operationContext(c).organizationId);
  if (proxied) return proxied;
  return c.json({ data: await operationData(c, operations().list(operationContext(c), projectId)) });
}

export async function add(c: Context) {
  const body = await c.req.json<TAddDomainBody>();
  const { projectId, ...input } = body;
  await permission.assert(getRequestContext(c), { resourceType: "project", resourceId: projectId, action: "write" });
  const proxied = await maybeProxyCloudProject(c, projectId, operationContext(c).organizationId, { body: JSON.stringify(body) });
  if (proxied) return proxied;
  const { domain, ...details } = await operationData(c, operations().create(operationContext(c), projectId, input));
  return c.json({ data: domain, ...details }, 201);
}

export async function get(c: Context) {
  return c.json({ data: await operationData(c, operations().get(operationContext(c), param(c, "id"))) });
}
export async function remove(c: Context) {
  return c.json(await operationData(c, operations().remove(operationContext(c), param(c, "id"))));
}
export async function verify(c: Context) {
  const data = await operationData(c, operations().verify(operationContext(c), param(c, "id"), force(c)));
  // Preserve the dashboard's verification-failure status and public result body.
  return c.json(data, data.verified ? 200 : 422);
}
export async function verifyStream(c: Context) {
  const context = operationContext(c);
  const id = param(c, "id");
  const input = force(c);
  applyOperationContext(c, context);
  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    try {
      for await (const event of operations().verifyStream(context, id, input, { signal: abort.signal })) {
        // Flush the terminal event before returning and closing Hono's stream.
        await stream.writeSSE(event);
      }
    } finally {
      abort.abort();
    }
  });
}
export async function records(c: Context) {
  return c.json({ data: await operationData(c, operations().records(operationContext(c), param(c, "id"), target(c))) });
}
export async function dnsPlan(c: Context) {
  return c.json({ data: await operationData(c, operations().dnsPlan(operationContext(c), param(c, "id"), target(c))) });
}
export async function dnsApply(c: Context) {
  return c.json({ data: await operationData(c, operations().dnsApply(operationContext(c), param(c, "id"), target(c))) });
}
export async function dnsChallenge(c: Context) {
  return c.json({ data: await operationData(c, operations().dnsChallenge(operationContext(c), param(c, "id"))) });
}
export async function startDnsChallenge(c: Context) {
  return c.json({ data: await operationData(c, operations().startDnsChallenge(operationContext(c), param(c, "id"), await c.req.json())) }, 202);
}
export async function checkDnsChallenge(c: Context) {
  return c.json({ data: await operationData(c, operations().checkDnsChallenge(operationContext(c), param(c, "id"), await c.req.json())) }, 202);
}
export async function cancelDnsChallenge(c: Context) {
  return c.json({ data: await operationData(c, operations().cancelDnsChallenge(operationContext(c), param(c, "id"), await c.req.json())) });
}
export async function setPrimary(c: Context) {
  return c.json({ data: await operationData(c, operations().setPrimary(operationContext(c), param(c, "id"))) });
}
export async function preview(c: Context) {
  return c.json({ data: await operationData(c, operations().preview(operationContext(c), await c.req.json())) });
}
export async function renewSsl(c: Context) {
  return c.json({ data: await operationData(c, operations().renewSsl(operationContext(c), param(c, "id"))) });
}
export async function verifySsl(c: Context) {
  return c.json({ data: await operationData(c, operations().verifySsl(operationContext(c), param(c, "id"))) });
}
export async function uploadCert(c: Context) {
  return c.json({ data: await operationData(c, operations().uploadCert(operationContext(c), param(c, "id"), await c.req.json())) });
}
export async function renewAllSsl(c: Context) {
  return c.json({ data: await operationData(c, operations().renewAllSsl(operationContext(c))) });
}
export async function verifyPending(c: Context) {
  return c.json({ data: await operationData(c, operations().verifyPending(operationContext(c), await c.req.json().catch(() => ({})))) });
}
