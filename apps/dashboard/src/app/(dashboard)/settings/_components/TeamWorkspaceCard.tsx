"use client";

/**
 * Entry point to the team-mode migration wizard.
 *
 * Shown in the Team settings tab when the local instance is still
 * single_user. Owner-only — non-owners shouldn't see "move the whole
 * deployment" as an option in their sidebar.
 *
 * Once migrated, the dashboard renders `<MigratedLauncher />` in place
 * of the normal layout, so this card is naturally invisible to the
 * operator from then on.
 */

import { useState } from "react";
import { Rocket, Loader2 } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import { MigrateModal } from "./MigrateModal";
import { useI18n } from "@/components/i18n-provider";

export function TeamWorkspaceCard({ canMigrate }: { canMigrate: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [migrated, setMigrated] = useState(false);

  return (
    <SettingsSection
      icon={Rocket}
      title={t.settings.teamWorkspace.title}
      description={t.settings.teamWorkspace.description}
      iconBg="bg-primary/10"
      iconColor="text-primary"
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">
          {t.settings.teamWorkspace.body}
        </p>

        <div className="flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/[0.04] p-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{t.settings.teamWorkspace.currentMode}</p>
            <p className="text-xs text-muted-foreground">{t.settings.teamWorkspace.singleUserLocal}</p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={!canMigrate}
            title={canMigrate ? undefined : t.settings.teamWorkspace.ownerOnlyTitle}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {migrated && <Loader2 className="size-4 animate-spin" />}
            {t.settings.teamWorkspace.migrate}
          </button>
        </div>

        <p className="text-xs text-muted-foreground">{t.settings.teamWorkspace.comingSoon}</p>
      </div>

      <MigrateModal
        open={open}
        onClose={() => setOpen(false)}
        onMigrated={() => {
          // The dashboard's launcher is gated on /api/health/env which
          // now returns teamMode != single_user. Force a hard reload so
          // PlatformContext re-reads and the launcher takes over.
          setMigrated(true);
          if (typeof window !== "undefined") {
            window.location.reload();
          }
        }}
      />
    </SettingsSection>
  );
}
