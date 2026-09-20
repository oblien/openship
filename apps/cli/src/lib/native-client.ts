/** Explicit CLI composition. Project directories never auto-load executable configuration. */
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { extname, resolve } from "node:path";
import type { NativeShipOptions, OwnedShip, ScopedShip } from "@repo/sdk/native";

export interface NativeCliConfig<Assertion = unknown> {
  options: NativeShipOptions<Assertion>;
  scope: { identity: Assertion; organizationId: string } | ((ship: OwnedShip<Assertion>) => Promise<{ identity: Assertion; organizationId: string }>);
}
interface NativeSession { ship: OwnedShip<unknown>; client: ScopedShip; configPath: string }
let requested = false;
let session: NativeSession | undefined;
let initialization: Promise<void> | undefined;
let closing: Promise<void> | undefined;
let closeRequested = false;

export const isNativeMode = () => requested;
export const nativeSession = () => session;

export function initializeNativeClient(configPath: string, userAgent: string): Promise<void> {
  if (closeRequested) return Promise.reject(new Error("The native CLI connection is closing"));
  if (initialization) return initialization;
  requested = true;
  initialization = (async () => {
    const path = await realpath(resolve(configPath));
    if (![".js", ".mjs", ".cjs"].includes(extname(path))) throw new Error("Native configuration must be a JavaScript module (.mjs, .cjs, or .js)");
    const module = await import(pathToFileURL(path).href);
    const config: NativeCliConfig = typeof module.default === "function" ? await module.default() : module.default;
    if (!config?.options || typeof config.options !== "object" || !config.scope)
      throw new Error("Native configuration must export { options, scope }");
    if ("platform" in config.options)
      throw new Error("Native CLI configuration must provide owned instance options; attached platforms are not supported");
    if (closeRequested) throw new Error("The native CLI connection is closing");
    const { createShip } = await import("@repo/sdk/native");
    if (closeRequested) throw new Error("The native CLI connection is closing");
    const ship = await createShip({ ...config.options, diagnostics: "stderr", caller: { source: "cli", userAgent } });
    try {
      if (closeRequested) throw new Error("The native CLI connection is closing");
      const scope = typeof config.scope === "function" ? await config.scope(ship) : config.scope;
      if (closeRequested) throw new Error("The native CLI connection is closing");
      await ship.start();
      const client = await ship.scope(scope);
      if (closeRequested) throw new Error("The native CLI connection is closing");
      session = { ship, client, configPath: path };
    } catch (error) {
      await ship.close();
      throw error;
    }
  })();
  return initialization;
}

export function closeNativeClient(): Promise<void> {
  closeRequested = true;
  return closing ??= (async () => {
    await initialization?.catch(() => {});
    await session?.ship.close();
    session = undefined;
  })().catch(error => { closing = undefined; throw error; });
}
