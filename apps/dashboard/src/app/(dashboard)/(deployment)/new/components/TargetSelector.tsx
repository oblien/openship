"use client";

import React from "react";
import { Cloud, Server, Check } from "lucide-react";

interface TargetSelectorProps {
  value: "cloud" | "self-hosted";
  onChange: (target: "cloud" | "self-hosted") => void;
  selfHostedAvailable: boolean;
}

export default function TargetSelector({ value, onChange, selfHostedAvailable }: TargetSelectorProps) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground" style={{ letterSpacing: "-0.3px" }}>
          Deploy Target
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose where to deploy your project
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Cloud */}
        <button
          onClick={() => onChange("cloud")}
          className={`relative flex flex-col items-start gap-4 p-6 rounded-2xl border-2 transition-all text-left ${
            value === "cloud"
              ? "border-primary bg-primary/[0.04] shadow-sm"
              : "border-border/50 bg-card hover:border-border"
          }`}
        >
          {value === "cloud" && (
            <div className="absolute top-4 right-4 w-6 h-6 rounded-full bg-primary flex items-center justify-center">
              <Check className="size-3.5 text-primary-foreground" />
            </div>
          )}
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
            value === "cloud" ? "bg-primary/10" : "bg-muted/60"
          }`}>
            <Cloud className={`size-6 ${value === "cloud" ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Oblien Cloud</h3>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              Deploy to our managed infrastructure. Zero configuration, automatic scaling, free SSL.
            </p>
          </div>
          <div className="flex items-center gap-2 mt-auto">
            <span className="px-2.5 py-1 bg-emerald-500/10 text-emerald-600 text-xs font-medium rounded-lg">Recommended</span>
          </div>
        </button>

        {/* Self-hosted */}
        <button
          onClick={() => selfHostedAvailable && onChange("self-hosted")}
          disabled={!selfHostedAvailable}
          className={`relative flex flex-col items-start gap-4 p-6 rounded-2xl border-2 transition-all text-left ${
            !selfHostedAvailable
              ? "border-border/30 bg-muted/20 opacity-60 cursor-not-allowed"
              : value === "self-hosted"
                ? "border-primary bg-primary/[0.04] shadow-sm"
                : "border-border/50 bg-card hover:border-border"
          }`}
        >
          {value === "self-hosted" && (
            <div className="absolute top-4 right-4 w-6 h-6 rounded-full bg-primary flex items-center justify-center">
              <Check className="size-3.5 text-primary-foreground" />
            </div>
          )}
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
            value === "self-hosted" ? "bg-primary/10" : "bg-muted/60"
          }`}>
            <Server className={`size-6 ${value === "self-hosted" ? "text-primary" : "text-muted-foreground"}`} />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Self-Hosted</h3>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              Deploy to your own server. Full control over infrastructure and data.
            </p>
          </div>
          {!selfHostedAvailable && (
            <div className="flex items-center gap-2 mt-auto">
              <span className="px-2.5 py-1 bg-muted text-muted-foreground text-xs font-medium rounded-lg">Cloud-only mode</span>
            </div>
          )}
        </button>
      </div>
    </div>
  );
}
