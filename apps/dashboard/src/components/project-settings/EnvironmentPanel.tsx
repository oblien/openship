"use client";

import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";

/** Shared saved-environment surface. Hosts supply scope, persistence and runtime actions. */
export function EnvironmentPanel({
  actions,
  description,
  children,
  editor,
}: {
  actions: ReactNode;
  description: string;
  children?: ReactNode;
  editor?: ComponentProps<typeof EnvironmentVariables>;
}) {
  const { t } = useI18n();
  const helpId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpTitle = t.projectDetail.services.detail.environmentState.helpTitle;
  return (
    <section className="min-w-0 rounded-2xl bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/50 px-5 py-3">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium text-foreground">
            {t.importProject.environmentVariables.title}
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={helpTitle}
            title={helpTitle}
            aria-expanded={helpOpen}
            aria-controls={helpId}
            onClick={() => setHelpOpen((open) => !open)}
          >
            <Icon name="info" className="size-4" />
          </Button>
        </div>
        <div className="ms-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      </div>
      <div className="space-y-2 px-5 pt-4 text-xs text-muted-foreground">
        <p id={helpId} hidden={!helpOpen}>
          {description}
        </p>
        {children}
      </div>
      {editor && (
        <fieldset disabled={editor.isSaving} className="min-w-0">
          <EnvironmentVariables
            {...editor}
            mode="settings"
            hideTitle
            borderless
            showSecretToggle
            showSettingsActions={false}
          />
        </fieldset>
      )}
    </section>
  );
}
