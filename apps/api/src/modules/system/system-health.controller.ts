/** Internal-token HTTP diagnostic adapter; authenticated SDK calls use system.health. */
import type { Context } from "hono";
import { inspectSystemHealth } from "@repo/platform/engine/modules/system/system-health";

export async function systemHealth(c: Context) {
  return c.json(await inspectSystemHealth());
}
