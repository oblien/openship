"use client";

import { useI18n } from "@/components/i18n-provider";
import "./topology.css";

const NODES = [
  [30, 164],
  [290, 60],
  [290, 268],
  [550, 164],
] as const;
const WORKFLOW_NODES = [
  [20, 156],
  [320, 72],
  [320, 240],
] as const;

/** The same canvas placeholder while the view code and its runtime data load. */
export function TopologySkeleton({
  withHeader = false,
  variant = "services",
}: {
  withHeader?: boolean;
  variant?: "services" | "workflow";
}) {
  const { t } = useI18n();
  const workflow = variant === "workflow";

  return (
    <div
      role="status"
      className={`flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card ${withHeader ? "topology-page" : ""}`}
    >
      <span className="sr-only">
        {workflow ? t.actions.integration.loading : t.projects.list.loading}
      </span>
      {withHeader && (
        <div
          aria-hidden="true"
          className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 px-4 py-3"
        >
          <div className="flex h-5 min-w-0 flex-1 items-center">
            <div className="h-3 w-40 rounded bg-muted-foreground/15 motion-safe:animate-pulse" />
          </div>
          <div className="topology-toolbar flex items-center gap-2 motion-safe:animate-pulse">
            <div className="size-9 rounded-lg bg-muted-foreground/5" />
            <div className="h-8 w-28 rounded-lg bg-muted-foreground/10" />
            <div className="size-9 rounded-lg bg-muted-foreground/5" />
            <div className="ms-auto h-8 w-20 rounded-lg bg-muted-foreground/5" />
          </div>
        </div>
      )}
      <div
        aria-hidden="true"
        className={`relative min-h-0 flex-1 overflow-hidden bg-[var(--th-card-on-page)] ${workflow ? "" : "topology-workspace"}`}
        style={{
          backgroundImage: "radial-gradient(var(--th-on-10) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      >
        <svg
          viewBox={workflow ? "0 0 580 376" : "0 0 760 440"}
          className={`absolute inset-0 h-full w-full p-6 pb-16 ${workflow ? "mx-auto max-w-[680px]" : ""}`}
          fill="none"
        >
          <g className="stroke-muted-foreground/15" strokeWidth="2">
            {workflow ? (
              <>
                <path d="M260 188 H280 Q290 188 290 178 V114 Q290 104 300 104 H320" />
                <path d="M260 188 H280 Q290 188 290 198 V262 Q290 272 300 272 H320" />
              </>
            ) : (
              <>
                <path d="M210 218 C250 218 250 114 290 114" />
                <path d="M210 218 C250 218 250 322 290 322" />
                <path d="M470 114 C510 114 510 218 550 218" />
                <path d="M470 322 C510 322 510 218 550 218" />
              </>
            )}
          </g>
          <g className="motion-safe:animate-pulse">
            {(workflow ? WORKFLOW_NODES : NODES).map(([x, y]) => (
              <g key={`${x}:${y}`} transform={`translate(${x} ${y})`}>
                {workflow ? (
                  <>
                    <rect
                      width="240"
                      height="64"
                      rx="8"
                      className="fill-muted-foreground/[0.04] stroke-border/80"
                    />
                    <circle
                      cx="24"
                      cy="32"
                      r="10"
                      className="stroke-muted-foreground/20"
                      strokeWidth="2"
                    />
                    <rect
                      x="46"
                      y="20"
                      width="108"
                      height="9"
                      rx="4"
                      className="fill-muted-foreground/15"
                    />
                    <rect
                      x="46"
                      y="37"
                      width="76"
                      height="7"
                      rx="3"
                      className="fill-muted-foreground/10"
                    />
                    <circle cx="0" cy="32" r="2" className="fill-muted-foreground/25" />
                    <circle cx="240" cy="32" r="2" className="fill-muted-foreground/25" />
                  </>
                ) : (
                  <>
                    <rect
                      width="180"
                      height="108"
                      rx="16"
                      className="fill-muted-foreground/[0.06]"
                    />
                    <rect
                      x="16"
                      y="16"
                      width="30"
                      height="30"
                      rx="9"
                      className="fill-muted-foreground/15"
                    />
                    <rect
                      x="58"
                      y="20"
                      width="84"
                      height="9"
                      rx="4"
                      className="fill-muted-foreground/20"
                    />
                    <rect
                      x="58"
                      y="37"
                      width="62"
                      height="7"
                      rx="3"
                      className="fill-muted-foreground/10"
                    />
                    <rect
                      x="14"
                      y="74"
                      width="152"
                      height="20"
                      rx="6"
                      className="fill-muted-foreground/5"
                    />
                  </>
                )}
              </g>
            ))}
          </g>
        </svg>
        <div className="absolute bottom-4 start-4 flex items-center gap-3 rounded-xl bg-background p-3 motion-safe:animate-pulse">
          <div className="size-4 rounded bg-muted-foreground/15" />
          <div className="h-3 w-9 rounded bg-muted-foreground/10" />
          <div className="size-4 rounded bg-muted-foreground/15" />
          <div className="ms-2 size-4 rounded bg-muted-foreground/15" />
          <div className="size-4 rounded bg-muted-foreground/15" />
        </div>
      </div>
    </div>
  );
}
