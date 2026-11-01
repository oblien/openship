"use client";

import { Tabs } from "@/components/ui/Tabs";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useProjectTabNavigation } from "@/hooks/useProjectTabNavigation";

/** Group existing project screens without duplicating their content or routes. */
export function ProjectTabSections() {
  const { projectData, tabs, activeTab, activeTabGroup } = useProjectSettings();
  const navigate = useProjectTabNavigation();
  const group = tabs.find((tab) => tab.id === activeTabGroup);

  if (!group?.sections) return null;

  return (
    <nav aria-label={group.label}>
      <Tabs
        tabs={group.sections.map((section) => ({
          key: section.id,
          label: section.label,
          href: `/projects/${projectData.id}/${section.id}`,
        }))}
        value={activeTab}
        onChange={navigate}
      />
    </nav>
  );
}
