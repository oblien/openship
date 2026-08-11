/**
 * Boot hook: react to a control-plane version bump by scanning remote infra.
 *
 * When this control plane self-updates — a desktop relaunch onto a new build, or
 * `openship update` on a self-hosted box — `APP_VERSION` moves forward, and the
 * edge/mail containers already deployed on connected servers are now pinned to a
 * newer tag than they're running. The periodic `infra:scan` job would notice
 * within its 6-hour window; this hook makes it IMMEDIATE, right after the boot
 * that carries the new version.
 *
 * It fires exactly once per version: `instance_settings.lastSeenVersion` records
 * the version the scan last ran for, so an ordinary restart (same version) is a
 * no-op. First boot (null → current) counts as a change and runs once — cheap
 * when there are no servers.
 *
 * The scan itself is `scanInstanceContainers` (called directly, NOT via
 * `runJobNow`, because job seeding is fire-and-forget at boot and may not have
 * registered the row yet). It runs in the BACKGROUND so a slow SSH sweep — or an
 * auto-apply, when `autoUpdateInfra` is on — never holds up boot. Both the
 * advisory (toggle off) and the auto-update (toggle on) fall out of that one
 * call. Self-hosted + desktop only (CLOUD_MODE never runs startup hooks).
 */

import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import { registerStartupHook } from "./index";
import { readApiVersion } from "../release-resolver";
import { scanInstanceContainers } from "../../modules/system/server-containers.service";

export function registerInfraReconcile(): void {
  registerStartupHook({
    id: "infra:reconcile",
    modes: ["desktop", "selfhosted"],
    run: async () => {
      const current = readApiVersion();
      const settings = await repos.instanceSettings.get().catch(() => undefined);
      if (settings?.lastSeenVersion === current) return;

      // Record the version FIRST so a scan that is slow or crashes doesn't make
      // the next boot re-trigger — the periodic job is the retry, not reboot.
      await repos.instanceSettings
        .upsert({ lastSeenVersion: current })
        .catch((err) => console.warn(`[infra-reconcile] version write failed: ${safeErrorMessage(err)}`));

      console.log(
        `[infra-reconcile] control plane at ${current}` +
          `${settings?.lastSeenVersion ? ` (was ${settings.lastSeenVersion})` : " (first boot)"}` +
          ` — scanning remote edge/mail containers`,
      );
      void scanInstanceContainers()
        .then((r) =>
          console.log(
            `[infra-reconcile] scanned ${r.servers} server(s): ${r.behind} behind, ${r.updated} updated`,
          ),
        )
        .catch((err) => console.warn(`[infra-reconcile] scan failed: ${safeErrorMessage(err)}`));
    },
  });
}
