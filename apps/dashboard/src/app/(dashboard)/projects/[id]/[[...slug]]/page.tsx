"use client";

import {
  MoreVertical,
  HelpCircle,
  MessageSquare,
  Bug,
  BookOpen,
  ExternalLink,
} from "lucide-react";

import { DomainSettings } from "../components/DomainSettings";
import { GitSettings } from "../components/GitSettings";
import { BuildSettings } from "../components/BuildSettings";
import { LogsSettings } from "../components/LogsSettings";
import { Deployments } from "../components/Deployments";
import { AdvancedSettings } from "../components/AdvancedSettings";
import { OverviewTab } from "../components/OverviewTab";
import { MonitoringTab } from "../components/MonitoringTab";
import { ServicesTab } from "../components/ServicesTab";
import { ProjectSidebar, ProjectMobileTabs } from "../components/ProjectSidebar";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/context/ToastContext";
import { projectsApi } from "@/lib/api";
import ErrorState from "@/components/shared/ErrorState";
import { SectionContainer } from "@/components/ui/SectionContainer";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";

const ProjectSettingsContent = () => {
  const { projectData, setProjectData, projectNotFound, errorType, activeTab, setActiveTab, tabs, isLoadingAnalytics } = useProjectSettings();

  const isServicesProject = tabs[0]?.id === "services";

  const { showToast } = useToast();
  const router = useRouter();

  const handleDeleteProject = async () => {
    // Optimistic — immediately show "Deleting" status
    setProjectData((prev: any) => ({ ...prev, deletedAt: new Date().toISOString() }));

    const response = await projectsApi.delete(projectData.id);
    if (response.success) {
      showToast('Project deleted successfully', 'success');
      router.push('/');
    } else {
      // Revert on failure
      setProjectData((prev: any) => ({ ...prev, deletedAt: null }));
      showToast(response.message || response.error, 'error', 'Failed to delete project');
    }
  };

  const helpMenuActions: MenuAction[] = [
    {
      id: 'support',
      label: 'Contact Support',
      icon: <HelpCircle className="w-4 h-4" />,
      onClick: () => {
        window.open('https://oblien.com/support', '_blank');
      },
    },
    {
      id: 'report-issue',
      label: 'Report Issue',
      icon: <Bug className="w-4 h-4" />,
      onClick: () => {
        window.open('https://github.com/oblien/deployments/issues/new', '_blank');
      },
    },
    {
      id: 'feedback',
      label: 'Send Feedback',
      icon: <MessageSquare className="w-4 h-4" />,
      onClick: () => {
        window.open('https://oblien.com/feedback', '_blank');
      },
    },
    {
      id: 'divider',
      divider: true,
    },
    {
      id: 'documentation',
      label: 'Documentation',
      icon: <BookOpen className="w-4 h-4" />,
      onClick: () => {
        window.open('https://oblien.com/docs', '_blank');
      },
    },
    {
      id: 'community',
      label: 'Join Community',
      icon: <ExternalLink className="w-4 h-4" />,
      onClick: () => {
        window.open('https://discord.gg/oblien', '_blank');
      },
    },
  ];


  const renderTabContent = () => {
    switch (activeTab) {
      case "overview":
        return <OverviewTab />;
      case "monitoring":
        return <MonitoringTab />;
      case "services":
        return <ServicesTab />;
      case "domains":
        return <DomainSettings />;
      case "deployments":
        return <Deployments />;
      case "source":
      case "git":
        return <GitSettings />;
      case "runtime":
      case "settings":
        return <BuildSettings />;
      case "logs":
        return <LogsSettings />;
      case "advanced":
        return <AdvancedSettings onDeleteProject={handleDeleteProject} />;
      default:
        return isServicesProject ? <ServicesTab /> : <OverviewTab />;
    }
  };

  if (projectNotFound) {
    return <ErrorState type={errorType || 'project-not-found'} />;
  }

  if (isLoadingAnalytics) {
    return (
      <SectionContainer>
        <div className="space-y-5 py-6">
          {/* Skeleton cards */}
          <div className="bg-card rounded-2xl border border-border/50 p-6 animate-pulse">
            <div className="h-5 w-48 bg-muted rounded-lg mb-2" />
            <div className="h-4 w-32 bg-muted/60 rounded-lg" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-card rounded-2xl border border-border/50 p-5 animate-pulse">
                <div className="h-3 w-20 bg-muted rounded mb-4" />
                <div className="space-y-3">
                  {[1, 2, 3, 4].map((j) => (
                    <div key={j} className="flex justify-between">
                      <div className="h-3 w-16 bg-muted/60 rounded" />
                      <div className="h-3 w-24 bg-muted/60 rounded" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </SectionContainer>
    );
  }
  return (
    <div className="min-h-screen bg-background">
      <SectionContainer>
        {/* Compact Header */}
        <div className="mb-6">
          <div className="flex items-center space-x-2 text-sm text-muted-foreground mb-2">
            <Link href="/" className="hover:text-foreground transition-colors font-medium">
              Dashboard
            </Link>
            <span>/</span>
            <Link href={`/projects/${projectData.id || 'projectId'}/overview`} className="hover:text-foreground transition-colors font-medium">
              {projectData.name || 'Project'}
            </Link>
            {activeTab !== "overview" && (
              <>
                <span>/</span>
                <span className="text-foreground font-medium">
                  {tabs.find(t => t.id === activeTab)?.label}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold text-foreground truncate">
                {tabs.find(t => t.id === activeTab)?.label || "Overview"}
              </h1>
            </div>

            {/* Help & Share Menu */}
            <DropdownMenu
              actions={helpMenuActions}
              trigger={<MoreVertical className="w-5 h-5 text-muted-foreground" />}
              align="right"
            />
          </div>
        </div>

        {/* Content */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          {/* ── LEFT COLUMN ── */}
          <div className="space-y-6 min-w-0">
            <ProjectMobileTabs />
            {renderTabContent()}
          </div>

          {/* ── RIGHT COLUMN ── */}
          <div className="hidden lg:block">
            <ProjectSidebar />
          </div>
        </div>
      </SectionContainer>

    </div>
  );
};

export default ProjectSettingsContent;