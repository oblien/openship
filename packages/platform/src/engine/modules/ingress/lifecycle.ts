import { diagnostics } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { nativeJobsEnabled } from "../../native/execution-policy";
import { trackBackgroundWork } from "../../lib/background-work";
import { reconcileConnection, reconcileHostname } from "./service";
let stopped = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let current: Promise<void> | undefined;
export async function sweepIngress(): Promise<void> {
  for (const connection of await repos.ingress.pendingConnections()) {
    if (stopped) return;
    await reconcileConnection(connection);
  }
  for (const { host } of await repos.ingress.due()) {
    if (stopped) return;
    await reconcileHostname(host);
  }
}
export function startIngressController(): void {
  if (!stopped || !nativeJobsEnabled()) return;
  stopped = false;
  const tick = () => {
    if (stopped) return;
    current = trackBackgroundWork(
      sweepIngress().catch((error) =>
        diagnostics.warn("ingress/controller", "Public ingress recovery failed", error),
      ),
    );
    void current.finally(() => {
      current = undefined;
      if (!stopped) {
        timer = setTimeout(tick, 30_000);
        timer.unref?.();
      }
    });
  };
  timer = setTimeout(tick, 0);
  timer.unref?.();
}
export async function stopIngressController(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
  await current;
}
