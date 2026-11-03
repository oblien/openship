"use client";

import { useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useUpdates } from "@/components/updates/useUpdates";
import { RuntimeSecurityDialog } from "@/components/updates/RuntimeSecurityDialog";
import { SettingsSection } from "./SettingsSection";
import { SettingsToggleRow } from "./SettingsToggleRow";
import { useSecurityBannerPreference } from "@/components/updates/useSecurityBannerPreference";

/** Keep inspection and consent reachable after a notice is dismissed or resolved. */
export function SecurityAdvisorySettings() {
  const { t } = useI18n();
  const copy = t.projectSettings.securityAdvisories;
  const { securityOverview, refresh } = useUpdates();
  const [open, setOpen] = useState(false);
  const banners = useSecurityBannerPreference();
  return (
    <SettingsSection icon="shield-check" title={copy.title} description={copy.notifications}>
      <div className="mb-4">
        <SettingsToggleRow
          checked={banners.enabled}
          onChange={banners.setEnabled}
          label={copy.showBanners}
          description={copy.bannerDescription}
        />
      </div>
      <Button
        variant="secondary"
        disabled={!securityOverview.projects.length}
        onClick={() => setOpen(true)}
      >
        {copy.title}
      </Button>
      {open && (
        <RuntimeSecurityDialog
          overview={securityOverview}
          onClose={() => setOpen(false)}
          onChecked={refresh}
        />
      )}
    </SettingsSection>
  );
}
