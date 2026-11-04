"use client";

import { useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useUpdates } from "@/components/updates/useUpdates";
import { RuntimeSecurityDialog } from "@/components/updates/RuntimeSecurityDialog";
import { SettingsSection } from "./SettingsSection";
import { SettingsToggleRow } from "./SettingsToggleRow";
import { useSecurityBannerPreference } from "@/components/updates/useSecurityBannerPreference";
import { useScopedResource, useScopedMutation } from "@/hooks/use-scoped-resource";
import { updatesApi } from "@/lib/api/updates";

/** Keep inspection and consent reachable after a notice is dismissed or resolved. */
export function SecurityAdvisorySettings() {
  const { t } = useI18n();
  const copy = t.projectSettings.securityAdvisories;
  const { securityOverview, refresh } = useUpdates();
  const [open, setOpen] = useState(false);
  const banners = useSecurityBannerPreference();
  const policy = useScopedResource(updatesApi.securityCheckPolicy);
  const mutation = useScopedMutation();
  const checksEnabled = policy.data?.data.checksEnabled ?? securityOverview.checksEnabled !== false;
  return (
    <SettingsSection icon="shield-check" title={copy.title} description={copy.notifications}>
      <div className="mb-4 space-y-4">
        <SettingsToggleRow
          checked={checksEnabled}
          disabled={policy.loading || !policy.data?.data.canManage || mutation.busy}
          onChange={(enabled) =>
            void mutation.execute(async () => {
              await updatesApi.setSecurityCheckPolicy(enabled);
              policy.refresh();
              refresh();
            })
          }
          label={copy.checksEnabled}
          description={copy.checksDescription}
        />
        {(policy.error || mutation.error) && (
          <div role="alert" className="text-sm text-danger">
            <p>{policy.error || mutation.error}</p>
            {policy.error && (
              <Button variant="ghost" size="sm" onClick={policy.refresh}>
                {copy.retrySettings}
              </Button>
            )}
          </div>
        )}
        <SettingsToggleRow
          checked={banners.enabled}
          onChange={banners.setEnabled}
          label={copy.showBanners}
          description={copy.bannerDescription}
        />
      </div>
      <Button
        variant="secondary"
        disabled={!checksEnabled || !securityOverview.projects.length}
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
