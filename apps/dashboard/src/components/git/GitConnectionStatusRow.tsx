import { Icon, type IconName } from "@repo/ui/icons";
import type { ReactNode } from "react";
import type { GitProviderDefinition } from "@repo/core";
import { AppLogo } from "@repo/ui/app-logo";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { UserAvatar } from "@/components/ui/UserAvatar";
import { Button } from "@/components/ui/button";

export function GitConnectionManageButton({
  expanded,
  onClick,
  label,
  compact = false,
}: {
  expanded: boolean;
  onClick(): void;
  label?: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Button
      type="button"
      variant="ghost"
      size={compact ? "icon" : "sm"}
      title={compact ? label ?? t.actions.completion.manageConnection : undefined}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <span className={compact ? "sr-only" : undefined}>{label ?? t.actions.completion.manageConnection}</span>
      <Icon
        name="chevron-down"
        aria-hidden="true"
        className={expanded ? "rotate-180" : undefined}
      />
    </Button>
  );
}

export function GitConnectionPrompt({
  provider,
  expanded,
  onConnect,
}: {
  provider: GitProviderDefinition;
  expanded: boolean;
  onConnect(): void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <GitConnectionStatusRow
        icon="git-branch"
        brand={provider.id}
        label={t.library.sidebar.notConnected}
        connected={false}
      />
      <Button type="button" size="sm" aria-expanded={expanded} onClick={onConnect}>
        {interpolate(t.projectSettings.git.connectFirst.connect, { provider: provider.name })}
      </Button>
    </div>
  );
}

interface Props {
  icon: IconName;
  label: string;
  sublabel?: string;
  login?: string | null;
  avatarUrl?: string | null;
  connected: boolean;
  optional?: boolean;
  status?: ReactNode;
  brand?: string;
}

export function GitConnectionStatusRow({
  icon,
  label,
  sublabel,
  login,
  avatarUrl,
  connected,
  optional,
  status,
  brand,
}: Props) {
  const { t } = useI18n();
  const title = login ? `@${login}` : label;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {login ? (
        <UserAvatar image={avatarUrl} name={login} className="size-10 bg-primary/10 text-primary" />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {brand ? (
            <AppLogo appId={brand} icon={icon} className="size-5" />
          ) : (
            <Icon
              name={icon}
              className={icon === "spinner" ? "size-5 motion-safe:animate-spin" : "size-5"}
              aria-hidden="true"
            />
          )}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 truncate text-sm font-semibold text-foreground" title={title}>
            {title}
          </p>
          {status}
        </div>
        {(login || sublabel || optional) && (
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            {login && <Icon name={icon} className="size-3.5 shrink-0" aria-hidden="true" />}
            {(login || sublabel) && <span className="truncate">{login ? label : sublabel}</span>}
            {optional && <span>({t.library.sidebar.optional})</span>}
          </div>
        )}
      </div>
      {status == null && connected && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-bg px-2 py-1 text-xs font-medium text-success">
            <Icon name="check" className="size-3.5" aria-hidden="true" />
            {t.library.sidebar.connected}
          </span>
      )}
    </div>
  );
}
