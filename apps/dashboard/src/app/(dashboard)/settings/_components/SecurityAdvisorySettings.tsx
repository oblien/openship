"use client";

import { useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useUpdates } from "@/components/updates/useUpdates";
import { RuntimeSecurityDialog } from "@/components/updates/RuntimeSecurityDialog";
import { SettingsSection } from "./SettingsSection";

/** Keep inspection and consent reachable after a notice is dismissed or resolved. */
export function SecurityAdvisorySettings() {
  const { t } = useI18n();
  const copy = t.projectSettings.securityAdvisories;
  const { securityOverview, refresh } = useUpdates();
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection icon="shield-check" title={copy.title} description={copy.notifications}>
      <p className="mb-4 text-sm text-muted-foreground">{copy.automaticDescription}</p>
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
