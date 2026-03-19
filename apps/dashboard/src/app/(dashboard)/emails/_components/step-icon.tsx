"use client";

import {
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
} from "lucide-react";
import type { MailStepStatus } from "@/lib/api";

export function StepIcon({ status }: { status: MailStepStatus["status"] }) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="size-5 text-emerald-500" />;
    case "failed":
      return <XCircle className="size-5 text-red-500" />;
    case "running":
      return <Loader2 className="size-5 text-blue-500 animate-spin" />;
    case "skipped":
      return <Circle className="size-4 text-muted-foreground/40" />;
    default:
      return <Circle className="size-4 text-muted-foreground/30" />;
  }
}
