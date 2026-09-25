"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useProjectTabNavigation } from "@/hooks/useProjectTabNavigation";

import { useEffect } from "react";

export const ProjectsBottomNavigation = () => {

    const {
        projectNotFound,
        activeTabGroup,
        tabs,
        setActiveTab,
        projectData
    } = useProjectSettings();
    const handleTabChange = useProjectTabNavigation();

    // Validate active tab in useEffect to avoid setState during render
    useEffect(() => {
        if(!tabs.some((tab) => tab.id === activeTabGroup)) {
            setActiveTab(tabs[0].id);
        }
    }, [tabs, activeTabGroup, setActiveTab]);

    if(!projectData.id || !projectData.activeDeploymentId) {
        return null;
    }

    return (
        <div>
            {/* Fixed Bottom Navigation - Hide when project not found */}
            {!projectNotFound && (
                <div className="fixed bottom-0 start-0 end-0 z-50">
                    <div className="w-[95vw] mx-auto lg:max-w-[calc(100vw-20vw)] lg:ms-auto lg:me-0 flex justify-center">
                        <div className="flex items-center justify-center gap-2 p-2 mb-6 bg-foreground overflow-x-auto backdrop-blur-sm rounded-full">
                            {tabs.map((tab) => {
                                const isActive = activeTabGroup === tab.id;
                                return (
                                    <button
                                        key={tab.id}
                                        onClick={() => handleTabChange(tab.id)}
                                        className={`flex items-center gap-2 px-4 lg:px-5 py-2.5 lg:py-2 rounded-full font-normal text-base transition-all duration-300 whitespace-nowrap ${isActive ? 'bg-background text-foreground shadow-lg': 'text-background'}`}
                                    >
                                        <span className="lg:hidden"><UiIcon name={tab.icon} size={22} /></span>
                                        <span className="hidden lg:inline"><UiIcon name={tab.icon} size={20} /></span>
                                        <span className="hidden sm:inline">{tab.label}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ProjectsBottomNavigation;
