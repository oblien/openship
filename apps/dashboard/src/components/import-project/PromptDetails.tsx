"use client";

import React from "react";
import { Lock, ArrowRight, AlertTriangle } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * Renders the `details` payload of a pipeline prompt. Two shapes:
 *
 *  - port conflict → a port/PID/systemd-unit key list (a service already on the port).
 *  - edge conflict → the sites parsed from an existing reverse proxy on 80/443, so the
 *    operator can AUDIT exactly what a "migrate & take over" would import (and, via the
 *    warnings, what won't migrate automatically).
 *
 * Shared by DeploymentProcessing + ComposeDeploymentProcessing so both prompt modals
 * surface the same information. `details` is untyped over the wire (Record) — narrow it here.
 */

type EdgeSite = {
  serverNames: string[];
  ssl: boolean;
  target: { kind: "proxy"; url: string } | { kind: "static"; root: string };
  tls?: { certPath: string; keyPath: string };
  source?: string;
};

function asEdgeSites(details: Record<string, unknown>): EdgeSite[] {
  const raw = details.sites;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is EdgeSite =>
      !!s &&
      typeof s === "object" &&
      Array.isArray((s as { serverNames?: unknown }).serverNames) &&
      typeof (s as { target?: unknown }).target === "object" &&
      (s as { target: { kind?: unknown } }).target?.kind != null,
  );
}

function asWarnings(details: Record<string, unknown>): string[] {
  const raw = details.warnings;
  return Array.isArray(raw) ? raw.filter((w): w is string => typeof w === "string") : [];
}

type EdgeOccupant = {
  port: number;
  command?: string;
  systemdUnit?: string;
  containerName?: string;
  pid?: number;
  proxy?: string;
};

/** What's currently holding ports 80/443, carried in `details.edge.occupants`. */
function asOccupants(details: Record<string, unknown>): EdgeOccupant[] {
  const edge = details.edge as { occupants?: unknown } | undefined;
  const raw = edge?.occupants;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is EdgeOccupant => !!o && typeof o === "object" && typeof (o as { port?: unknown }).port === "number",
  );
}

function targetLabel(site: EdgeSite, staticLabel: string): string {
  return site.target.kind === "proxy" ? site.target.url : `${staticLabel} ${site.target.root}`;
}

export const PromptDetails: React.FC<{ details?: Record<string, unknown> }> = ({ details }) => {
  const { t } = useI18n();
  const dp = t.importProject.deploymentProcessing;

  if (!details) return null;

  const occupants = asOccupants(details);
  const sites = asEdgeSites(details);
  const warnings = asWarnings(details);

  // ── Edge conflict: what's on the ports + detected sites + warnings ──────
  if (occupants.length > 0 || sites.length > 0 || warnings.length > 0) {
    return (
      <div className="space-y-3">
        {occupants.length > 0 && (
          <div className="rounded-xl border border-border bg-muted/40 p-3 space-y-2">
            {occupants.map((o, i) => (
              <div key={`${o.port}-${i}`} className="flex items-center gap-2 text-sm">
                <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning">
                  :{o.port}
                </span>
                <span className="text-foreground/90 break-all flex-1">
                  {o.containerName ?? o.systemdUnit ?? o.command ?? `PID ${o.pid ?? "?"}`}
                </span>
                {o.proxy && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                    {o.proxy}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {sites.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {interpolate(dp.promptDetails.sites.lead, { count: String(sites.length) })}
            </p>
            <div className="rounded-xl border border-border bg-muted/40 divide-y divide-border">
              {sites.map((site, i) => (
                <div key={`${site.serverNames.join(",")}-${i}`} className="flex items-center gap-2 p-3 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-medium text-foreground truncate">
                        {site.serverNames.join(", ")}
                      </span>
                      {site.ssl && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success shrink-0">
                          <Lock className="size-2.5" />
                          {dp.promptDetails.sites.tlsBadge}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground min-w-0">
                      <ArrowRight className="size-3 shrink-0" />
                      <span className="truncate font-mono">{targetLabel(site, dp.promptDetails.sites.staticLabel)}</span>
                    </div>
                    {site.source && (
                      <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5">{site.source}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="rounded-xl border border-warning/30 bg-warning/5 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-warning">
              <AlertTriangle className="size-3.5" />
              {dp.promptDetails.sites.warningsTitle}
            </div>
            <ul className="space-y-1">
              {warnings.map((w, i) => (
                <li key={i} className="text-xs text-muted-foreground break-words">
                  {w}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // ── Port conflict: key/value list of the occupying process ──────────────
  const rows: Array<{ label: string; value: string | null }> = [
    { label: dp.promptDetails.port, value: details.port != null ? String(details.port) : null },
    { label: dp.promptDetails.process, value: typeof details.command === "string" ? details.command : null },
    { label: "PID", value: details.pid != null ? String(details.pid) : null },
    { label: "Systemd Unit", value: typeof details.systemdUnit === "string" ? details.systemdUnit : null },
    { label: dp.promptDetails.unitDescription, value: typeof details.systemdDescription === "string" ? details.systemdDescription : null },
    { label: dp.promptDetails.openshipDeployment, value: typeof details.deploymentId === "string" ? details.deploymentId : null },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));

  if (rows.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-4 space-y-3">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">{row.label}</span>
          <span className="text-sm text-foreground break-all">{row.value}</span>
        </div>
      ))}
    </div>
  );
};

export default PromptDetails;
