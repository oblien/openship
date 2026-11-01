"use client";

import { AppSettingsTab } from "./AppSettingsTab";
import { BuildSettings } from "./BuildSettings";

/**
 * Curated app fields and shared project controls form one Settings page.
 * Service configuration lives in the project's Apps & Services page.
 */
export function AppConfiguration() {
  return (
    <>
      <AppSettingsTab />
      <BuildSettings />
    </>
  );
}
