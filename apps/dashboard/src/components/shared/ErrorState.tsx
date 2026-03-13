"use client";

import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  GitBranch,
  Lock,
  ArrowLeft,
  Plus,
  HelpCircle,
  ExternalLink,
} from "lucide-react";

/* ── Error type configs ─────────────────────────────────────────────── */

const ERROR_CONFIGS = {
  "repo-not-found": {
    icon: GitBranch,
    iconColor: "text-destructive",
    iconBg: "bg-destructive/10",
    title: "Repository Not Found",
    subtitle: "We couldn't find the repository you're looking for.",
    hints: [
      "Repository is private and you haven't granted access",
      "Repository name or owner is misspelled",
      "Repository has been deleted or moved",
      "Your GitHub connection has expired",
    ],
    actions: [
      { label: "Back to Library", icon: ArrowLeft, variant: "secondary" as const, path: "/library" },
      { label: "Import Repository", icon: Plus, variant: "primary" as const, path: "/library" },
    ],
  },
  "project-not-found": {
    icon: AlertTriangle,
    iconColor: "text-destructive",
    iconBg: "bg-destructive/10",
    title: "Project Not Found",
    subtitle: "The project you are looking for does not exist or has been deleted.",
    hints: [
      "Project has been deleted",
      "You don't have access to this project",
      "The project URL is incorrect",
    ],
    actions: [
      { label: "Back to Dashboard", icon: ArrowLeft, variant: "secondary" as const, path: "/" },
      { label: "Create New Project", icon: Plus, variant: "primary" as const, path: "/library" },
    ],
  },
  "access-denied": {
    icon: Lock,
    iconColor: "text-orange-500",
    iconBg: "bg-orange-500/10",
    title: "Access Denied",
    subtitle: "You don't have permission to access this resource.",
    hints: [
      "You are not the project owner",
      "Your account doesn't have the required permissions",
      "Your team membership has changed",
    ],
    actions: [
      { label: "Back to Dashboard", icon: ArrowLeft, variant: "secondary" as const, path: "/" },
    ],
  },
} as const;

type ErrorType = keyof typeof ERROR_CONFIGS;

interface ErrorStateProps {
  type?: ErrorType;
  error?: {
    message?: string;
    details?: string;
  };
}

/* ── Component ──────────────────────────────────────────────────────── */

export default function ErrorState({ error = {}, type = "repo-not-found" }: ErrorStateProps) {
  const router = useRouter();
  const config = ERROR_CONFIGS[type] ?? ERROR_CONFIGS["repo-not-found"];
  const Icon = config.icon;

  const title = error.message || config.title;
  const subtitle = error.details || config.subtitle;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="max-w-xl mx-auto pt-12">

          {/* ── Error card ───────────────────────────────────────── */}
          <div className="bg-card rounded-2xl border border-border/50">
            {/* Header */}
            <div className="px-6 py-5 border-b border-border/50">
              <div className="flex items-center gap-4">
                <div className={`w-11 h-11 rounded-xl ${config.iconBg} flex items-center justify-center`}>
                  <Icon className={`size-5 ${config.iconColor}`} />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                  <p className="text-sm text-muted-foreground/70 mt-0.5">{subtitle}</p>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-5">
              {/* Hints */}
              {config.hints.length > 0 && (
                <div>
                  <h3 className="text-sm font-medium text-foreground mb-2.5">Common causes</h3>
                  <ul className="space-y-1.5">
                    {config.hints.map((hint, i) => (
                      <li key={i} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                        <span className="mt-1.5 size-1 rounded-full bg-muted-foreground/40 shrink-0" />
                        {hint}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-3 pt-1">
                {config.actions.map((action, i) => {
                  const ActionIcon = action.icon;
                  return (
                    <button
                      key={i}
                      onClick={() => router.push(action.path)}
                      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                        action.variant === "primary"
                          ? "bg-foreground text-background hover:bg-foreground/90"
                          : "bg-muted/60 text-foreground hover:bg-muted"
                      }`}
                    >
                      <ActionIcon className="size-4" />
                      {action.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── Help card ────────────────────────────────────────── */}
          <div className="bg-card rounded-2xl border border-border/50 mt-4 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <HelpCircle className="size-[18px] text-primary" />
              </div>
              <div>
                <h3 className="text-sm font-medium text-foreground mb-1">Need help?</h3>
                <p className="text-xs text-muted-foreground/70 mb-2.5">
                  Check the documentation or reach out if the issue persists.
                </p>
                <div className="flex gap-4">
                  <a
                    href="https://openship.org/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 transition-colors"
                  >
                    Documentation <ExternalLink className="size-3" />
                  </a>
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
