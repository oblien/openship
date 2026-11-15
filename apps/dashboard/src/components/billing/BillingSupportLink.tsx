"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";

export function BillingSupportLink() {
  const { t } = useI18n();
  return (
    <Link
      href="/support"
      className="inline-flex h-9 shrink-0 items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
    >
      <Icon name="help-circle" className="size-4" aria-hidden="true" />
      {t.dashboard.nav.support}
    </Link>
  );
}
