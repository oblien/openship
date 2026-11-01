"use client";

import { useEffect } from "react";
import { reportCaughtError } from "@repo/core/diagnostics";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/components/i18n-provider";
import { settingsApi } from "@/lib/api/settings";

// Serialize preference changes so a slow earlier request cannot replace the latest language.
let pending = Promise.resolve();
const saved = new Map<string, string>();

export function LocalePreferenceSync() {
  const { user, isLoading } = useAuth();
  const { locale } = useI18n();
  useEffect(() => {
    if (!user || isLoading || saved.get(user.id) === locale) return;
    let active = true;
    pending = pending
      .then(async () => {
        if (!active || saved.get(user.id) === locale) return;
        await settingsApi.setLocale(locale);
        saved.set(user.id, locale);
      })
      .catch((error) => reportCaughtError(error, "dashboard/locale-preference-sync"));
    return () => {
      active = false;
    };
  }, [user?.id, isLoading, locale]);
  return null;
}
