"use client";

import Link from "next/link";
import { ArrowRight, GitBranch, Zap } from "lucide-react";

import { useGitHub } from "@/context/GitHubContext";

interface HomeTipCardProps {
  projectCount: number;
  loading: boolean;
}

interface HomeTip {
  text: string;
  href: string;
  label: string;
}

function getHomeTips(params: {
  connected: boolean;
  loading: boolean;
  projectCount: number;
}): HomeTip[] {
  const tips: HomeTip[] = [];

  if (!params.connected) {
    tips.push({
      text: "Connect your GitHub repository for automatic deployments on every push.",
      href: "/settings/git",
      label: "Connect GitHub",
    });
  }

  if (!params.loading && params.projectCount === 0) {
    tips.push({
      text: "Create your first project to start deploying.",
      href: "/new",
      label: "New Project",
    });
  }

  if (params.connected && params.projectCount > 0) {
    tips.push({
      text: "Set up environment variables and custom domains in project settings.",
      href: "/settings",
      label: "Project Settings",
    });
  }

  return tips;
}

export default function HomeTipCard({ projectCount, loading }: HomeTipCardProps) {
  const gitHub = useGitHub();
  const tip = getHomeTips({
    connected: gitHub.connected,
    loading: loading || gitHub.loading,
    projectCount,
  })[0];

  if (tip) {
    return (
      <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="size-4 text-primary" />
          <h3 className="font-semibold text-foreground text-sm">Quick Tip</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">{tip.text}</p>
        <Link
          href={tip.href}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80 mt-3 transition-colors"
        >
          {tip.label}
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <div className="bg-gradient-to-br from-primary/5 via-primary/3 to-transparent rounded-2xl border border-primary/10 p-5">
      <div className="flex items-center gap-2 mb-3">
        <GitBranch className="size-4 text-primary" />
        <h3 className="font-semibold text-foreground text-sm">GitHub</h3>
      </div>
      <div className="flex items-center gap-3">
        {gitHub.accounts[0]?.avatar_url && (
          <img
            src={gitHub.accounts[0].avatar_url}
            alt={gitHub.userLogin}
            className="size-8 rounded-full"
          />
        )}
        <div>
          <p className="text-sm font-medium text-foreground">{gitHub.userLogin}</p>
          <p className="text-xs text-muted-foreground">Connected</p>
        </div>
      </div>
    </div>
  );
}