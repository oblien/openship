"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { useI18n } from "@/components/i18n-provider";
import { cn } from "@/lib/utils";
import {
  getProjectStatus,
  projectActionHref,
  projectStatusHref,
  projectStatusHint,
  PROJECT_STATUS_META,
  projectStatusLabel,
  type ProjectStatusSource,
} from "@/utils/project-status";

/**
 * The shared project-status mark.
 *
 * A genuine Action Required state links to the screen that owns its resolution;
 * failed/in-progress states may link to their build details. Passive states stay
 * plain text. Keeping that rule in one component prevents a new project surface
 * from accidentally recreating a dead-end amber badge.
 */
export function ProjectStatusBadge({
  project,
  className,
}: {
  project: ProjectStatusSource;
  className?: string;
}) {
  const { t } = useI18n();
  const status = getProjectStatus(project);
  const label = projectStatusLabel(status, t);
  const hint = projectStatusHint(project, t);
  const actionHref = projectActionHref(project);
  const href = projectStatusHref(project);
  const classes = cn("inline-flex items-center", PROJECT_STATUS_META[status].badge, className);

  if (!href) {
    return (
      <span className={classes} {...(hint ? { title: hint } : {})}>
        {label}
      </span>
    );
  }

  return (
    <Link
      href={href}
      title={hint ?? label}
      aria-label={hint ? `${label}: ${hint}` : label}
      {...(actionHref ? { "data-project-action-required": "true" } : {})}
      className={cn(
        classes,
        "relative z-10 gap-0.5 transition-[filter,box-shadow] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/50",
      )}
    >
      {label}
      <ChevronRight className="size-3 rtl:rotate-180" aria-hidden="true" />
    </Link>
  );
}
