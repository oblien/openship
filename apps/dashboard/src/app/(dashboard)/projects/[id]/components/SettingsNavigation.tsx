import React from "react";

export const SettingsNavigation = ({ tabs, activeTab, onTabChange }: any) => (
  <div className="w-64 flex-shrink-0 border-r border-zinc-800">
    <nav className="p-6">
      <div className="space-y-1">
        {tabs.map((tab: any) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={`w-full flex items-center px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                activeTab === tab.id
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-300"
              }`}
            >
              <Icon className="h-4 w-4 mr-3 flex-shrink-0" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  </div>
);
