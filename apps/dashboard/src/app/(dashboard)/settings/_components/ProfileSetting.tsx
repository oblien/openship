"use client";

import { useAuth } from "@/context/AuthContext";
import { authClient } from "@/lib/auth-client";
import { useI18n } from "@/components/i18n-provider";
import { ImageUrlEditor } from "@/components/settings/ImageUrlEditor";
import { SettingsSection } from "./SettingsSection";

export function ProfileSetting() {
  const { user } = useAuth();
  const { t } = useI18n();
  const c = t.settings.profile;
  if (!user) return null;
  return (
    <SettingsSection icon="user" title={c.title} description={c.description}>
      <ImageUrlEditor
        value={user.image}
        editLabel={c.change}
        label={c.label}
        hint={c.hint}
        resetLabel={c.reset}
        fallback={(user.name || user.email)[0]}
        onSave={async (image) => {
          const result = await authClient.updateUser({ image });
          if (result.error) throw new Error(result.error.message || t.settings.imageUrl.failed);
        }}
      />
    </SettingsSection>
  );
}
