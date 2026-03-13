"use client";

import React from "react";

/**
 * BuildSkeleton - Loading state for build page
 * Matches the layout of DeploymentProcessing
 */
const BuildSkeleton: React.FC = () => {
  return (
    <div className="min-h-screen mx-auto md:px-12 bg-background">
      {/* Header Skeleton */}
      <div className="bg-background">
        <div className="py-5 relative">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                {/* Title skeleton */}
                <div className="h-7 w-48 bg-gradient-to-r from-muted via-muted/50 to-muted rounded-lg mb-2 animate-pulse" />
                {/* Subtitle skeleton */}
                <div className="h-4 w-32 bg-gradient-to-r from-muted via-muted/50 to-muted rounded-lg animate-pulse" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="w-full">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Content - Left Side (2/3) */}
          <div className="lg:col-span-2 space-y-6">
            {/* Progress Steps Skeleton */}
            <div className="bg-card rounded-2xl border border-border/50 p-8">
              {/* Title */}
              <div className="h-5 w-40 bg-gradient-to-r from-muted via-muted/50 to-muted rounded-lg mb-6 animate-pulse" />

              {/* Steps */}
              <div className="relative">
                {/* Progress Line */}
                <div className="absolute top-6 left-0 right-0 z-0 h-0.5 bg-border/50">
                  <div className="h-full w-1/4 bg-gradient-to-r from-muted-foreground/30 via-muted-foreground/20 to-muted/50 animate-pulse" />
                </div>

                {/* Step Items */}
                <div className="relative flex justify-between z-10">
                  {[0, 1, 2, 3, 4].map((index) => (
                    <div key={index} className="flex flex-col items-center bg-card z-10 px-2">
                      {/* Circle skeleton */}
                      <div
                        className={`w-12 h-12 rounded-full flex items-center justify-center transition-all duration-300 animate-pulse ${
                          index === 0 ? 'bg-muted' : 'bg-card border-2 border-border'
                        }`}
                      />
                      {/* Label skeleton */}
                      <div className="h-3 w-16 bg-gradient-to-r from-muted via-muted/50 to-muted rounded mt-3 animate-pulse" />
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Terminal Skeleton */}
            <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
              {/* Terminal Header */}
              <div className="flex items-center justify-between px-6 py-3 border-b border-border/50 bg-muted/50">
                <div className="flex items-center gap-3">
                  <div className="flex gap-2">
                    <div className="w-3 h-3 rounded-full bg-destructive/40 animate-pulse"></div>
                    <div className="w-3 h-3 rounded-full bg-yellow-400/50 animate-pulse"></div>
                    <div className="w-3 h-3 rounded-full bg-green-400/50 animate-pulse"></div>
                  </div>
                  <div className="h-4 w-24 bg-gradient-to-r from-muted via-muted/50 to-muted rounded animate-pulse" />
                </div>
                <div className="h-4 w-16 bg-gradient-to-r from-muted via-muted/50 to-muted rounded animate-pulse" />
              </div>

              {/* Terminal Body */}
              <div className="bg-card p-6 min-h-[400px] space-y-3">
                {/* Log line skeletons */}
                {[...Array(8)].map((_, i) => {
                  const widths = [98, 97, 92, 93, 73, 71, 62, 85];
                  return (
                    <div
                      key={i}
                      className="h-4 bg-gradient-to-r from-muted via-muted/50 to-muted rounded animate-pulse"
                      style={{
                        width: `${widths[i] || 80}%`,
                        animationDelay: `${i * 0.1}s`,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>

          {/* Sidebar - Right Side (1/3) */}
          <div className="space-y-6">
            {/* Project Info Skeleton */}
            <div className="bg-card rounded-2xl border border-border/50 p-6">
              {/* Title */}
              <div className="h-5 w-32 bg-gradient-to-r from-muted via-muted/50 to-muted rounded-lg mb-4 animate-pulse" />
              
              {/* Info rows */}
              <div className="space-y-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="h-4 w-24 bg-gradient-to-r from-muted via-muted/50 to-muted rounded animate-pulse" />
                    <div className="h-4 w-32 bg-gradient-to-r from-muted via-muted/50 to-muted rounded animate-pulse" />
                  </div>
                ))}
              </div>
            </div>

            {/* Domain Skeleton */}
            <div className="bg-card rounded-2xl border border-border/50 p-6">
              {/* Title */}
              <div className="h-5 w-28 bg-gradient-to-r from-muted via-muted/50 to-muted rounded-lg mb-4 animate-pulse" />
              
              {/* Domain box */}
              <div className="h-12 w-full bg-gradient-to-r from-muted via-muted/50 to-muted rounded-xl animate-pulse" />
              
              {/* Copy button */}
              <div className="h-10 w-full bg-gradient-to-r from-muted via-muted/50 to-muted rounded-full mt-3 animate-pulse" />
            </div>

            {/* Build Time Skeleton */}
            <div className="bg-card rounded-2xl border border-border/50 p-6">
              <div className="h-5 w-24 bg-gradient-to-r from-muted via-muted/50 to-muted rounded-lg mb-4 animate-pulse" />
              <div className="h-8 w-20 bg-gradient-to-r from-muted via-muted/50 to-muted rounded-lg animate-pulse" />
            </div>

            {/* Actions Skeleton */}
            <div className="bg-card rounded-2xl border border-border/50 p-6">
              <div className="h-5 w-20 bg-gradient-to-r from-muted via-muted/50 to-muted rounded-lg mb-4 animate-pulse" />
              <div className="space-y-3">
                <div className="h-10 w-full bg-gradient-to-r from-muted via-muted/50 to-muted rounded-xl animate-pulse" />
                <div className="h-10 w-full bg-gradient-to-r from-muted via-muted/50 to-muted rounded-xl animate-pulse" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Loading Indicator Overlay */}
      <div className="fixed bottom-8 right-8 bg-card rounded-2xl border border-border/50 px-6 py-4 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="w-5 h-5 border-3 border-foreground/10 border-t-foreground rounded-full animate-spin"></div>
          </div>
          <div>
          <span className="text-sm text-muted-foreground">Loading build session...</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default BuildSkeleton;

