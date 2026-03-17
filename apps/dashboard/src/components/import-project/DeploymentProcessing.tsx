"use client";

import React, { useState, useEffect, useCallback, memo } from "react";
import Image from "next/image";
import {
  CheckCircle2,
  Loader2,
  Clock,
} from "lucide-react";
import type { Terminal } from "@xterm/xterm";
import BuildTerminal from "./BuildTerminal";
import { generateIcon } from "@/utils/icons";
import { useRouter } from "next/navigation";
import { encodeRepoSlug } from "@/utils/repoSlug";
import { useDeployment } from "@/context/DeploymentContext";
import { useTheme } from "@/components/theme-provider";

interface DeploymentProcessingProps {
  onRedeploy: () => void; // Keep this as it updates URL
}

const DeploymentProcessing: React.FC<DeploymentProcessingProps> = ({ onRedeploy }) => {
  const { config, state, terminalRef, onTerminalReady, stopDeployment, steps, deploymentStatus } = useDeployment();
  const { resolvedTheme } = useTheme();
  const router = useRouter();

  // Build domain for display
  const domain = config.domainType === "free"
    ? `${config.domain || config.projectName}.opsh.io`
    : config.customDomain;

  const handleTerminalReady = useCallback((terminal: Terminal) => {
    if (terminalRef) {
      terminalRef.current = terminal;
    }
    onTerminalReady();
  }, [terminalRef, onTerminalReady]);

  const handleFixWithAI = () => {
    window.open('https://blurs.app', '_blank');
  };

  // Get medium variant screenshot URL
  const getScreenshotUrl = () => {
    if (!state.screenshots || state.screenshots.length === 0) return null;
    const firstScreenshot = state.screenshots[0];
    const mediumVariant = firstScreenshot?.variants?.find(v => v.variant === "medium");
    return mediumVariant?.url || firstScreenshot?.url;
  };

  const screenshotUrl = getScreenshotUrl();

  const handleViewDashboard = () => {
    if (state.projectId) {
      router.push(`/projects/${state.projectId}`);
    }
  };

  return (
    <div className="min-h-screen bg-background mx-auto md:px-12">
      {/* Header */}
      <div className="bg-background">
        <div className="py-5 relative">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex border border-border/50 bg-muted/50 rounded-lg w-12 h-12 justify-center items-center">
                {generateIcon('space%20rocket-85-1687505546.png', 30, 'currentColor')}
              </div>
              <div>
                <h1 className="text-xl font-semibold text-foreground">
                  {deploymentStatus === "cancelled"
                    ? "Deployment Cancelled"
                    : deploymentStatus === "failed"
                      ? "Deployment Failed"
                      : deploymentStatus === "ready"
                        ? "Deployment Successful"
                        : "Deploying..."}
                </h1>
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {config.owner}/{config.repo}
                  </p>
                </div>
              </div>
            </div>

            {deploymentStatus === "ready" && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleViewDashboard}
                  className="flex items-center gap-2 text-foreground font-medium transition-all duration-300 bg-card rounded-full px-4 py-2 text-sm border border-border hover:shadow-md"
                >
                  View dashboard
                </button>
                <button
                  onClick={() => window.open(`https://${domain}`, "_blank")}
                  className="flex items-center gap-2 text-primary-foreground font-medium transition-all duration-300 bg-primary rounded-full px-4 py-2 text-sm hover:bg-primary/90 shadow-md hover:shadow-lg"
                >
                  Visit Site
                  {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 16, '#fff')}
                </button>
              </div>
            )}

            {(deploymentStatus === "failed" || deploymentStatus === "cancelled") && (
              <button
                onClick={handleFixWithAI}
                className="flex items-center gap-2 px-5 py-2 bg-primary text-primary-foreground rounded-full transition-all font-medium text-sm shadow-md hover:shadow-lg hover:bg-primary/90"
              >
                {generateIcon('stars-123-1687505546.png', 20, 'var(--color-background)')}
                Fix with Blurs AI
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="w-full">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content */}
          <div className="lg:col-span-2 space-y-6">
            {/* Progress Steps */}
            <div className="bg-card rounded-2xl border border-border/50 p-8 transition-all duration-300">
              <h2 className="text-base font-normal text-foreground mb-6">Deployment Progress</h2>

              {/* Steps */}
              <div className="relative">
                {/* Progress Line */}
                <div className="absolute top-6 left-[24px] right-[24px] z-0 h-[2px] bg-border/50">
                  <div
                    className="h-full transition-all duration-500 bg-primary"
                    style={{
                      width: `${(state.currentStepIndex / (steps.length - 1)) * 100}%`,
                    }}
                  />
                </div>

                {/* Step Items */}
                <div className="relative flex justify-between z-10">
                  {steps.map((step, index) => {
                    const isCompleted = index < state.currentStepIndex;
                    const isCurrent = index === state.currentStepIndex && !state.deploymentSuccess && !state.deploymentFailed && !state.deploymentCanceled;
                    const hasFailed = (state.deploymentFailed || state.deploymentCanceled) && index === state.currentStepIndex;
                    const isReady = state.deploymentSuccess && index === steps.length - 1;

                    return (
                      <div key={index} className="flex flex-col items-center z-10 px-2">
                        <div
                          style={{ boxShadow: '0 0 0 8px var(--th-card-bg-solid)' }}
                          className={`rounded-full flex items-center justify-center transition-all duration-300 relative w-12 h-12 ${
                            hasFailed
                              ? 'bg-destructive'
                              : isReady || isCompleted
                                ? 'bg-primary'
                                : isCurrent
                                  ? 'bg-foreground'
                                  : 'bg-card border-2 border-border'
                          }`}
                        >
                          {hasFailed ? (
                            generateIcon('error%20triangle-16-1662499385.png', 26, '#fff')
                          ) : isReady || isCompleted ? (
                            generateIcon('check%20circle-68-1658234612.png', 26, 'var(--primary-foreground)')
                          ) : isCurrent ? (
                            <Loader2 className="w-6 h-6 text-background animate-spin" />
                          ) : (
                            generateIcon(step.icon, 24, 'var(--th-text-muted)')
                          )}
                        </div>
                        <span
                          className={`text-sm font-normal mt-3 ${
                            hasFailed || isCompleted || isCurrent || isReady
                              ? 'text-foreground'
                              : 'text-muted-foreground'
                          }`}
                        >
                          {step.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Progress Bar */}
              {deploymentStatus !== "ready" && deploymentStatus !== "failed" && deploymentStatus !== "cancelled" && (
                <div className="mt-6">
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span className="text-muted-foreground font-medium">Overall Progress</span>
                    <span className="font-bold text-foreground">{Math.round(state.currentProgress)}%</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden bg-border/50">
                    <div
                      className="h-full transition-all duration-300 bg-primary"
                      style={{ width: `${state.currentProgress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Build Terminal */}
            <div className="bg-card rounded-2xl border border-border/50 p-6 mb-20">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  {generateIcon('terminal-58-1658431404.png', 24, 'currentColor')}
                  <h2 className="text-base font-normal text-foreground">
                    {state.deploymentSuccess && config.options.hasServer ? "Production Logs" : "Build Terminal"}
                  </h2>
                </div>
                {deploymentStatus === "failed" && (
                  <span className="text-sm font-normal text-muted-foreground">See logs for issue details</span>
                )}
              </div>

              <div className="bg-white dark:bg-black border border-border/50 rounded-xl overflow-hidden h-[400px]">
                <BuildTerminal
                  onReady={handleTerminalReady}
                  mockData={false}
                  theme={resolvedTheme}
                />
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="lg:sticky lg:top-6 h-fit space-y-6">
            {/* Preview Card */}
            <div className="bg-card rounded-2xl border border-border/50 p-6">
              <h3 className="text-base font-normal text-foreground mb-4">Preview</h3>

              {deploymentStatus === "ready" ? (
                <div className="space-y-4">
                  <button
                    onClick={() => window.open(`https://${domain}`, "_blank")}
                    className="w-full group cursor-pointer"
                  >
                    <div
                      className="aspect-video bg-muted/50 rounded-xl border border-border/50 flex items-center justify-center overflow-hidden relative transition-all duration-300"
                    >
                      {screenshotUrl ? (
                        <img
                          src={screenshotUrl}
                          alt="Site preview"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="relative w-full h-full flex items-center justify-center overflow-hidden bg-primary/5">
                          {/* Animated gradient orbs */}
                          <div className="absolute top-0 left-0 w-32 h-32 rounded-full blur-3xl opacity-30 animate-pulse" style={{ animationDuration: '3s' }}></div>
                          <div className="absolute bottom-0 right-0 w-40 h-40 rounded-full blur-3xl opacity-20 animate-pulse" style={{ animationDuration: '4s', animationDelay: '1s' }}></div>

                          {/* Subtle grid pattern */}
                          <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

                          {/* Content */}
                          <div className="relative text-center space-y-4">
                            {/* Icon with glow effect */}
                            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl border border-primary/30 shadow-lg shadow-primary/20">
                              <div className="relative">
                                {generateIcon('cloud%20connected-57-1658236831.png', 32, 'var(--color-primary)')}
                                {/* Ping animation */}
                                <span className="absolute inset-0 w-8 h-8 rounded-full border-2 border-primary/40 animate-ping opacity-75"></span>
                              </div>
                            </div>

                            <div>
                              <p className="text-base font-semibold text-foreground tracking-tight">Deployment Live</p>
                              <div className="flex items-center justify-center gap-1.5 mt-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></div>
                                <p className="text-xs font-medium text-primary">Ready to visit</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="absolute inset-0 bg-foreground/0 group-hover:bg-foreground/10 transition-all flex items-center justify-center backdrop-blur-0 group-hover:backdrop-blur-sm">
                        <div className="opacity-0 group-hover:opacity-100 transition-all duration-300 transform scale-95 group-hover:scale-100">
                          <div className="bg-foreground/80 backdrop-blur-md text-background px-5 py-2.5 rounded-xl flex items-center gap-2.5 shadow-xl border border-background/10">
                            {generateIcon('earth-29-1687505545.png', 20, '#fff')}
                            <span className="font-medium text-sm">Visit Site</span>
                            {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 18, '#fff')}
                          </div>
                        </div>
                      </div>
                    </div>
                  </button>
                </div>
              ) : (
                <div className="aspect-video bg-muted/30 rounded-xl border-2 border-border overflow-hidden relative">
                  {/* Shimmer effect overlay */}
                  <div
                    className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite]"
                    style={{
                      background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.8) 50%, transparent 100%)',
                    }}
                  />

                  {/* Mock browser chrome */}
                  <div className="h-8 bg-card/60 border-b border-border/50 flex items-center px-3 gap-2">
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-destructive/40 animate-pulse" />
                      <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/40 animate-pulse" style={{ animationDelay: '0.1s' }} />
                      <div className="w-2.5 h-2.5 rounded-full bg-green-400/40 animate-pulse" style={{ animationDelay: '0.2s' }} />
                    </div>
                    <div className="flex-1 ml-4">
                      <div className="h-4 bg-muted/60 rounded-md w-3/4 animate-pulse" style={{ animationDelay: '0.3s' }} />
                    </div>
                  </div>

                  {/* Mock content */}
                  <div className="p-6 space-y-4">
                    <div className="h-6 bg-muted/60 rounded-lg w-1/3 animate-pulse" style={{ animationDelay: '0.1s' }} />
                    <div className="space-y-2">
                      <div className="h-4 bg-muted/60 rounded w-full animate-pulse" style={{ animationDelay: '0.2s' }} />
                      <div className="h-4 bg-muted/60 rounded w-5/6 animate-pulse" style={{ animationDelay: '0.3s' }} />
                      <div className="h-4 bg-muted/60 rounded w-4/6 animate-pulse" style={{ animationDelay: '0.4s' }} />
                    </div>
                    <div className="grid grid-cols-3 gap-3 mt-6">
                      <div className="h-20 bg-muted/60 rounded-lg animate-pulse" style={{ animationDelay: '0.2s' }} />
                      <div className="h-20 bg-muted/60 rounded-lg animate-pulse" style={{ animationDelay: '0.3s' }} />
                      <div className="h-20 bg-muted/60 rounded-lg animate-pulse" style={{ animationDelay: '0.4s' }} />
                    </div>
                  </div>

                  {/* Status text */}
                  <div className="absolute inset-0 flex items-center justify-center bg-card/5 backdrop-blur-[2px]">
                    <div className="text-center px-6 py-3 rounded-xl bg-card/90 backdrop-blur-sm border border-border/50 shadow-lg">
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          {(deploymentStatus === "failed" || deploymentStatus === "cancelled") ? (
                            <>
                              {generateIcon('error%20triangle-16-1662499385.png', 20, 'currentColor')}
                            </>
                          ) : (
                            <>
                              <Loader2 className="w-5 h-5 text-primary animate-spin" />
                              <div className="absolute inset-0 w-5 h-5 border-2 border-primary/30 rounded-full animate-ping" />
                            </>
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-normal text-foreground">
                            {deploymentStatus === "cancelled" ? "Deployment cancelled" : deploymentStatus === "failed" ? "Deployment failed" : "Building preview"}
                          </p>
                          {(deploymentStatus !== "failed" && deploymentStatus !== "cancelled") && (
                            <div className="flex gap-1 mt-1">
                              <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" />
                              <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                              <span className="w-1.5 h-1.5 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Deployment Info */}
            <DeploymentDetails />

            {/* Action Button */}
            <div className="bg-card rounded-2xl border border-border/50 p-4">
              {deploymentStatus === "deploying" || deploymentStatus === "building" ? (
                <button
                  onClick={stopDeployment}
                  disabled={state.isStopping}
                  className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl transition-all font-medium text-sm border ${state.isStopping
                    ? 'bg-muted text-muted-foreground border-border cursor-not-allowed'
                    : 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/15 hover:border-destructive/30'
                    }`}
                >
                  {state.isStopping ? (
                    <>
                      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      Stopping...
                    </>
                  ) : (
                    'Stop Deployment'
                  )}
                </button>
              ) : (deploymentStatus === "failed" || deploymentStatus === "cancelled") ? (
                <button
                  onClick={onRedeploy}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl transition-all font-medium text-sm hover:bg-primary/90"
                >
                  Redeploy
                </button>
              ) : (deploymentStatus === "ready") ? (
                <button
                  onClick={handleViewDashboard}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-xl transition-all font-medium text-sm hover:bg-primary/90"
                >
                  Open Dashboard
                </button>
              ) : null}

            </div>

          </div>
        </div>
      </div>
    </div>
  );
};

const DeploymentDetails = memo(() => {
  const { state, deploymentStatus, config } = useDeployment();
  const [buildTime, setBuildTime] = useState<number>(() => {
    // Initialize from persisted duration if available
    if (state.buildDurationMs) return Math.round(state.buildDurationMs / 1000);
    // For in-progress builds, calculate elapsed from startedAt
    if (state.buildStartedAt) {
      return Math.max(0, Math.round((Date.now() - new Date(state.buildStartedAt).getTime()) / 1000));
    }
    return 0;
  });
  const router = useRouter();

  // Sync final duration when build completes
  useEffect(() => {
    if (state.buildDurationMs && (state.deploymentSuccess || state.deploymentFailed || state.deploymentCanceled)) {
      setBuildTime(Math.round(state.buildDurationMs / 1000));
    }
  }, [state.buildDurationMs, state.deploymentSuccess, state.deploymentFailed, state.deploymentCanceled]);

  useEffect(() => {
    if (state.deploymentSuccess || state.deploymentFailed || state.deploymentCanceled) {
      return;
    }

    const timerInterval = setInterval(() => {
      setBuildTime((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(timerInterval);
  }, [state.deploymentSuccess, state.deploymentFailed, state.deploymentCanceled]);

  const handleEdit = () => {
    const slug = encodeRepoSlug(config.owner, config.repo);
    router.push(`/deploy/${slug}?force=true`);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-normal text-foreground">Deployment Details</h3>
        {(state.deploymentCanceled || state.deploymentFailed) && (
          <button onClick={handleEdit} className="flex items-center gap-2 -mr-1 cursor-pointer opacity-50 hover:opacity-100 transition-all duration-300">
            <span className="text-sm text-foreground">Edit</span>
            {generateIcon('pen-404-1658238246.png', 18, 'currentColor')}
          </button>
        )}
      </div>
      <div className="space-y-0">
        <div className="flex justify-between items-center py-1.5 border-b border-border/50">
          <span className="text-sm text-muted-foreground">Status</span>
          <span
            className={`text-sm font-normal px-3 py-1 rounded-full border 
            ${deploymentStatus === "failed" || deploymentStatus === "cancelled"
                ? "bg-destructive/10 text-destructive border-destructive/20"
                : "bg-primary/10 text-primary border-primary/20"
              }`}
          >
            {deploymentStatus === "cancelled" ? "Cancelled" : deploymentStatus === "failed" ? "Failed" : deploymentStatus === "ready" ? "Ready" : "Building"}
          </span>
        </div>
        <div className="flex justify-between items-center py-1.5 border-b border-border/50">
          <span className="text-sm text-muted-foreground">Build Time</span>
          <span className="text-sm font-normal text-foreground flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-muted-foreground" />
            {formatTime(buildTime)}
          </span>
        </div>
        <div className="flex justify-between items-center py-1.5 border-b border-border/50">
          <span className="text-sm text-muted-foreground">Domain</span>
          <span className="text-sm font-normal text-foreground">{config.domainType === "free" ? `${config.domain || config.projectName}.opsh.io` : config.customDomain}</span>
        </div>
        <div className="flex justify-between items-center py-1.5 border-b border-border/50">
          <span className="text-sm text-muted-foreground">Branch</span>
          <span className="text-sm font-normal text-foreground flex items-center gap-1">
            {generateIcon('git%20branch-159-1658431404.png', 16, 'currentColor')}
            {config.branch}
          </span>
        </div>
        <div className="flex justify-between items-center py-1.5">
          <span className="text-sm text-muted-foreground">Framework</span>
          <span className="text-sm font-normal text-foreground">{config.framework}</span>
        </div>
      </div>

    </div>
  );
});

DeploymentDetails.displayName = "DeploymentDetails";

export default DeploymentProcessing;

