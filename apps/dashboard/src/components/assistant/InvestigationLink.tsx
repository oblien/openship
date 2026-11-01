"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useResourceScope, useResourceScopeReady } from "@/hooks/use-scoped-resource";
import { useI18n } from "@/components/i18n-provider";
import { Button, type ButtonProps } from "@/components/ui/button";
import { investigationHref, type AssistantInvestigation } from "./investigation";

export function InvestigationLink({
  target,
  compact = false,
  size = "default",
  className,
}: {
  target: AssistantInvestigation;
  compact?: boolean;
  size?: ButtonProps["size"];
  className?: string;
}) {
  const scope = useResourceScope();
  const ready = useResourceScopeReady();
  const { t } = useI18n();
  const copy = t.dashboard.investigation;
  const label =
    target.kind === "monitoring"
      ? copy.reportAction
      : target.kind === "issue" && target.intent === "fix"
        ? copy.fixAction
        : copy.action;
  const href = investigationHref(target, scope);
  if (!href) return null;
  if (!ready)
    return (
      <Button disabled variant="secondary" size={size} className={className} aria-label={label}>
        <Icon name="assistant" aria-hidden />
        {!compact && label}
      </Button>
    );
  return (
    <Button asChild variant="secondary" size={size} className={className}>
      <Link href={href} prefetch={false} aria-label={label} title={label}>
        <Icon name="assistant" aria-hidden />
        {!compact && label}
      </Link>
    </Button>
  );
}
