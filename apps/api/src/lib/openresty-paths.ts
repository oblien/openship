import {
  NginxProvider,
  detectOpenRestyPaths,
  type OpenRestyPaths,
} from "@repo/adapters";
import type { CommandExecutor } from "@repo/adapters";
import { sshManager } from "./ssh-manager";

const openRestyPathCache = new Map<string, OpenRestyPaths>();

export async function getOpenRestyPaths(
  serverId: string,
  executor: CommandExecutor,
  forceRefresh = false,
): Promise<OpenRestyPaths> {
  const cached = !forceRefresh ? openRestyPathCache.get(serverId) : null;
  if (cached) {
    return cached;
  }

  const detected = await detectOpenRestyPaths(executor);
  openRestyPathCache.set(serverId, detected);
  return detected;
}

export function invalidateOpenRestyPaths(serverId?: string): void {
  if (serverId) {
    openRestyPathCache.delete(serverId);
    return;
  }

  openRestyPathCache.clear();
}

export async function withOpenRestyRouting<T>(
  serverId: string,
  fn: (routing: NginxProvider) => Promise<T>,
): Promise<T> {
  return sshManager.withExecutor(serverId, async (executor) => {
    const run = async (forceRefresh = false) => {
      const paths = await getOpenRestyPaths(serverId, executor, forceRefresh);
      const routing = new NginxProvider({ paths, executor });
      return fn(routing);
    };

    try {
      return await run(false);
    } catch (err) {
      if (!openRestyPathCache.has(serverId)) {
        throw err;
      }

      invalidateOpenRestyPaths(serverId);
      return run(true);
    }
  });
}