"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useRef } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Tabs, type TabDef } from "@/components/ui/Tabs";

export type MonitoringTab = "open" | "health" | "resolved";

export function MonitoringNavigation({
  value,
  onChange,
  selfHosted,
}: {
  value: MonitoringTab;
  onChange: (tab: MonitoringTab) => void;
  selfHosted: boolean;
}) {
  const { t, dir } = useI18n();
  const c = t.issues;
  const navigation = useRef<HTMLDivElement>(null);
  const tabs: TabDef<MonitoringTab>[] = [
    { key: "open", label: c.tabs.open },
    { key: "health", label: c.tabs.health, hidden: !selfHosted },
    { key: "resolved", label: c.tabs.resolved },
  ];

  return (
    <div ref={navigation} dir={dir} className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 sm:border-b sm:border-border/50">
      <Tabs
        tabs={tabs}
        value={value}
        onChange={onChange}
        idPrefix="monitoring"
        ariaLabel={c.title}
        className="min-w-0 sm:flex-1 sm:border-b-0"
      />
      {selfHosted && value === "open" && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start sm:shrink-0 sm:self-auto"
          title={c.monitoringHint.description}
          onClick={() => {
            onChange("health");
            navigation.current?.querySelector<HTMLButtonElement>("#monitoring-tab-health")?.focus();
          }}
        >
          <UiIcon name="activity" aria-hidden="true" />
          {c.monitoringHint.action}
          <UiIcon name="arrow-right" aria-hidden="true" className="rtl:rotate-180" />
        </Button>
      )}
    </div>
  );
}
