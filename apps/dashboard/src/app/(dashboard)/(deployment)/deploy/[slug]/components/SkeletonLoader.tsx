"use client";

import { useEffect, useState } from "react";
import { PageContainer } from "@/components/ui/PageContainer";
import { useI18n } from "@/components/i18n-provider";

type LoadingSource =
  | { kind: "repo"; owner: string; repo: string; branch?: string; provider?: "github" | "gitlab" }
  | { kind: "local"; path: string }
  | { kind: "settings"; label?: string }
  | null;

interface SkeletonLoaderProps {
  source?: LoadingSource;
}

const Shimmer = ({ className }: { className?: string }) => (
  <div className={`bg-muted animate-pulse rounded-lg ${className ?? ""}`} />
);

/** Subtle ring spinner. Stroke-dashoffset animation, no rotating wrapper. */
const RingSpinner = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    className="text-foreground/70"
    aria-hidden
  >
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
    <circle
      cx="12"
      cy="12"
      r="9"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeDasharray="14 60"
      style={{
        transformOrigin: "center",
        animation: "deploy-spinner 0.9s linear infinite",
      }}
    />
    <style>{`@keyframes deploy-spinner { to { transform: rotate(360deg); } }`}</style>
  </svg>
);

function sourceLabel(source: LoadingSource): string | null {
  if (!source) return null;
  if (source.kind === "local") return source.path;
  if (source.kind === "settings") return source.label ?? null;
  return source.branch ? `${source.owner}/${source.repo} · ${source.branch}` : `${source.owner}/${source.repo}`;
}

const StatusHeader = ({ source }: { source: LoadingSource }) => {
  const { t } = useI18n();
  const label = sourceLabel(source);
  const s = t.deploy.skeleton;
  // Config-edit hydrates from saved data (settings); local scans the folder;
  // otherwise we're pulling from the remote repo.
  const repoConnecting =
    source?.kind === "repo" && source.provider === "gitlab" ? s.repo1Gitlab : s.repo1;
  const phases =
    source?.kind === "settings"
      ? [s.settings1, s.settings2]
      : source?.kind === "local"
        ? [s.local1, s.local2, s.local3]
        : [repoConnecting, s.repo2, s.repo3];
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setPhase((p) => (p + 1) % phases.length), 1600);
    return () => clearInterval(id);
  }, [phases.length]);

  return (
    <div className="bg-card rounded-2xl border border-border/50 px-5 py-4 mb-6 overflow-hidden">
      <div className="flex items-center gap-3">
        <RingSpinner />
        <div className="min-w-0 flex-1">
          <div
            key={phase}
            className="text-[13px] text-muted-foreground tracking-tight transition-opacity duration-300"
            style={{ animation: "deploy-fade 0.32s ease-out both" }}
          >
            {phases[phase]}
            <span className="inline-block w-4 text-start">
              <span
                className="inline-block"
                style={{ animation: "deploy-dots 1.2s steps(4, end) infinite" }}
              >
                …
              </span>
            </span>
          </div>
          {label && (
            <div className="mt-0.5 text-[14px] font-medium text-foreground tracking-tight truncate">
              {label}
            </div>
          )}
        </div>
      </div>
      <style>{`
        @keyframes deploy-fade { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: none; } }
        @keyframes deploy-dots {
          0%   { clip-path: inset(0 100% 0 0); }
          25%  { clip-path: inset(0 66% 0 0); }
          50%  { clip-path: inset(0 33% 0 0); }
          75%  { clip-path: inset(0 0 0 0); }
          100% { clip-path: inset(0 0 0 0); }
        }
      `}</style>
    </div>
  );
};

const SkeletonLoader = ({ source = null }: SkeletonLoaderProps) => (
  <PageContainer>
      <StatusHeader source={source} />
      <div className="grid lg:grid-cols-[1fr_340px] gap-6">
        {/* Main column */}
        <div className="space-y-5">
          {/* Project Settings */}
          <div className="bg-card rounded-2xl border border-border/50 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <Shimmer className="w-8 h-8 rounded-lg" />
              <Shimmer className="h-5 w-32" />
            </div>
            <Shimmer className="h-10 rounded-xl" />
            <div className="grid grid-cols-3 gap-3">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <Shimmer key={i} className="h-14 rounded-lg" />
              ))}
            </div>
            <Shimmer className="h-10 rounded-xl" />
          </div>

          {/* Build Settings */}
          <div className="bg-card rounded-2xl border border-border/50 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <Shimmer className="w-8 h-8 rounded-lg" />
              <Shimmer className="h-5 w-28" />
            </div>
            {[1, 2, 3].map((i) => (
              <div key={i}>
                <Shimmer className="h-4 w-24 mb-2" />
                <Shimmer className="h-10 rounded-xl" />
              </div>
            ))}
          </div>

          {/* Environment Variables */}
          <div className="bg-card rounded-2xl border border-border/50 p-5 space-y-4">
            <div className="flex items-center gap-3">
              <Shimmer className="w-8 h-8 rounded-lg" />
              <Shimmer className="h-5 w-40" />
            </div>
            {[1, 2].map((i) => (
              <div key={i} className="flex gap-3">
                <Shimmer className="flex-1 h-10 rounded-xl" />
                <Shimmer className="flex-1 h-10 rounded-xl" />
                <Shimmer className="w-10 h-10 rounded-xl" />
              </div>
            ))}
          </div>

          {/* Project Name */}
          <div className="bg-card rounded-2xl border border-border/50 p-5 space-y-4">
            <Shimmer className="h-4 w-24" />
            <Shimmer className="h-10 rounded-xl" />
            <Shimmer className="h-4 w-56" />
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          <div className="bg-card rounded-2xl border border-border/50 p-4">
            <div className="flex items-center gap-3">
              <Shimmer className="w-8 h-8 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Shimmer className="h-4 w-32" />
                <Shimmer className="h-3 w-20" />
              </div>
            </div>
          </div>
          <div className="bg-card rounded-2xl border border-border/50 p-4 space-y-3">
            <Shimmer className="h-4 w-16" />
            <Shimmer className="h-9 rounded-xl" />
          </div>
          <Shimmer className="h-10 rounded-xl" />
        </div>
      </div>
  </PageContainer>
);

export default SkeletonLoader;
