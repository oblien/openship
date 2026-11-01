"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { useAddServerModal } from "@/components/servers/add-server-modal";
import { Button } from "@/components/ui/button";
import { OptionCard } from "@/components/shared/OptionCard";

type SelectedServer = { id: string; name: string };
export function RunnerDestination({
  onCancel,
  renderForm,
}: {
  onCancel: () => void;
  renderForm: (server: SelectedServer | undefined, onBack?: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const c = t.actions.runnerSetup.destinations;
  const { selfHosted, cloudAuthUrl } = usePlatform();
  const [mode, setMode] = useState<"existing" | null>(null);
  const [server, setServer] = useState<SelectedServer>();
  const addServer = useAddServerModal({ initialMode: "managed" });
  if (!selfHosted) return renderForm(undefined);
  if (mode === "existing")
    return renderForm(server, () => {
      setServer(undefined);
      setMode(null);
    });
  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            {t.actions.newRunner}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{c.subtitle}</p>
        </div>
        <Button variant="ghost" onClick={onCancel}>
          {t.actions.cancel}
        </Button>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        <OptionCard
          value="existing"
          selected={false}
          onSelect={() => setMode("existing")}
          icon={<Icon name="server" className="size-5" />}
          label={c.existing}
          description={c.existingHint}
        />
        <OptionCard
          value="dedicated"
          selected={false}
          onSelect={() =>
            addServer((created) => {
              setServer({ id: created.id, name: created.name || created.sshHost || c.dedicated });
              setMode("existing");
            })
          }
          icon={<Icon name="plus" className="size-5" />}
          label={c.dedicated}
          description={c.dedicatedHint}
        />
      </div>
      {!mode && selfHosted && (
        <Button asChild variant="ghost" size="sm">
          <a
            href={`${cloudAuthUrl.replace(/\/$/, "")}/actions`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {c.openCloud}
            <Icon name="arrow-right" className="size-4 rtl:rotate-180" />
          </a>
        </Button>
      )}
    </div>
  );
}
