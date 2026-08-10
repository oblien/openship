"use client";

import React from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { MAX_ROLLBACK_WINDOW } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { InfoCard } from "@/components/settings/InfoCard";
import { formatBytes } from "@/lib/formatBytes";
import type { RollbackCapacityUI } from "@/lib/api/projects";

/**
 * The rollback retention controls — strategy + how many releases stay
 * restorable — as one props-driven pair of cards.
 *
 * Rendered in TWO places (project settings → Git, and the deploy wizard's target
 * panel), which is exactly why it takes values and callbacks instead of reading
 * ProjectSettingsContext: the wizard route lives outside that provider, and a
 * second hand-built copy of these controls is how the two surfaces would drift.
 *
 * The window value shown is always the one retention actually enforces: an
 * explicit override when the operator typed one, otherwise the disk-sized auto
 * window measured at the last deploy (`capacity.source`).
 */
export interface RollbackRetentionCardsProps {
  /** Project retention preference: "snapshot" keeps artifacts, "git" rebuilds. */
  strategy: "git" | "snapshot";
  /**
   * What ONE retained version physically is on this project's host:
   *   "image" — a container image (server apps, each compose service).
   *   "files" — the built files of a static site. There is no image at all, so
   *     copy that talks about images is simply wrong for these projects, and a
   *     restore is a copy of a directory rather than a container start.
   */
  artifactKind?: "image" | "files";
  /** Live retention numbers from GET /projects/:id/rollback-capacity. */
  capacity: RollbackCapacityUI | null;
  onToggleStrategy?: () => void;
  /** Called with the new explicit window. Absent → the stepper is hidden. */
  onChangeWindow?: (next: number) => void;
  togglingStrategy?: boolean;
  savingWindow?: boolean;
  /** No project row yet (a first deploy): show what WILL apply, no controls. */
  readOnly?: boolean;
}

export function RollbackRetentionCards({
  strategy,
  capacity,
  artifactKind = "image",
  onToggleStrategy,
  onChangeWindow,
  togglingStrategy = false,
  savingWindow = false,
  readOnly = false,
}: RollbackRetentionCardsProps) {
  const { t } = useI18n();
  const g = t.projectSettings.git;
  const isSnapshot = strategy === "snapshot";
  const isFiles = artifactKind === "files";
  const windowVal = capacity?.window ?? 5;
  const maxWindow = capacity?.maxWindow ?? MAX_ROLLBACK_WINDOW;
  const canEdit = !readOnly && !!onChangeWindow;

  /** "files on disk · ~1.8 GB each · 42 GB free · auto" — the artifact kind
   *  always, then only the parts we actually measured. */
  const measured: string[] = [
    isFiles ? g.rollbackHistory.kindFiles : g.rollbackHistory.kindImages,
  ];
  if (capacity?.snapshotSizeBytes) {
    measured.push(
      interpolate(g.rollbackHistory.sizeEach, { size: formatBytes(capacity.snapshotSizeBytes) }),
    );
  }
  if (capacity?.diskFreeBytes) {
    measured.push(
      interpolate(g.rollbackHistory.diskFree, { size: formatBytes(capacity.diskFreeBytes) }),
    );
  }
  if (capacity?.source === "auto") measured.push(g.rollbackHistory.autoBadge);
  if (capacity?.source === "explicit") measured.push(g.rollbackHistory.manualBadge);

  // Description and MEASUREMENTS stay separate. Joining them with " — " produced
  // one long paragraph that, in the deploy wizard's narrow two-column layout,
  // wrapped into ~8 lines and blew out the card height. The numbers go in the
  // card's footer slot instead, where they read as metadata.
  const historyDescription = isSnapshot
    ? g.rollbackHistory.descSnapshot
    : isFiles
      ? g.rollbackHistory.descGitFiles
      : g.rollbackHistory.descGit;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <InfoCard
        icon={RotateCcw}
        title={g.rollbackStrategy.title}
        value={isSnapshot ? g.rollbackStrategy.keepCopies : g.rollbackStrategy.keepNone}
        description={
          isSnapshot
            ? isFiles
              ? g.rollbackStrategy.descInstantFiles
              : g.rollbackStrategy.descInstant
            : isFiles
              ? g.rollbackStrategy.descRebuildFiles
              : g.rollbackStrategy.descRebuild
        }
        action={
          readOnly || !onToggleStrategy ? undefined : (
            <button
              type="button"
              role="switch"
              aria-checked={isSnapshot}
              onClick={onToggleStrategy}
              disabled={togglingStrategy}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isSnapshot ? "bg-primary" : "bg-muted"} ${togglingStrategy ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
              aria-label={g.rollbackStrategy.toggleAria}
            >
              {togglingStrategy ? (
                <span className="mx-auto">
                  <Loader2 className="size-3.5 animate-spin text-background" />
                </span>
              ) : (
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${isSnapshot ? "translate-x-6 rtl:-translate-x-6" : "translate-x-1 rtl:-translate-x-1"}`}
                />
              )}
            </button>
          )
        }
      />
      <InfoCard
        icon={RotateCcw}
        title={g.rollbackHistory.title}
        value={interpolate(
          windowVal === 1 ? g.rollbackHistory.valueOne : g.rollbackHistory.valueOther,
          { count: String(windowVal) },
        )}
        description={historyDescription}
        footer={
          <p className="text-[11px] leading-relaxed text-muted-foreground/80">
            {measured.join(" · ")}
          </p>
        }
        action={
          canEdit ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => onChangeWindow?.(windowVal - 1)}
                disabled={savingWindow || windowVal <= 0}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-border/60 text-foreground transition-colors enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={g.rollbackHistory.decreaseAria}
              >
                −
              </button>
              <span className="w-5 text-center text-[13px] font-medium tabular-nums text-foreground">
                {savingWindow ? (
                  <Loader2 className="mx-auto size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  windowVal
                )}
              </span>
              <button
                type="button"
                onClick={() => onChangeWindow?.(windowVal + 1)}
                disabled={savingWindow || windowVal >= maxWindow}
                className="flex h-6 w-6 items-center justify-center rounded-md border border-border/60 text-foreground transition-colors enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={g.rollbackHistory.increaseAria}
              >
                +
              </button>
            </div>
          ) : undefined
        }
      />
    </div>
  );
}

export default RollbackRetentionCards;
