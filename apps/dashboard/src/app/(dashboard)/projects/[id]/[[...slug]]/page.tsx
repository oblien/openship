"use client";

import React from "react";
import {
  MoreVertical,
  HelpCircle,
  MessageSquare,
  Bug,
  BookOpen,
  ExternalLink,
  Rocket,
  ListTree,
  Trash2,
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
import { encodeRepoSlug } from "@/utils/repoSlug";

const ProjectSettingsContent = () => {
  const { projectData, projectNotFound, errorType, activeTab, setActiveTab, tabs, isLoadingAnalytics } = useProjectSettings();

  const { showToast } = useToast();
  const router = useRouter();

  const handleDeleteProject = async () => {
    const response = await projectsApi.delete(projectData.id);
    if (response.success) {
      showToast('Project deleted successfully', 'success');
      router.push('/');
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

  const isDraft = !isLoadingAnalytics && !projectData.activeDeploymentId;

  if (isDraft && (activeTab === "general" || activeTab === "error")) {
    const deploySlug = projectData.gitOwner && projectData.gitRepo
      ? encodeRepoSlug(projectData.gitOwner, projectData.gitRepo)
      : null;

    return (
      <div className="min-h-screen bg-[#fafafa] pb-32">
        <SectionContainer>
          <div className="py-20 text-center">
            {/* SVG Illustration */}
            <div className="relative mx-auto w-72 h-48 mb-10">
              <svg className="absolute inset-0 w-full h-full" viewBox="0 0 290 200" fill="none">
                {/* Background card stack */}
                <rect x="80" y="50" width="140" height="100" rx="14" fill="var(--th-sf-04)" />
                <rect x="70" y="40" width="140" height="100" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
                <rect x="60" y="30" width="140" height="100" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />

                {/* Card header bar */}
                <rect x="60" y="30" width="140" height="28" rx="14" fill="var(--th-sf-05)" />
                <circle cx="78" cy="44" r="4" fill="#ef4444" fillOpacity="0.6" />
                <circle cx="90" cy="44" r="4" fill="#eab308" fillOpacity="0.6" />
                <circle cx="102" cy="44" r="4" fill="#22c55e" fillOpacity="0.6" />

                {/* Content placeholder lines */}
                <rect x="76" y="70" width="55" height="5" rx="2.5" fill="var(--th-on-12)" />
                <rect x="76" y="82" width="90" height="4" rx="2" fill="var(--th-on-08)" />
                <rect x="76" y="92" width="70" height="4" rx="2" fill="var(--th-on-08)" />

                {/* Rocket icon */}
                <circle cx="230" cy="80" r="24" fill="var(--th-on-05)" />
                <circle cx="230" cy="80" r="17" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
                <path d="M230 72v6m0 4v6" stroke="var(--th-on-30)" strokeWidth="2" strokeLinecap="round" />
                <path d="M226 78l4-6 4 6" stroke="var(--th-on-30)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

                {/* Paused / waiting indicator - clock */}
                <circle cx="110" cy="110" r="9" fill="var(--th-on-08)" />
                <circle cx="110" cy="110" r="6" fill="var(--th-card-bg)" />
                <path d="M110 107v3l2 2" stroke="var(--th-on-30)" strokeWidth="1.2" strokeLinecap="round" />

                {/* Decorative dots */}
                <circle cx="35" cy="65" r="4" fill="var(--th-on-10)" />
                <circle cx="45" cy="155" r="6" fill="var(--th-on-08)" />
                <circle cx="255" cy="45" r="3" fill="var(--th-on-12)" />
                <circle cx="265" cy="145" r="5" fill="var(--th-on-06)" />

                {/* Sparkle accents */}
                <path d="M30 110l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
                <path d="M250 165l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />

                {/* Dashed connection line */}
                <path d="M200 95 Q 210 88 213 83" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
              </svg>
            </div>

            {/* Draft Badge */}
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-700 mb-4">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              Draft
            </span>

            <h2 className="text-2xl font-semibold text-foreground/80 mb-2" style={{ letterSpacing: "-0.2px" }}>
              {projectData.name || "Untitled Project"}
            </h2>
            <p className="text-sm text-muted-foreground/70 max-w-md mx-auto mb-10 leading-relaxed">
              This project hasn&apos;t been deployed yet. Configure your build settings and deploy, or view past deployment attempts.
            </p>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-6">
              <Link
                href={deploySlug ? `/deploy/${deploySlug}` : "/library"}
                className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
              >
                <Rocket className="size-4" />
                Configure &amp; Deploy
              </Link>
              <button
                onClick={() => {
                  setActiveTab("deployments");
                  window.history.replaceState({}, '', `/projects/${projectData.id}/deployments`);
                }}
                className="inline-flex items-center gap-2 px-6 py-3 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
              >
                <ListTree className="size-4" />
                See Deployments
              </button>
            </div>

            <button
              onClick={handleDeleteProject}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-red-600 hover:text-red-700 hover:bg-red-50 rounded-lg transition-colors"
            >
              <Trash2 className="size-3.5" />
              Delete Project
            </button>
          </div>
        </SectionContainer>
      </div>
    );
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