"use client";

import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

export function WorkflowExpandButton({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <Button size="sm" variant="ghost" onClick={onClick}>
      <Icon name={expanded ? "chevron-up" : "chevron-down"} />
      {expanded ? t.actions.editor.collapseAll : t.actions.editor.expandAll}
    </Button>
  );
}
