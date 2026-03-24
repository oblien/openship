
import React from "react";
import { Activity, GitBranch, Calendar, Hash, Sparkles, Info } from "lucide-react";
import { generateIcon } from "@/utils/icons";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { formatDate } from "@/utils/date";
import { useToast } from "@/context/ToastContext";

export const ProjectInfo: React.FC = () => {
  const { projectData } = useProjectSettings();
  const { showToast } = useToast();
  const handleEditWithBlurs = () => {
    showToast('Editing with Blurs is not available yet', 'success', 'Coming Soon');
  };

  return (
    <>
      {/* Project Metadata - Compact */}
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-center gap-2 mb-4">
          {generateIcon('qr%20scan-120-1658435460.png', 24, 'hsl(var(--primary))')}
          <h3 className="text-base font-semibold text-foreground">Project Info</h3>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Project ID</p>
            <p className="text-xs text-foreground font-medium font-mono">{projectData.id?.substring(0, 8)}</p>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Branch</p>
            <p className="text-xs text-foreground font-medium">{projectData.branch || 'main'}</p>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Last Deploy</p>
            <p className="text-xs text-foreground font-medium">{formatDate(projectData.last_deployed)}</p>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">Framework</p>
            <p className="text-xs text-foreground font-medium">{projectData.framework || 'Unknown'}</p>
          </div>
        </div>
      </div>

      {/* AI Assistant - Simplified */}
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-center gap-2 mb-4">
          {generateIcon('star-103-1687505465.png', 24, 'hsl(var(--primary))')}
          <h3 className="text-base font-semibold text-foreground">AI Assistant</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">Powered by Blurs</p>
        <button onClick={handleEditWithBlurs} className="w-full px-4 py-2.5 bg-foreground text-background rounded-full font-medium text-sm hover:bg-foreground/90 transition-all hover:shadow-md flex items-center justify-center gap-2">
          <Sparkles className="w-4 h-4" />
          Edit with Blurs
        </button>
      </div>
    </>
  );
};
