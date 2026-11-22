import type { ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export function RepositoryConnectState({
  provider,
  header,
  description,
  children,
  onBrowseApps,
  stackActions = false,
  footer,
}: {
  provider: string;
  header?: ReactNode;
  description: ReactNode;
  children: ReactNode;
  onBrowseApps(): void;
  stackActions?: boolean;
  footer?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl border border-border/50 bg-card">
      {header}
      <div className="px-6 py-10 text-center">
        <FeatureIllustration
          name="git-authentication"
          className="illustration-color mx-auto mb-6 h-auto w-20"
        />
        <h3 className="mb-1.5 text-lg font-medium text-foreground/85">
          {interpolate(t.library.connect.default.title, { provider })}
        </h3>
        <p className="mx-auto mb-7 max-w-md text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
        <div
          className={`flex items-center justify-center gap-3 ${stackActions ? "flex-col" : "flex-wrap"}`}
        >
          {children}
          <Button type="button" variant="secondary" onClick={onBrowseApps} className="h-11 px-6">
            <Icon name="grid" className="size-4" aria-hidden="true" />
            {t.library.connect.deployApp}
          </Button>
        </div>
        {footer && <div className="mt-7">{footer}</div>}
      </div>
    </div>
  );
}
