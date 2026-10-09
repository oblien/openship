import { shutdownJobRunner } from "@repo/platform/engine/lib/job-runner/index";
import { stopNotificationRunner } from "@repo/platform/engine/lib/notification-workers";
import { drainBackgroundWork } from "@repo/platform/engine/lib/background-work";
import { drainDeploymentExecutions } from "@repo/platform/engine/modules/deployments/deployment-cancellation";
import { drainServerInstallations } from "@repo/platform/engine/modules/system/server-install.operations";
import { stopAllContainerEventWatchers } from "@repo/platform/engine/modules/monitoring/container-events";
import { closeDeviceFlows } from "@repo/platform/engine/modules/github/github.local-auth";
import { drainControllerRequests } from "./controller-state";
import { closeControllerSockets } from "../../../lib/ws";
import { closeControllerStreams } from "../../../lib/sse";
import { closeControllerTerminals } from "../../../lib/terminal-session-manager";
import { closeControllerServiceTerminals } from "../../../lib/service-terminal-session-manager";
import { stopNetworkSetups } from "@repo/platform/engine/modules/system/network-setup-lifecycle";
import { stopAllTunnels } from "@repo/platform/engine/lib/ssh-tunnel-manager";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { closeInstanceRelays } from "./desktop-relay";

function closeTerminals(): void {
  closeControllerTerminals();
  closeControllerServiceTerminals();
}

/** The HTTP fence is already durable before this runs. No timeout is treated as
 * success: a long-running build leaves the handoff waiting and resumable. */
export async function quiesceController(): Promise<void> {
  closeControllerSockets();
  closeControllerStreams();
  closeInstanceRelays();
  await drainControllerRequests();
  closeTerminals();
  await Promise.all([stopNetworkSetups(), stopAllTunnels()]);
  await (await import("@repo/platform/engine/modules/actions/lifecycle")).stopActionController();
  // Recheck after fencing incoming mutations: a dispatch may have arrived
  // between the user's preflight and the durable handoff fence.
  await (await import("@repo/platform/engine/modules/actions/lifecycle")).assertActionsTransferReady();
  await Promise.all([shutdownJobRunner(), stopNotificationRunner(), closeDeviceFlows()]);
  await Promise.all([
    drainDeploymentExecutions(),
    drainServerInstallations(),
    drainBackgroundWork(),
  ]);
  // An already admitted WebSocket onOpen may finish opening its shell while
  // the first drain is waiting. Close those sessions too, then await their
  // audit writes and managed execution releases before taking the snapshot.
  closeTerminals();
  await drainBackgroundWork();
  // Jobs may have subscribed during their final tick; close after draining them.
  await stopAllContainerEventWatchers();
  await flushAudit();
}
