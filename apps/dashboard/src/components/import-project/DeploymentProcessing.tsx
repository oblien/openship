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

interface DeploymentProcessingProps {
  onRedeploy: () => void; // Keep this as it updates URL
}

const DeploymentProcessing: React.FC<DeploymentProcessingProps> = ({ onRedeploy }) => {
  const { config, state, terminalRef, onTerminalReady, stopDeployment, steps, deploymentStatus } = useDeployment();
  const router = useRouter();

  // Build domain for display
  const domain = config.domainType === "free"
    ? `${config.domain || config.projectName}.obl.ee`
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
    <div className="min-h-screen mx-auto md:px-12" style={{ background: 'linear-gradient(to bottom, #fcfcfc, #f9f9f9)' }}>
      {/* Header - Compact and clean */}
      <div className="bg-white">
        <div className="py-5 relative">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex border border-black/5 bg-black/5 rounded-lg w-12 h-12 justify-center items-center">
                {generateIcon('space%20rocket-85-1687505546.png', 30, '#000')}
              </div>
              <div>
                <h1 className="text-xl font-semibold text-black">
                  {deploymentStatus === "cancelled"
                    ? "Deployment Cancelled"
                    : deploymentStatus === "failed"
                      ? "Deployment Failed"
                      : deploymentStatus === "ready"
                        ? "Deployment Successful"
                        : "Deploying..."}
                </h1>
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm text-gray-500 mt-0.5">
                    {config.owner}/{config.repo}
                  </p>
                </div>
              </div>
            </div>

            {deploymentStatus === "ready" && (
              <div className="flex items-center gap-2">
                <button
                  onClick={handleViewDashboard}
                  className="flex items-center gap-2 text-black font-medium transition-all duration-300 bg-white rounded-full px-4 py-2 text-sm border border-gray-200 hover:border-gray-300 hover:shadow-md"
                >
                  View dashboard
                </button>
                <button
                  onClick={() => window.open(`https://${domain}`, "_blank")}
                  className="flex items-center gap-2 text-white font-medium transition-all duration-300 bg-black rounded-full px-4 py-2 text-sm hover:bg-gray-800 shadow-md hover:shadow-lg"
                >
                  Visit Site
                  {generateIcon('External_link_HtLszLDBXqHilHK674zh2aKoSL7xUhyboAzP.png', 16, '#fff')}
                </button>
              </div>
            )}

            {(deploymentStatus === "failed" || deploymentStatus === "cancelled") && (
              <button
                onClick={handleFixWithAI}
                className="flex items-center gap-2 px-5 py-2 bg-black text-white rounded-full transition-all font-medium text-sm shadow-md hover:shadow-lg hover:bg-gray-800"
              >
                {generateIcon('stars-123-1687505546.png', 20, '#fff')}
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
            <div
              className="bg-white rounded-[20px] border p-8 transition-all duration-300"
              style={{
                boxShadow: '0 8px 25px rgba(0, 0, 0, 0.04)',
                borderColor: '#f0f0f0',
              }}
            >
              <h2 className="text-base font-normal text-black mb-6">Deployment Progress</h2>

              {/* Steps */}
              <div className="relative">
                {/* Progress Line */}
                <div
                  className="absolute top-6 left-0 right-0 z-0"
                  style={{
                    height: '2px',
                    background: '#f0f0f0',
                  }}
                >
                  <div
                    className="h-full transition-all duration-500"
                    style={{
                      width: `${(state.currentStepIndex / (steps.length - 1)) * 100}%`,
                      background: '#000',
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
                      <div key={index} className="flex flex-col items-center bg-[#ffffff] z-10 px-2">
                        <div
                          className="rounded-full flex items-center justify-center transition-all duration-300 relative"
                          style={{
                            width: '48px',
                            height: '48px',
                            background: hasFailed
                              ? '#ef4444'
                              : isReady
                                ? 'var(--color-indigo-600)'
                                : isCompleted
                                  ? 'var(--color-indigo-600)'
                                  : isCurrent
                                    ? '#000'
                                    : 'white',
                            border: hasFailed || isReady || isCompleted || isCurrent ? 'none' : '2px solid #e5e7eb',
                          }}
                        >
                          {hasFailed ? (
                            generateIcon('error%20triangle-16-1662499385.png', 26, '#fff')
                          ) : isReady || isCompleted ? (
                            generateIcon('check%20circle-68-1658234612.png', 26, '#fff')
                          ) : isCurrent ? (
                            <Loader2 className="w-6 h-6 text-white animate-spin" />
                          ) : (
                            generateIcon(step.icon, 24, isCompleted ? '#fff' : '#999')
                          )}
                        </div>
                        <span
                          className="text-sm font-normal mt-3"
                          style={{
                            color: hasFailed ? '#000' : isCompleted || isCurrent || isReady ? '#000' : '#9ca3af',
                          }}
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
                    <span className="text-gray-600 font-medium">Overall Progress</span>
                    <span className="font-bold text-black">{Math.round(state.currentProgress)}%</span>
                  </div>
                  <div
                    className="h-1.5 rounded-full overflow-hidden"
                    style={{ backgroundColor: '#f0f0f0' }}
                  >
                    <div
                      className="h-full transition-all duration-300"
                      style={{
                        width: `${state.currentProgress}%`,
                        background: 'var(--color-indigo-600)',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Build Terminal */}
            <div
              className="bg-white rounded-[20px] border p-6 mb-20"
              style={{
                boxShadow: '0 8px 25px rgba(0, 0, 0, 0.04)',
                borderColor: '#f0f0f0',
              }}
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  {generateIcon('terminal-58-1658431404.png', 24, '#000')}
                  <h2 className="text-base font-normal text-black">
                    {state.deploymentSuccess && config.options.hasServer ? "Production Logs" : "Build Terminal"}
                  </h2>
                </div>
                {deploymentStatus === "failed" && (
                  <span className="text-sm font-normal text-black/25">See logs for issue details</span>
                )}
              </div>

              <div
                className="bg-white border rounded-xl overflow-hidden"
                style={{
                  height: '400px',
                  borderColor: '#f0f0f0',
                  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.02)',
                }}
              >
                <BuildTerminal
                  onReady={handleTerminalReady}
                  mockData={false}
                  theme="light"
                />
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="lg:sticky lg:top-6 h-fit space-y-6">
            {/* Preview Card */}
            <div
              className="bg-white rounded-[20px] border p-6"
              style={{
                boxShadow: '0 8px 25px rgba(0, 0, 0, 0.04)',
                borderColor: '#f0f0f0',
              }}
            >
              <h3 className="text-base font-normal text-black mb-4">Preview</h3>

              {deploymentStatus === "ready" ? (
                <div className="space-y-4">
                  <button
                    onClick={() => window.open(`https://${domain}`, "_blank")}
                    className="w-full group cursor-pointer"
                  >
                    <div
                      className="aspect-video bg-gray-50 rounded-xl border flex items-center justify-center overflow-hidden relative transition-all duration-300"
                      style={{ borderColor: '#f0f0f0' }}
                    >
                      {screenshotUrl ? (
                        <img
                          src={screenshotUrl}
                          alt="Site preview"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="relative w-full h-full flex items-center justify-center overflow-hidden bg-indigo-25">
                          {/* Animated gradient orbs */}
                          <div className="absolute top-0 left-0 w-32 h-32 rounded-full blur-3xl opacity-30 animate-pulse" style={{ animationDuration: '3s' }}></div>
                          <div className="absolute bottom-0 right-0 w-40 h-40 rounded-full blur-3xl opacity-20 animate-pulse" style={{ animationDuration: '4s', animationDelay: '1s' }}></div>

                          {/* Subtle grid pattern */}
                          <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(indigo 1px, transparent 1px), linear-gradient(90deg, indigo 1px, transparent 1px)', backgroundSize: '24px 24px' }}></div>

                          {/* Content */}
                          <div className="relative text-center space-y-4">
                            {/* Icon with glow effect */}
                            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl border border-indigo-500/30 shadow-lg shadow-indigo-500/20">
                              <div className="relative">
                                {generateIcon('cloud%20connected-57-1658236831.png', 32, 'var(--color-indigo-600)')}
                                {/* Ping animation */}
                                <span className="absolute inset-0 w-8 h-8 rounded-full border-2 border-indigo-400 animate-ping opacity-75"></span>
                              </div>
                            </div>

                            <div>
                              <p className="text-base font-semibold text-gray-900 tracking-tight">Deployment Live</p>
                              <div className="flex items-center justify-center gap-1.5 mt-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse"></div>
                                <p className="text-xs font-medium text-indigo-600">Ready to visit</p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-all flex items-center justify-center backdrop-blur-0 group-hover:backdrop-blur-sm">
                        <div className="opacity-0 group-hover:opacity-100 transition-all duration-300 transform scale-95 group-hover:scale-100">
                          <div className="bg-black/80 backdrop-blur-md text-white px-5 py-2.5 rounded-xl flex items-center gap-2.5 shadow-xl border border-white/10">
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
                <div
                  className="aspect-video bg-gradient-to-br from-gray-50 to-gray-100 rounded-xl border-2 overflow-hidden relative"
                  style={{ borderColor: '#e2e8f0' }}
                >
                  {/* Shimmer effect overlay */}
                  <div
                    className="absolute inset-0 -translate-x-full animate-[shimmer_2s_infinite]"
                    style={{
                      background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.8) 50%, transparent 100%)',
                    }}
                  />

                  {/* Mock browser chrome */}
                  <div className="h-8 bg-white/60 border-b border-gray-200/50 flex items-center px-3 gap-2">
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-red-400/40 animate-pulse" />
                      <div className="w-2.5 h-2.5 rounded-full bg-yellow-400/40 animate-pulse" style={{ animationDelay: '0.1s' }} />
                      <div className="w-2.5 h-2.5 rounded-full bg-green-400/40 animate-pulse" style={{ animationDelay: '0.2s' }} />
                    </div>
                    <div className="flex-1 ml-4">
                      <div className="h-4 bg-gray-300/40 rounded-md w-3/4 animate-pulse" style={{ animationDelay: '0.3s' }} />
                    </div>
                  </div>

                  {/* Mock content */}
                  <div className="p-6 space-y-4">
                    <div className="h-6 bg-gray-300/40 rounded-lg w-1/3 animate-pulse" style={{ animationDelay: '0.1s' }} />
                    <div className="space-y-2">
                      <div className="h-4 bg-gray-300/40 rounded w-full animate-pulse" style={{ animationDelay: '0.2s' }} />
                      <div className="h-4 bg-gray-300/40 rounded w-5/6 animate-pulse" style={{ animationDelay: '0.3s' }} />
                      <div className="h-4 bg-gray-300/40 rounded w-4/6 animate-pulse" style={{ animationDelay: '0.4s' }} />
                    </div>
                    <div className="grid grid-cols-3 gap-3 mt-6">
                      <div className="h-20 bg-gray-300/40 rounded-lg animate-pulse" style={{ animationDelay: '0.2s' }} />
                      <div className="h-20 bg-gray-300/40 rounded-lg animate-pulse" style={{ animationDelay: '0.3s' }} />
                      <div className="h-20 bg-gray-300/40 rounded-lg animate-pulse" style={{ animationDelay: '0.4s' }} />
                    </div>
                  </div>

                  {/* Status text */}
                  <div className="absolute inset-0 flex items-center justify-center bg-white/5 backdrop-blur-[2px]">
                    <div className="text-center px-6 py-3 rounded-xl bg-white/90 backdrop-blur-sm border border-gray-200/50 shadow-lg">
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          {(deploymentStatus === "failed" || deploymentStatus === "cancelled") ? (
                            <>
                              {generateIcon('error%20triangle-16-1662499385.png', 20, '#000')}
                            </>
                          ) : (
                            <>
                              <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
                              <div className="absolute inset-0 w-5 h-5 border-2 border-indigo-200 rounded-full animate-ping" />
                            </>
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-normal text-gray-900">
                            {deploymentStatus === "cancelled" ? "Deployment cancelled" : deploymentStatus === "failed" ? "Deployment failed" : "Building preview"}
                          </p>
                          {(deploymentStatus !== "failed" && deploymentStatus !== "cancelled") && (
                            <div className="flex gap-1 mt-1">
                              <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" />
                              <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }} />
                              <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
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
            <div
              className="bg-white rounded-[20px] border p-4"
              style={{
                boxShadow: '0 8px 25px rgba(0, 0, 0, 0.04)',
                borderColor: '#f0f0f0',
              }}
            >
              {deploymentStatus === "deploying" || deploymentStatus === "building" ? (
                <button
                  onClick={stopDeployment}
                  disabled={state.isStopping}
                  className={`w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl transition-all font-medium text-sm border ${state.isStopping
                    ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
                    : 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100 hover:border-red-300'
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
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-black text-white rounded-xl transition-all font-medium text-sm hover:bg-gray-800"
                >
                  Redeploy
                </button>
              ) : (deploymentStatus === "ready") ? (
                <button
                  onClick={handleViewDashboard}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-black text-white rounded-xl transition-all font-medium text-sm hover:bg-gray-800"
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
  const [buildTime, setBuildTime] = useState<number>(0);
  const router = useRouter();

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
    <div
      className="bg-white rounded-[20px] border p-6"
      style={{
        boxShadow: '0 8px 25px rgba(0, 0, 0, 0.04)',
        borderColor: '#f0f0f0',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-normal text-black">Deployment Details</h3>
        {(state.deploymentCanceled || state.deploymentFailed) && (
          <button onClick={handleEdit} className="flex items-center gap-2 -mr-1 cursor-pointer opacity-50 hover:opacity-100 transition-all duration-300">
            <span className="text-sm black">Edit</span>
            {generateIcon('pen-404-1658238246.png', 18, '#000')}
          </button>
        )}
      </div>
      <div className="space-y-0">
        <div className="flex justify-between items-center py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-600">Status</span>
          <span
            className={`text-sm font-normal px-3 py-1 rounded-full border 
            ${deploymentStatus === "failed" || deploymentStatus === "cancelled"
                ? "bg-red-50 text-red-600 border-red-200"
                : "bg-indigo-600/10 text-indigo-600/80 border-indigo-600/20"
              }`}
          >
            {deploymentStatus === "cancelled" ? "Cancelled" : deploymentStatus === "failed" ? "Failed" : deploymentStatus === "ready" ? "Ready" : "Building"}
          </span>
        </div>
        <div className="flex justify-between items-center py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-600">Build Time</span>
          <span className="text-sm font-normal text-black flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-gray-500" />
            {formatTime(buildTime)}
          </span>
        </div>
        <div className="flex justify-between items-center py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-600">Domain</span>
          <span className="text-sm font-normal text-black">{config.domainType === "free" ? `${config.domain || config.projectName}.obl.ee` : config.customDomain}</span>
        </div>
        <div className="flex justify-between items-center py-1.5 border-b border-gray-100">
          <span className="text-sm text-gray-600">Branch</span>
          <span className="text-sm font-normal text-black flex items-center gap-1">
            {generateIcon('git%20branch-159-1658431404.png', 16, '#000')}
            {config.branch}
          </span>
        </div>
        <div className="flex justify-between items-center py-1.5">
          <span className="text-sm text-gray-600">Framework</span>
          <span className="text-sm font-normal text-black">{config.framework}</span>
        </div>
      </div>

    </div>
  );
});

DeploymentDetails.displayName = "DeploymentDetails";

export default DeploymentProcessing;

