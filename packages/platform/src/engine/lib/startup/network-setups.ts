import { getDriver } from "@repo/db";
import { recoverNetworkSetups } from "../../modules/system/network-setup-lifecycle";
import { registerStartupHook } from "./index";

/** Self-hosted only. The PGlite lock proves the previous controller has exited. */
export function registerNetworkSetupRecovery(): void {
  registerStartupHook({
    id: "network-setup-recovery",
    modes: ["selfhosted", "desktop"],
    run: () => recoverNetworkSetups(getDriver() === "pglite"),
  });
}
