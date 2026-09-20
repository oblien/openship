/** HTTP adapters over shared user preferences. */
import type { Context } from "hono";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
export async function get(c: Context) { return c.json(await operationData(c, getPlatformKernel().settings.get(operationContext(c)))); }
export async function upsert(c: Context) { return c.json(await operationData(c, getPlatformKernel().settings.update(operationContext(c), await c.req.json()))); }
export async function updateForwardGitToServer(c: Context) { return c.json(await operationData(c, getPlatformKernel().settings.setGitForwarding(operationContext(c), await c.req.json()))); }
export async function updateRouteStrategy(c: Context) { return c.json(await operationData(c, getPlatformKernel().settings.setRouteStrategy(operationContext(c), await c.req.json()))); }
export async function updateBuildMode(c: Context) { return c.json(await operationData(c, getPlatformKernel().settings.setBuildMode(operationContext(c), await c.req.json()))); }
export async function updateDeployDefaults(c: Context) { return c.json(await operationData(c, getPlatformKernel().settings.setDeployDefaults(operationContext(c), await c.req.json()))); }
export async function updateCloneCredentials(c: Context) { return c.json(await operationData(c, getPlatformKernel().settings.setCloneCredentials(operationContext(c), await c.req.json()))); }
export async function updateCloneStrategyPreference(c: Context) { return c.json(await operationData(c, getPlatformKernel().settings.setCloneStrategy(operationContext(c), await c.req.json()))); }
export async function updateTransferPrefs(c: Context) { return c.json(await operationData(c, getPlatformKernel().settings.setTransferPreferences(operationContext(c), await c.req.json()))); }
