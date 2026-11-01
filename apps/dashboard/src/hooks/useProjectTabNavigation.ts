"use client";

import { useProjectSettings } from "@/context/ProjectSettingsContext";

/** Shared by the project sidebar, mobile navigation, and section switcher. */
export function useProjectTabNavigation() {
  const { projectData, setActiveTab } = useProjectSettings();

  return (tabId: string) => {
    const scrollY = window.scrollY;
    setActiveTab(tabId);
    window.history.replaceState({}, "", `/projects/${projectData.id}/${tabId}`);
    requestAnimationFrame(() => window.scrollTo(0, scrollY));
  };
}
