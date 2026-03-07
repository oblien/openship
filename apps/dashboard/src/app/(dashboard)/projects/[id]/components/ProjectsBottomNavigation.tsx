"use client";

import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { generateIcon } from "@/utils/icons";
import { useEffect } from "react";

export const ProjectsBottomNavigation = () => {

    const {
        projectNotFound,
        activeTab,
        tabs,
        setActiveTab,
        projectData
    } = useProjectSettings();

    // Validate active tab in useEffect to avoid setState during render
    useEffect(() => {
        if(!tabs.some((tab) => tab.id === activeTab)) {
            setActiveTab(tabs[0].id);
        }
    }, [tabs, activeTab, setActiveTab]);

    const handleTabChange = (tabId: string) => {
        setActiveTab(tabId);
        window.history.replaceState({}, '', `/projects/${projectData.id}/${tabId}`);
    };

    if(!projectData.id) {
        return null;
    }

    return (
        <div>
            {/* Fixed Bottom Navigation - Hide when project not found */}
            {!projectNotFound && (
                <div className="fixed bottom-0 left-0 right-0 z-50">
                    <div className="w-[95vw] mx-auto lg:max-w-[calc(100vw-20vw)] lg:ml-auto lg:mr-0 flex justify-center">
                        <div className="flex items-center justify-center gap-2 p-2 mb-6 bg-black overflow-x-auto backdrop-blur-sm rounded-full">
                            {tabs.map((tab) => {
                                const isActive = activeTab === tab.id;
                                return (
                                    <button
                                        key={tab.id}
                                        onClick={() => handleTabChange(tab.id)}
                                        className={`flex items-center gap-2 px-4 lg:px-5 py-2.5 lg:py-2 rounded-full font-normal text-base transition-all duration-300 whitespace-nowrap ${isActive ? 'bg-white text-black shadow-lg': 'bg-black text-white'}`}
                                    >
                                        <span className="lg:hidden">{generateIcon(tab.icon, 22, isActive ? 'black' : 'white')}</span>
                                        <span className="hidden lg:inline">{generateIcon(tab.icon, 20, isActive ? 'black' : 'white')}</span>
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