"use client";
import { useSearchParams } from "next/navigation";
import { ServerSecurityRuns } from "@/components/updates/ServerSecurityRuns";
import { SecurityOverviewPanel } from "@/components/updates/SecurityOverviewPanel";
import { Logo } from "@/components/logo";

/** Actual dashboard components, isolated synthetic transports in capture.mjs. */
export default function Preview() {
  const monitoring = useSearchParams().get("monitoring") === "1";
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-5 py-8 space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 font-medium">
            <Logo size={28} /> Openship
          </div>
          <span className="text-xs text-muted-foreground">Preview · synthetic server data</span>
        </header>
        <div>
          <h1 className="text-2xl font-medium">
            {monitoring ? "Monitoring · Security" : "Commerce host"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {monitoring ? "Workspace advisory inspections" : "Runs · Ubuntu 24.04"}
          </p>
        </div>
        {monitoring ? (
          <SecurityOverviewPanel
            onChecked={() => {}}
            overview={{
              checksEnabled: true,
              projects: [],
              pendingProjects: 0,
              unknownProjects: 0,
              scan: {
                status: "completed",
                startedAt: "2026-11-03T09:00:00Z",
                finishedAt: "2026-11-03T09:00:02Z",
                schedule: "*/5 * * * *",
                schedulerEnabled: true,
                runsWhileAppOpen: false,
              },
              servers: [
                {
                  serverId: "preview-host",
                  name: "Commerce host",
                  checksEnabled: true,
                  supported: true,
                  canManage: true,
                  pending: false,
                  checkedAt: "2026-11-03T09:00:00Z",
                  nextCheckAt: "2026-11-03T15:00:00Z",
                  error: null,
                  feedStale: false,
                  findings: [
                    {
                      id: "HOST-PREVIEW",
                      revision: 1,
                      title: "Ubuntu package update",
                      message: "Synthetic advisory for UI review.",
                      severity: "high",
                      url: "https://ubuntu.com/security",
                      packages: ["openssl"],
                      evidence: ["openssl: 3.0.13-0ubuntu3.9"],
                      state: "affected",
                      canPatch: true,
                      canReboot: false,
                    },
                  ],
                },
              ],
            }}
          />
        ) : (
          <ServerSecurityRuns serverId="preview-host" />
        )}
      </div>
    </main>
  );
}
