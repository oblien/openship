"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import TerminalSurface from "./TerminalSurface";
import { useBuildStream } from "@/hooks/useSSEConnection";
import { useTheme } from "@/components/theme-provider";
import { deployApi } from "@/lib/api";

/**
 * Live xterm view of an EXISTING deployment's build/deploy logs, driven purely
 * by a `deploymentId` — no `DeploymentProvider`, no `useDeploymentBuild` state
 * machine. Reuses `TerminalSurface` (the context-free xterm mount) + the
 * context-free `useBuildStream` in attach-only mode, so there's zero duplicated
 * xterm setup. Used by the migration wizard to show the same native terminal
 * the /deploy screen shows.
 *
 *   - `live` (deploy still running) → attach the build SSE (`GET /:id/stream`),
 *     which replays the buffered history and streams new frames. Never starts a
 *     new build.
 *   - not live (finished/failed) → seed the persisted logs once from
 *     `getBuildStatus` (the stream won't replay a terminal deploy).
 */
export function DeploymentTerminal({
  deploymentId,
  live,
  className,
}: {
  deploymentId: string;
  live: boolean;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const termRef = useRef<Terminal | null>(null);
  const [ready, setReady] = useState(false);
  const build = useBuildStream({ terminalRef: termRef, autoWriteToTerminal: true });
  const seededRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !deploymentId) return;
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;

    if (live) {
      // Attach-only: replays history + streams new frames. No new deploy.
      void build.connect(deploymentId, false).catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/import-project/DeploymentTerminal");
      });
    } else if (seededRef.current !== deploymentId) {
      // Terminal deploy: the stream won't replay, so paint persisted logs once.
      seededRef.current = deploymentId;
      void (async () => {
        try {
          const st = await deployApi.getBuildStatus(deploymentId);
          const logs = typeof st?.logs === "string" ? st.logs : "";
          if (!cancelled && logs) term.write(logs.replace(/\r?\n/g, "\r\n"));
        } catch (diagnosticFailure) {
          observeCaughtError(diagnosticFailure, "dashboard/components/import-project/DeploymentTerminal");
          /* best-effort */
        }
      })();
    }

    return () => {
      cancelled = true;
      build.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, deploymentId, live]);

  return (
    <TerminalSurface
      terminalRef={termRef}
      onReady={() => setReady(true)}
      theme={resolvedTheme === "light" ? "light" : "dark"}
      className={className}
    />
  );
}

export default DeploymentTerminal;
