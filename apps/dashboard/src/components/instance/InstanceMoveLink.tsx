"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button, type ButtonProps } from "@/components/ui/button";

export const INSTANCE_MOVE_HREF = "/settings?tab=instance&move=1";

/** Feature prerequisites enter the same reviewed instance move, never a second wizard. */
export function InstanceMoveLink({ variant = "secondary" }: Pick<ButtonProps, "variant">) {
  const { t } = useI18n();
  return (
    <Button asChild size="sm" variant={variant}>
      <Link href={INSTANCE_MOVE_HREF}>
        {t.settings.instance.location.moveToServer}
        <Icon name="arrow-right" className="rtl:rotate-180" />
      </Link>
    </Button>
  );
}
