"use client";

import { Icon } from "@repo/ui/icons";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useI18n } from "@/components/i18n-provider";
import type { useRuntimeUpdate } from "@/hooks/useRuntimeUpdate";

/** Reuse the same image actions in Redeploy dropdowns and service context menus. */
export function useRuntimeRedeployActions(
  runtime: ReturnType<typeof useRuntimeUpdate>,
  disabled = false,
): MenuAction[] {
  const { t } = useI18n();
  const copy = t.projectSettings.runtimeUpdates;
  const busy = disabled || runtime.updating || runtime.checking;
  return [
    {
      id: "refresh-runtime",
      label: copy.refresh,
      icon: <Icon name="refresh" className="size-4" />,
      disabled: busy,
      onClick: () => void runtime.update(),
    },
    {
      id: "check-runtime",
      label: copy.check,
      icon: <Icon name="search" className="size-4" />,
      disabled: busy,
      onClick: () => void runtime.checkUpdates(),
    },
  ];
}

/** The same image refresh and check actions beside project and service Redeploy. */
export function RuntimeRedeployMenu({
  runtime,
  disabled,
  supported = true,
  actions = [],
  size = "sm",
}: {
  runtime: ReturnType<typeof useRuntimeUpdate>;
  disabled?: boolean;
  supported?: boolean;
  actions?: MenuAction[];
  size?: "sm" | "default";
}) {
  const { t } = useI18n();
  const copy = t.projectSettings.runtimeUpdates;
  const runtimeActions = useRuntimeRedeployActions(runtime, disabled);
  return (
    <DropdownMenu
      align="right"
      disabled={disabled || runtime.updating || runtime.checking}
      triggerLabel={copy.options}
      menuClassName="w-[min(24rem,calc(100vw-2rem))] min-w-0 [&_button>span]:whitespace-normal"
      triggerClassName={`inline-flex ${size === "sm" ? "h-9" : "h-10"} items-center justify-center rounded-xl bg-muted px-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50`}
      trigger={
        <Icon
          name={runtime.updating || runtime.checking ? "refresh" : "chevron-down"}
          className={`size-4 ${runtime.updating || runtime.checking ? "animate-spin" : ""}`}
        />
      }
      actions={[...(supported ? runtimeActions : []), ...actions]}
    />
  );
}
