"use client";

/**
 * The single, professional surface for updates + advisories, for BOTH the
 * desktop app and self-hosted servers:
 *   - a severity-colored advisory banner (critical always shows),
 *   - a subtle "update available" banner,
 *   - a one-time "what's new" card after an update lands,
 *   - a changelog details modal.
 * All actions link to GitHub; desktop can drive the native in-app updater.
 */

import { useState } from "react";
import {
  AlertTriangle,
  AlertCircle,
  Info,
  Sparkles,
  Download,
  ExternalLink,
  Loader2,
  X,
} from "lucide-react";
import type { AdvisorySeverity } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import CopyCommand, { SELF_UPDATE_COMMAND } from "@/components/shared/CopyCommand";
import { useUpdates } from "./useUpdates";

const SEVERITY = {
  critical: { border: "border-danger-border", bg: "bg-danger-bg", fg: "text-danger", Icon: AlertTriangle },
  recommended: { border: "border-warning-border", bg: "bg-warning-bg", fg: "text-warning", Icon: AlertCircle },
  info: { border: "border-primary/30", bg: "bg-primary/10", fg: "text-primary", Icon: Info },
} as const;

function ExternalLinkBtn({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[13px] font-medium text-foreground underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink className="size-3.5" />
    </a>
  );
}

export function UpdateCenter() {
  const {
    state,
    latest,
    muted,
    desktop,
    mode,
    whatsNewVersion,
    dismissAdvisory,
    dismissWhatsNew,
    beginUpdate,
    updatePhase,
    updateProgress,
    updateError,
  } = useUpdates();
  const { t } = useI18n();
  const w = t.widgets.updates;
  const [notesOpen, setNotesOpen] = useState(false);

  const advisory = state?.advisories[0]; // most severe first
  // An in-flight download/install owns the top surface — suppress the advisory
  // banner so we never stack it next to its own progress bar.
  const updating = desktop && updatePhase !== "idle";
  const updatingVersion = state?.latestVersion ?? latest?.version ?? "";
  const pct = Math.round(Math.min(1, Math.max(0, updateProgress)) * 100);
  const changelog = state?.latestChangelogUrl ?? "https://github.com/oblien/openship/releases";

  return (
    <>
      {/* ── In-app update progress (desktop) ────────────────────────── */}
      {updating && (
        <div className="px-4 pt-4 sm:px-6 sm:pt-6">
          <div className="rounded-2xl border border-border/60 bg-card px-4 py-3">
            {updatePhase === "error" ? (
              <div className="flex items-center gap-3">
                <AlertCircle className="size-5 shrink-0 text-danger" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13.5px] font-semibold text-foreground">{w.updateFailed}</p>
                  {updateError && (
                    <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{updateError}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={beginUpdate}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
                >
                  <Download className="size-3.5" />
                  {w.retry}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  {updatePhase === "installing" ? (
                    <Loader2 className="size-5 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Download className="size-5 shrink-0 text-primary" />
                  )}
                  <p className="min-w-0 flex-1 text-[13.5px] text-foreground">
                    {updatePhase === "installing"
                      ? w.installing
                      : interpolate(w.downloading, { version: updatingVersion })}
                    {updatePhase === "downloading" && (
                      <span className="text-muted-foreground"> · {pct}%</span>
                    )}
                  </p>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-150"
                    style={{ width: updatePhase === "installing" ? "100%" : `${pct}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Advisory banner (critical/recommended/info) ─────────────── */}
      {!updating && advisory && (() => {
        const s = SEVERITY[advisory.severity as AdvisorySeverity];
        const Icon = s.Icon;
        return (
          <div className="px-4 pt-4 sm:px-6 sm:pt-6">
            <div className={`flex items-start gap-3 rounded-2xl border ${s.border} ${s.bg} px-4 py-3.5`}>
              <div className={`mt-0.5 shrink-0 ${s.fg}`}>
                <Icon className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`text-[11px] font-semibold uppercase tracking-wide ${s.fg}`}>{w.severity[advisory.severity as AdvisorySeverity]}</span>
                  <span className="text-[14px] font-semibold text-foreground">{advisory.title}</span>
                </div>
                <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{advisory.message}</p>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  {advisory.action?.kind === "open-url" && advisory.action.url ? (
                    <ExternalLinkBtn href={advisory.action.url}>{advisory.action.label}</ExternalLinkBtn>
                  ) : advisory.action?.kind === "update" && desktop ? (
                    <button
                      type="button"
                      onClick={beginUpdate}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
                    >
                      <Download className="size-3.5" />
                      {advisory.action.label}
                    </button>
                  ) : advisory.action?.kind === "update" && mode === "selfhosted" ? (
                    // A server can't be updated from the browser — the control
                    // plane upgrades itself through the CLI. Show the command
                    // instead of dropping the action entirely, which left the
                    // operator with a critical banner and no way to act on it.
                    <CopyCommand command={SELF_UPDATE_COMMAND} />
                  ) : null}
                  <ExternalLinkBtn href={changelog}>{w.viewChangelog}</ExternalLinkBtn>
                </div>
              </div>
              <button
                type="button"
                onClick={() => dismissAdvisory(advisory.id)}
                aria-label={w.dismiss}
                className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        );
      })()}

      {/* A bare "newer version exists" no longer raises a banner — that's the
          nagging-every-release problem. It's surfaced quietly instead: the home
          Updates block and Settings → Updates both show "vX available" + Update.
          The top banner is reserved for a deliberate release advisory (below),
          an operator platform notice, or the post-update "what's new" note. */}

      {/* ── "What's new" card (once, after an update) ───────────────── */}
      {whatsNewVersion && (
        <div className="fixed bottom-4 end-4 z-50 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border/60 bg-popover/90 shadow-2xl backdrop-blur-xl">
          <div className="flex items-start gap-3 px-4 py-4">
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Sparkles className="size-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-semibold text-foreground">{interpolate(w.updatedTo, { version: whatsNewVersion })}</p>
              <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
                {latest?.version === whatsNewVersion && latest.notes
                  ? w.seeChanges
                  : w.onLatest}
              </p>
              <div className="mt-2.5 flex items-center gap-3">
                {latest?.notes && latest.version === whatsNewVersion && (
                  <button
                    type="button"
                    onClick={() => setNotesOpen(true)}
                    className="text-[13px] font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {w.whatsNew}
                  </button>
                )}
                <ExternalLinkBtn href={changelog}>{w.changelog}</ExternalLinkBtn>
              </div>
            </div>
            <button
              type="button"
              onClick={dismissWhatsNew}
              aria-label={w.dismiss}
              className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* ── Changelog details modal ─────────────────────────────────── */}
      {notesOpen && latest && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          onClick={() => setNotesOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
              <h3 className="text-[15px] font-semibold text-foreground">{interpolate(w.whatsNewIn, { version: latest.version })}</h3>
              <button
                type="button"
                onClick={() => setNotesOpen(false)}
                aria-label={w.close}
                className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-[12.5px] leading-relaxed text-muted-foreground">
              {latest.notes?.trim() || w.noNotes}
            </pre>
            <div className="border-t border-border/50 px-5 py-3">
              <ExternalLinkBtn href={changelog}>{w.viewOnGithub}</ExternalLinkBtn>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
