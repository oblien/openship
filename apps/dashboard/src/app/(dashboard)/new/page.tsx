"use client";

import React, { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Rocket,
  Loader2,
  Check,
  Github,
  Upload,
  Link2,
  Sparkles,
  Globe,
  GitBranch,
  Shield,
  Cloud,
  Server,
  Box,
  Layers,
} from "lucide-react";
import { useDeployment, DeploymentProvider } from "@/context/DeploymentContext";
import SourceSelector from "./components/SourceSelector";
import ConfigureProject from "./components/ConfigureProject";
import TargetSelector from "./components/TargetSelector";
import type { Step, ProjectSource, NewProjectState } from "./types";
import { DEFAULT_CONFIG } from "./types";
import { getFrameworkConfig, frameworks } from "@/components/import-project/Frameworks";

/* ── Steps ────────────────────────────────────────────────────────── */

const STEPS: { id: Step; label: string }[] = [
  { id: "source", label: "Source" },
  { id: "configure", label: "Configure" },
  { id: "target", label: "Deploy" },
];

/* ── Page ─────────────────────────────────────────────────────────── */

export default function NewProjectPage() {
  return (
    <DeploymentProvider>
      <NewProjectContent />
    </DeploymentProvider>
  );
}

function NewProjectContent() {
  const router = useRouter();
  const { initializeFromRepo, startDeployment } = useDeployment();

  const [state, setState] = useState<NewProjectState>({
    step: "source",
    source: null,
    config: DEFAULT_CONFIG,
    target: "cloud",
  });
  const [deploying, setDeploying] = useState(false);

  const selfHostedAvailable = useMemo(
    () => process.env.NEXT_PUBLIC_DEPLOY_MODE !== "cloud",
    []
  );

  /* ── Source selected → advance to configure ───────────────────── */
  const handleSourceSelected = useCallback((source: ProjectSource) => {
    let name = "";
    let framework = "static";

    switch (source.kind) {
      case "github":
      case "url":
        name = source.repo;
        break;
      case "upload":
        name = source.rootName;
        break;
      case "template":
        name = source.templateName.toLowerCase().replace(/[^a-z0-9]/g, "-");
        framework = source.framework;
        break;
    }

    const fw = getFrameworkConfig(framework);
    setState((s) => ({
      ...s,
      step: "configure",
      source,
      config: {
        ...s.config,
        name,
        framework,
        domain: name.toLowerCase().replace(/[^a-z0-9-]/g, ""),
        buildCommand: fw.options.buildCommand,
        installCommand: fw.options.installCommand,
        outputDirectory: fw.options.outputDirectory,
      },
    }));
  }, []);

  /* ── Navigation ───────────────────────────────────────────────── */
  const stepIndex = STEPS.findIndex((s) => s.id === state.step);

  const goBack = () => {
    if (stepIndex > 0)
      setState((s) => ({ ...s, step: STEPS[stepIndex - 1]!.id }));
  };

  const goNext = () => {
    if (stepIndex < STEPS.length - 1)
      setState((s) => ({ ...s, step: STEPS[stepIndex + 1]!.id }));
  };

  /* ── Deploy ───────────────────────────────────────────────────── */
  const handleDeploy = async () => {
    if (!state.source) return;
    setDeploying(true);
    try {
      if (state.source.kind === "github" || state.source.kind === "url") {
        const result = await initializeFromRepo(
          state.source.owner,
          state.source.repo
        );
        if (!result.success) {
          setDeploying(false);
          return;
        }
        const sessionId = await startDeployment();
        if (sessionId) router.push(`/build/${sessionId}`);
      }
      // TODO: Handle upload and template sources
    } catch {
      setDeploying(false);
    }
  };

  const canAdvance = useMemo(() => {
    if (state.step === "configure") return state.config.name.trim().length > 0;
    return true;
  }, [state.step, state.config.name]);

  /* ── Render ───────────────────────────────────────────────────── */
  return (
    <div className="h-full flex flex-col">
      {/* ── Sticky header ──────────────────────────────────────── */}
      <div className="shrink-0 border-b border-border/40">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-10">
          {/* Top row: back + title + actions */}
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push("/projects")}
                className="flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              >
                <ArrowLeft className="size-4" />
              </button>
              <h1 className="text-base font-semibold text-foreground tracking-tight">
                New Project
              </h1>
            </div>

            {state.step !== "source" && (
              <div className="flex items-center gap-2">
                <button
                  onClick={goBack}
                  className="px-3.5 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted/50 transition-colors"
                >
                  Back
                </button>
                {state.step === "target" ? (
                  <button
                    onClick={handleDeploy}
                    disabled={deploying}
                    className="inline-flex items-center gap-2 px-5 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {deploying ? (
                      <>
                        <Loader2 className="size-3.5 animate-spin" />
                        Deploying…
                      </>
                    ) : (
                      <>
                        <Rocket className="size-3.5" />
                        Deploy
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    onClick={goNext}
                    disabled={!canAdvance}
                    className="inline-flex items-center gap-2 px-5 py-2 bg-foreground text-background text-sm font-medium rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Continue
                    <ArrowRight className="size-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Stepper */}
          <div className="flex items-center pb-4 -mt-1">
            {STEPS.map((step, i) => {
              const isCurrent = i === stepIndex;
              const isDone = i < stepIndex;
              return (
                <React.Fragment key={step.id}>
                  <button
                    onClick={() => {
                      if (i < stepIndex)
                        setState((s) => ({ ...s, step: step.id }));
                    }}
                    disabled={i > stepIndex}
                    className="flex items-center gap-2.5 shrink-0 group"
                  >
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold transition-all ${
                        isDone
                          ? "bg-primary text-primary-foreground"
                          : isCurrent
                            ? "bg-foreground text-background"
                            : "bg-muted text-muted-foreground/50"
                      }`}
                    >
                      {isDone ? <Check className="size-3" /> : i + 1}
                    </span>
                    <span
                      className={`text-[13px] font-medium transition-colors ${
                        isCurrent
                          ? "text-foreground"
                          : isDone
                            ? "text-foreground/60 group-hover:text-foreground/80"
                            : "text-muted-foreground/40"
                      }`}
                    >
                      {step.label}
                    </span>
                  </button>
                  {i < STEPS.length - 1 && (
                    <div
                      className={`flex-1 h-px mx-5 max-w-24 ${
                        i < stepIndex ? "bg-primary/30" : "bg-border/60"
                      }`}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Content: two columns ─────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
          <div className="flex gap-8 items-start">
            {/* Left — step content */}
            <div className="flex-1 min-w-0">
              {state.step === "source" && (
                <SourceSelector onSelect={handleSourceSelected} />
              )}
              {state.step === "configure" && state.source && (
                <ConfigureProject
                  source={state.source}
                  config={state.config}
                  onChange={(config) =>
                    setState((s) => ({ ...s, config }))
                  }
                />
              )}
              {state.step === "target" && (
                <TargetSelector
                  value={state.target}
                  onChange={(target) =>
                    setState((s) => ({ ...s, target }))
                  }
                  selfHostedAvailable={selfHostedAvailable}
                />
              )}
            </div>

            {/* Right — summary panel */}
            <div className="hidden lg:block w-[340px] xl:w-[380px] shrink-0 sticky top-8">
              <SummaryPanel state={state} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Summary panel (right side) ──────────────────────────────────── */

function SummaryPanel({ state }: { state: NewProjectState }) {
  if (state.step === "source") {
    return (
      <div className="space-y-4">
        {/* Import options */}
        <div className="rounded-2xl border border-border/50 bg-card p-5">
          <h3 className="text-[13px] font-semibold text-foreground mb-4">
            Import Options
          </h3>
          <div className="space-y-3.5">
            {[
              { icon: Github, label: "GitHub", desc: "Connect & import repositories" },
              { icon: Upload, label: "Upload", desc: "Drop a project folder" },
              { icon: Link2, label: "Git URL", desc: "Paste any public repo URL" },
              { icon: Sparkles, label: "Template", desc: "Start from a template" },
            ].map((item) => (
              <div key={item.label} className="flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-muted/60 flex items-center justify-center shrink-0">
                  <item.icon className="size-3.5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-[13px] font-medium text-foreground leading-tight">
                    {item.label}
                  </p>
                  <p className="text-xs text-muted-foreground leading-tight mt-0.5">
                    {item.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* What happens next */}
        <div className="rounded-2xl border border-border/50 bg-card p-5">
          <h3 className="text-[13px] font-semibold text-foreground mb-3">
            What happens next
          </h3>
          <div className="space-y-3">
            {[
              "We detect your framework automatically",
              "Configure build settings & environment",
              "Deploy to Oblien Cloud in seconds",
            ].map((text, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className="w-5 h-5 rounded-full bg-foreground/[0.06] flex items-center justify-center text-[10px] font-semibold text-muted-foreground shrink-0">
                  {i + 1}
                </span>
                <p className="text-xs text-muted-foreground leading-snug">
                  {text}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Features */}
        <div className="rounded-2xl border border-dashed border-border/50 bg-muted/20 p-5">
          <div className="space-y-3">
            {[
              { icon: Layers, text: "Automatic CI/CD on every push" },
              { icon: Globe, text: "Free .obl.ee subdomain included" },
              { icon: Shield, text: "TLS certificates provisioned automatically" },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <item.icon className="size-3.5 text-muted-foreground/60 shrink-0" />
                <span className="text-xs text-muted-foreground">
                  {item.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  /* ── Configure / Target: project summary ──────────────────────── */
  const fwInfo = frameworks.find((f) => f.id === state.config.framework);

  return (
    <div className="rounded-2xl border border-border/50 bg-card divide-y divide-border/50">
      {/* Header */}
      <div className="px-5 py-4">
        <h3 className="text-[13px] font-semibold text-foreground">
          Project Summary
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Review before deploying
        </p>
      </div>

      {/* Details */}
      <div className="p-5 space-y-3.5">
        {state.source && (
          <SummaryRow
            icon={
              state.source.kind === "github"
                ? Github
                : state.source.kind === "upload"
                  ? Upload
                  : state.source.kind === "url"
                    ? Link2
                    : Sparkles
            }
            label="Source"
            value={
              state.source.kind === "github"
                ? `${state.source.owner}/${state.source.repo}`
                : state.source.kind === "upload"
                  ? state.source.rootName
                  : state.source.kind === "url"
                    ? `${state.source.owner}/${state.source.repo}`
                    : state.source.templateName
            }
          />
        )}

        {state.config.name && (
          <SummaryRow icon={Box} label="Project" value={state.config.name} />
        )}

        {fwInfo && (
          <SummaryRow icon={Layers} label="Framework" value={fwInfo.name} />
        )}

        {state.config.domain && (
          <SummaryRow
            icon={Globe}
            label="Domain"
            value={`${state.config.domain}.obl.ee`}
          />
        )}

        {state.source?.kind === "github" && (
          <SummaryRow
            icon={GitBranch}
            label="Branch"
            value={state.source.branch}
          />
        )}

        {state.step === "target" && (
          <SummaryRow
            icon={state.target === "cloud" ? Cloud : Server}
            label="Target"
            value={state.target === "cloud" ? "Oblien Cloud" : "Self-Hosted"}
          />
        )}

        {state.config.envVars.length > 0 && (
          <SummaryRow
            icon={Shield}
            label="Variables"
            value={`${state.config.envVars.length} env var${state.config.envVars.length !== 1 ? "s" : ""}`}
          />
        )}
      </div>

      {/* Build commands */}
      {(state.config.buildCommand || state.config.installCommand) && (
        <div className="p-5">
          <p className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider mb-2.5">
            Build
          </p>
          <div className="space-y-1.5">
            {state.config.installCommand && (
              <code className="block text-[11px] text-muted-foreground font-mono bg-muted/50 px-2.5 py-1 rounded-lg truncate">
                $ {state.config.installCommand}
              </code>
            )}
            {state.config.buildCommand && (
              <code className="block text-[11px] text-muted-foreground font-mono bg-muted/50 px-2.5 py-1 rounded-lg truncate">
                $ {state.config.buildCommand}
              </code>
            )}
            {state.config.outputDirectory &&
              state.config.outputDirectory !== "." && (
                <code className="block text-[11px] text-muted-foreground font-mono bg-muted/50 px-2.5 py-1 rounded-lg truncate">
                  → {state.config.outputDirectory}
                </code>
              )}
          </div>
        </div>
      )}

      {/* Ready to deploy indicator on target step */}
      {state.step === "target" && state.config.name && (
        <div className="p-5">
          <div className="flex items-center gap-2.5 p-3 rounded-xl bg-primary/[0.06]">
            <div className="w-6 h-6 rounded-full bg-primary/15 flex items-center justify-center">
              <Check className="size-3 text-primary" />
            </div>
            <p className="text-xs font-medium text-primary">
              Ready to deploy
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Summary row helper ──────────────────────────────────────────── */

function SummaryRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 shrink-0">
        <Icon className="size-3.5 text-muted-foreground/50" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <span
        className="text-xs font-medium text-foreground truncate"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

