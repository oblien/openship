"use client";

import type { ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { useI18n } from "@/components/i18n-provider";

export type WorkloadTab =
  | "overview"
  | "env"
  | "logs"
  | "terminal"
  | "domains"
  | "volumes"
  | "backup"
  | "settings";
export const WORKLOAD_TABS: WorkloadTab[] = [
  "overview",
  "env",
  "logs",
  "terminal",
  "domains",
  "volumes",
  "backup",
  "settings",
];
export interface WorkloadChoice {
  id: string;
  name: string;
  icon: ReactNode;
}

/** Shared identity, switcher, actions and tab layout. Controllers own capabilities. */
export function WorkloadDetailHeader({
  id,
  name,
  icon,
  status,
  choices,
  onSwitch,
  onBack,
  actions,
  notice,
  tabs,
  value,
  onChange,
  busy,
}: {
  id: string;
  name: string;
  icon: ReactNode;
  status: ReactNode;
  choices: WorkloadChoice[];
  onSwitch: (id: string) => void;
  onBack?: () => void;
  actions?: ReactNode;
  notice?: ReactNode;
  tabs: TabDef<WorkloadTab>[];
  value: WorkloadTab;
  onChange: (tab: WorkloadTab) => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const identity = (
    <>
      {icon}
      <span className="truncate" title={name}>
        {name}
      </span>
    </>
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-2">
          {onBack && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onBack}
              disabled={busy}
              title={t.projectDetail.services.addModal.allServices}
              className="shrink-0"
            >
              <Icon name="arrow-left" className="size-4 rtl:rotate-180" />
              <span className="sr-only">{t.projectDetail.services.addModal.allServices}</span>
            </Button>
          )}
          <div className="@container min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2.5">
              {choices.length > 1 ? (
                <>
                  <h2 className="sr-only">{name}</h2>
                  <DropdownMenu
                    align="left"
                    className="min-w-0"
                    menuClassName="w-[min(18rem,100cqw)] min-w-0"
                    triggerClassName="group flex h-9 w-full items-center gap-2 rounded-lg text-base font-medium text-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                    trigger={
                      <>
                        {identity}
                        <Icon
                          name="chevron-down"
                          className="size-3 shrink-0 text-muted-foreground"
                        />
                      </>
                    }
                    actions={choices.map((choice) => ({
                      id: choice.id,
                      label: choice.name,
                      icon: choice.icon,
                      disabled: busy || choice.id === id,
                      onClick: () => onSwitch(choice.id),
                    }))}
                  />
                </>
              ) : (
                <h2 className="flex h-9 min-w-0 items-center gap-2 text-base font-medium text-foreground">
                  {identity}
                </h2>
              )}
              <div className="shrink-0">{status}</div>
            </div>
          </div>
        </div>
        <div className="ms-auto flex max-w-full flex-wrap items-center gap-2">{actions}</div>
      </div>
      {notice}
      <Tabs
        className="border-b-0"
        size="md"
        fullWidth
        tabs={tabs}
        value={value}
        onChange={onChange}
      />
    </>
  );
}
