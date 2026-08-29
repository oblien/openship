"use client";

// TODO: temporary desktop gate — see useLocalDeployGate.ts. Delete this file and
// its call sites when DESKTOP_LOCAL_DEPLOY_ENABLED flips to true.

import { useRouter } from "next/navigation";
import { MonitorSmartphone, Server, ArrowRight } from "lucide-react";
import type { ServerInfo } from "@/lib/api/system";
import { useAddServerModal } from "@/components/servers/add-server-modal";

/**
 * Shown instead of running a deploy when the chosen destination is the desktop
 * itself. Desktop mode is built to control remote servers; running the workload
 * on this machine isn't enabled yet, so the recovery is "connect a server".
 *
 * Copy is hardcoded English on purpose, matching CloudWaitlistModal: this is a
 * temporary gate, and adding then removing i18n keys for it would churn the
 * locale files (and the parity test) twice.
 */
export function LocalDeployComingSoonModal({
  onClose,
  action = "deploy",
  onServerAdded,
}: {
  onClose: () => void;
  /** Tailors the first line to the button the user actually pressed. */
  action?: "deploy" | "install";
  /**
   * Given a handler, "Connect a server" adds the server in place (panel on top
   * of this one) and hands it back so the caller can retarget the deploy the
   * user was already halfway through. Without one we fall back to /servers/new.
   */
  onServerAdded?: (server: ServerInfo) => void;
}) {
  const router = useRouter();
  const openAddServer = useAddServerModal();

  const connectServer = () => {
    if (!onServerAdded) {
      onClose();
      router.push("/servers/new");
      return;
    }
    openAddServer((server) => {
      onClose();
      onServerAdded(server);
    });
  };

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <MonitorSmartphone className="size-5" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">
            Running on this machine is coming soon
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {action === "install"
              ? "Installing apps onto this computer isn't enabled yet. "
              : "Deploying onto this computer isn't enabled yet. "}
            The desktop app is built to <strong className="font-medium text-foreground">control
            your servers</strong> — connect one and it becomes the destination. We&apos;re enabling
            local runs in a future release.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-background px-4 py-3">
        <div className="flex items-start gap-2.5 text-sm text-muted-foreground">
          <Server className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            Add a server once and every deploy from this desktop lands there. Your builds can still
            run locally.
          </span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Not now
        </button>
        <button
          type="button"
          onClick={connectServer}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Connect a server
          <ArrowRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
