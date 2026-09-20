/** HTTP envelopes for the shared server GitHub operations. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
export async function getStatus(c: Context) {
  const data = await operationData(c, getPlatformKernel().servers.githubStatus(operationContext(c), c.req.param("id")!));
  return c.json(data);
}
export async function startConnect(c: Context) {
  const data = await operationData(c, getPlatformKernel().servers.connectGitHub(operationContext(c), c.req.param("id")!));
  return c.json(data);
}
export async function pollConnect(c: Context) {
  const data = await operationData(c, getPlatformKernel().servers.pollGitHubConnection(operationContext(c), c.req.param("id")!));
  return c.json({ data });
}
export async function putToken(c: Context) {
  const data = await operationData(c, getPlatformKernel().servers.setGitHubToken(operationContext(c), c.req.param("id")!, await c.req.json()));
  return c.json(data);
}
export async function generateSshKey(c: Context) {
  const data = await operationData(c, getPlatformKernel().servers.generateGitHubKey(operationContext(c), c.req.param("id")!));
  return c.json(data);
}
export async function useDeployKeyMode(c: Context) {
  const data = await operationData(c, getPlatformKernel().servers.useGitHubDeployKeys(operationContext(c), c.req.param("id")!));
  return c.json(data);
}
export async function disconnect(c: Context) {
  const data = await operationData(c, getPlatformKernel().servers.disconnectGitHub(operationContext(c), c.req.param("id")!));
  return c.json(data);
}
