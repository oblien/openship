import IORedis from "ioredis";
import { env } from "../config/env";

export async function isRedisReachable(timeoutMs = 2000): Promise<boolean> {
  const probe = new IORedis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableReadyCheck: false,
    connectTimeout: timeoutMs,
  });
  try {
    await Promise.race([
      probe.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutMs),
      ),
    ]);
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    try {
      probe.disconnect();
    } catch {
      /* best-effort */
    }
  }
}
