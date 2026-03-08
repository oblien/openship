"use client";

import React from "react";
import {
  Cloud,
  Server,
  Zap,
  Shield,
  Globe,
  HardDrive,
  Lock,
  Cpu,
  Check,
} from "lucide-react";
import type { BuildTarget } from "../types";

/* ── Props ───────────────────────────────────────────────────────── */

interface TargetSelectorProps {
  value: BuildTarget;
  onChange: (target: BuildTarget) => void;
  /** Hide self-hosted option (e.g. when running on Oblien already) */
  selfHostedAvailable: boolean;
}

/* ── Target definitions ──────────────────────────────────────────── */

interface TargetOption {
  id: BuildTarget;
  name: string;
  tagline: string;
  icon: React.ElementType;
  features: string[];
  badge?: string;
}

const TARGETS: TargetOption[] = [
  {
    id: "cloud",
    name: "Oblien Cloud",
    tagline: "Deploy to the edge in seconds",
    icon: Cloud,
    badge: "Recommended",
    features: [
      "Instant deployments",
      "Automatic TLS & domains",
      "Global edge network",
      "Zero server management",
      "Auto-scaling",
    ],
  },
  {
    id: "self-hosted",
    name: "Self-Hosted",
    tagline: "Run on your own infrastructure",
    icon: Server,
    features: [
      "Full control over hardware",
      "Data stays on your servers",
      "Custom networking",
      "No usage-based billing",
      "SSH access",
    ],
  },
];

/* ── Component ───────────────────────────────────────────────────── */

export default function TargetSelector({
  value,
  onChange,
  selfHostedAvailable,
}: TargetSelectorProps) {
  const available = selfHostedAvailable
    ? TARGETS
    : TARGETS.filter((t) => t.id !== "self-hosted");

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2
          className="text-xl font-semibold text-foreground"
          style={{ letterSpacing: "-0.3px" }}
        >
          Deploy Target
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Choose where your project will be built and hosted
        </p>
      </div>

      {/* Target cards */}
      <div className={`grid gap-4 ${available.length > 1 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 max-w-lg"}`}>
        {available.map((target) => {
          const isSelected = value === target.id;
          const Icon = target.icon;

          return (
            <button
              key={target.id}
              onClick={() => onChange(target.id)}
              className={`relative flex flex-col text-left p-6 rounded-2xl border-2 transition-all ${
                isSelected
                  ? "border-primary bg-primary/[0.03] shadow-sm"
                  : "border-border/50 bg-card hover:border-border hover:bg-muted/20"
              }`}
            >
              {/* Badge */}
              {target.badge && (
                <span
                  className={`absolute top-4 right-4 px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                    isSelected
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {target.badge}
                </span>
              )}

              {/* Selection indicator */}
              <div
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mb-4 transition-all ${
                  isSelected
                    ? "border-primary bg-primary"
                    : "border-muted-foreground/30"
                }`}
              >
                {isSelected && <Check className="size-3 text-primary-foreground" />}
              </div>

              {/* Icon */}
              <div
                className={`w-12 h-12 rounded-xl flex items-center justify-center mb-4 ${
                  isSelected
                    ? "bg-primary/10"
                    : "bg-muted/60"
                }`}
              >
                <Icon
                  className={`size-6 ${isSelected ? "text-primary" : "text-muted-foreground"}`}
                />
              </div>

              {/* Title */}
              <h3 className="text-base font-semibold text-foreground mb-1">
                {target.name}
              </h3>
              <p className="text-sm text-muted-foreground mb-5">
                {target.tagline}
              </p>

              {/* Features */}
              <div className="space-y-2.5 mt-auto">
                {target.features.map((f, i) => (
                  <div key={i} className="flex items-center gap-2.5">
                    <div
                      className={`w-4 h-4 rounded-full flex items-center justify-center ${
                        isSelected
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      <Check className="size-2.5" />
                    </div>
                    <span className="text-sm text-muted-foreground">{f}</span>
                  </div>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
