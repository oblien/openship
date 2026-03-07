"use client";

import React from "react";
import {
  MoreVertical,
  HelpCircle,
  MessageSquare,
  Bug,
  BookOpen,
  ExternalLink,
} from "lucide-react";

import { GeneralSettings } from "../components/GeneralSettings";
import { DomainSettings } from "../components/DomainSettings";
import { GitSettings } from "../components/GitSettings";
import { BuildSettings } from "../components/BuildSettings";
import { LogsSettings } from "../components/LogsSettings";
import { Deployments } from "../components/Deployments";
import { AdvancedSettings } from "../components/AdvancedSettings";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/context/ToastContext";
import { projectsApi } from "@/lib/api";
import ErrorState from "@/components/shared/ErrorState";
import { ProductionUrlSkeleton, ProjectIdentitySkeleton, ProjectInfoSkeleton, StatsCardsSkeleton, TopPathsSkeleton, TrafficChartSkeleton } from "../components/general";
import { SectionContainer } from "@/components/ui/SectionContainer";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";

const ProjectSettingsContent = () => {
  const { projectData, projectNotFound, errorType, activeTab, tabs, isLoadingAnalytics } = useProjectSettings();

  const { showToast } = useToast();
  const router = useRouter();

  const handleDeleteProject = async () => {
    const response = await projectsApi.delete(projectData.id);
    if (response.success) {
      showToast('Project deleted successfully', 'success');
      router.push('/dashboard');
    } else {
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
      case "general":
        return <GeneralSettings />;
      case "domains":
        return <DomainSettings />;
      case "deployments":
        return <Deployments />;
      case "git":
        return <GitSettings />;
      case "settings":
        return <BuildSettings />;
      case "logs":
        return <LogsSettings />;
      case "advanced":
        return <AdvancedSettings onDeleteProject={handleDeleteProject} />;
      default:
        return <GeneralSettings />;
    }
  };

  if (projectNotFound) {
    return <ErrorState type={errorType || 'project-not-found'} />;
  }


  if (isLoadingAnalytics) {
    return (
      <SectionContainer>
        {/* Main Grid Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Left Column - 2 cols */}
          <div className="lg:col-span-2 space-y-5">
            <TrafficChartSkeleton />
            <StatsCardsSkeleton />
            <ProjectIdentitySkeleton />
          </div>

          {/* Right Column - 1 col */}
          <div className="space-y-5">
            <TopPathsSkeleton />
            <ProductionUrlSkeleton />
            <ProjectInfoSkeleton />
          </div>
        </div>
      </SectionContainer>
    );
  }
  return (
    <div className="min-h-screen bg-[#fafafa] pb-32">
      <SectionContainer>
        {/* Compact Header - Hide when project not found */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center space-x-2 text-sm text-black/40 mb-2">
              <Link href="/" className="hover:text-black transition-colors font-medium">
                Dashboard
              </Link>
              <span>/</span>
              <Link href={`/projects/${projectData.id || 'projectId'}`} className="hover:text-black transition-colors font-medium">
                {projectData.custom_domain || projectData.domain || projectData.name || 'Project'}
              </Link>
              <span>/</span>
              <span className="text-black font-medium">Settings</span>
            </div>
            <h1 className="text-2xl font-semibold text-black">
              {tabs.find(t => t.id === activeTab)?.label}
            </h1>
          </div>

          {/* Help & Share Menu */}
          <DropdownMenu
            actions={helpMenuActions}
            trigger={<MoreVertical className="w-5 h-5 text-gray-600" />}
            align="right"
          />
        </div>

        {/* Content */}
        {renderTabContent()}
      </SectionContainer>

    </div>
  );
};

export default ProjectSettingsContent;