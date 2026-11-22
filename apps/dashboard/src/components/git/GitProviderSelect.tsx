"use client";

import { AppLogo } from "@repo/ui/app-logo";
import type { IconName } from "@repo/ui/icons";
import { useGit } from "@/context/GitContext";
import { useI18n } from "@/components/i18n-provider";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Tabs } from "@/components/ui/Tabs";

export function GitProviderSelect({ segmented = false }: { segmented?: boolean }) {
  const { connections, definition, selectProvider } = useGit();
  return (
    <GitProviderChoices
      providers={connections.map(({ definition, icon }) => ({
        id: definition.id,
        name: definition.name,
        icon,
      }))}
      value={definition.id}
      onChange={selectProvider}
      segmented={segmented}
    />
  );
}

/** Settings selects a URL. Repository browsers select a live connection. */
export function GitProviderChoices({
  providers,
  value,
  onChange,
  segmented = false,
  idPrefix,
}: {
  providers: readonly { id: string; name: string; icon: IconName }[];
  value: string;
  onChange(provider: string): void;
  segmented?: boolean;
  idPrefix?: string;
}) {
  const { t } = useI18n();
  if (providers.length < 2) return null;
  const options = providers.map(({ id, name, icon }) => ({
    value: id,
    label: name,
    icon: <AppLogo appId={id} icon={icon} className="size-4 shrink-0" />,
  }));

  if (segmented)
    return (
      <Tabs
        tabs={options.map(({ value: key, label, icon }) => ({ key, label, leading: icon }))}
        value={value}
        onChange={onChange}
        idPrefix={idPrefix}
        ariaLabel={t.library.sidebar.connection}
        variant="pills"
        className="w-fit max-w-full rounded-2xl bg-muted/45 p-1"
      />
    );

  return (
    <CustomSelect
      aria-label={t.library.sidebar.connection}
      value={value}
      onChange={onChange}
      options={options}
      variant="filled"
      className="mb-3"
      triggerClassName="bg-muted/60 font-medium hover:bg-muted"
    />
  );
}
