"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import type { MailStepStatus } from "@/lib/api";

export function StepIcon({ status }: { status: MailStepStatus["status"] }) {
  switch (status) {
    case "completed":
      return <UiIcon name="check-circle" className="size-5 text-success" />;
    case "failed":
      return <UiIcon name="x-circle" className="size-5 text-danger" />;
    case "running":
      return <UiIcon name="spinner" className="size-5 text-info animate-spin" />;
    case "skipped":
      return <UiIcon name="circle" className="size-4 text-muted-foreground/40" />;
    default:
      return <UiIcon name="circle" className="size-4 text-muted-foreground/30" />;
  }
}
