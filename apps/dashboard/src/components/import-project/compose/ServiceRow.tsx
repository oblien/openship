"use client";

import React from "react";
import { CheckCircle2, Loader2, XCircle, Circle } from "lucide-react";
import type { ServiceDeployStatus } from "@/context/deployment/types";

// ─── Status helpers ──────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: ServiceDeployStatus["status"] }) {
  switch (status) {
    case "running":
      return <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />;
    case "built":
      return <CheckCircle2 className="w-4 h-4 text-muted-foreground shrink-0" />;
    case "building":
    case "deploying":
      return <Loader2 className="w-4 h-4 text-foreground animate-spin shrink-0" />;
    case "failed":
      return <XCircle className="w-4 h-4 text-destructive shrink-0" />;
    case "pending":
    default:
      return <Circle className="w-4 h-4 text-muted-foreground/50 shrink-0" />;
  }
}

const BADGE_STYLES: Record<ServiceDeployStatus["status"], string> = {
  running: "bg-primary/10 text-primary border-primary/20",
  built: "bg-muted text-muted-foreground border-muted-foreground/20",
  building: "bg-foreground/10 text-foreground border-foreground/20",
  deploying: "bg-foreground/10 text-foreground border-foreground/20",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
  pending: "bg-muted text-muted-foreground border-transparent",
};

const STATUS_LABEL: Record<ServiceDeployStatus["status"], string> = {
  running: "Running",
  built: "Built",
  building: "Building",
  deploying: "Deploying",
  failed: "Failed",
  pending: "Pending",
};

// ─── ServiceRow ──────────────────────────────────────────────────────────────

interface ServiceRowProps {
  service: ServiceDeployStatus;
}

const ServiceRow: React.FC<ServiceRowProps> = ({ service }) => {
  const { serviceName, status, image, error, hostPort } = service;

  return (
    <div className="group flex items-start gap-3 rounded-xl border border-border/50 px-4 py-3 transition-colors hover:bg-muted/20">
      {/* status icon — vertically centred to first text line */}
      <div className="mt-0.5">
        <StatusIcon status={status} />
      </div>

      {/* name + meta */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground truncate">
            {serviceName}
          </span>
          {hostPort && (
            <span className="text-[11px] font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
              :{hostPort}
            </span>
          )}
        </div>

        {image && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {image}
          </p>
        )}

        {error && (
          <p className="text-xs text-destructive mt-1 line-clamp-2">
            {error}
          </p>
        )}
      </div>

      {/* badge */}
      <span
        className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full border ${BADGE_STYLES[status]}`}
      >
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
};

export default React.memo(ServiceRow);
