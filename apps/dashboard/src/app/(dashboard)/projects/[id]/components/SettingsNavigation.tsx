import React from "react";

export const SettingsNavigation = ({ tabs, activeTab, onTabChange }: any) => (
  <div className="w-64 flex-shrink-0 border-r border-border">
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
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
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
