"use client";

import React, { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Rocket,
  Loader2,
  Check,
  ChevronRight,
} from "lucide-react";
import { useDeployment, DeploymentProvider } from "@/context/DeploymentContext";
import { encodeRepoSlug } from "@/utils/repoSlug";
import SourceSelector from "./components/SourceSelector";
import ConfigureProject from "./components/ConfigureProject";
import TargetSelector from "./components/TargetSelector";
import type {
  Step,
  ProjectSource,
  ProjectConfig,
  BuildTarget,
  NewProjectState,
} from "./types";
import { DEFAULT_CONFIG } from "./types";
import { getFrameworkConfig } from "@/components/import-project/Frameworks";

/* ── Steps definition ────────────────────────────────────────────── */

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
  const { initializeFromRepo, startDeployment, config: deployConfig } = useDeployment();

  const [state, setState] = useState<NewProjectState>({
    step: "source",
    source: null,
    config: DEFAULT_CONFIG,
    target: "cloud",
  });
  const [deploying, setDeploying] = useState(false);

  /* Determine if self-hosted is available from env/config */
  const selfHostedAvailable = useMemo(() => {
    // If running on Oblien (CLOUD_MODE), self-hosted is hidden
    return process.env.NEXT_PUBLIC_DEPLOY_MODE !== "cloud";
  }, []);

  /* ── Source selected → advance to configure ───────────────────── */
  const handleSourceSelected = useCallback(
    (source: ProjectSource) => {
      // Build initial config from source
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
    },
    []
  );

  /* ── Step navigation ──────────────────────────────────────────── */
  const stepIndex = STEPS.findIndex((s) => s.id === state.step);

  const goBack = () => {
    if (stepIndex > 0) {
      setState((s) => ({ ...s, step: STEPS[stepIndex - 1]!.id }));
    }
  };

  const goNext = () => {
    if (stepIndex < STEPS.length - 1) {
      setState((s) => ({ ...s, step: STEPS[stepIndex + 1]!.id }));
    }
  };

  /* ── Deploy ───────────────────────────────────────────────────── */
  const handleDeploy = async () => {
    if (!state.source) return;
    setDeploying(true);
    try {
      // For GitHub/URL sources, use the existing deployment flow
      if (state.source.kind === "github" || state.source.kind === "url") {
        const owner =
          state.source.kind === "github"
            ? state.source.owner
            : state.source.owner;
        const repo =
          state.source.kind === "github"
            ? state.source.repo
            : state.source.repo;

        // Initialize via deploy context
        const result = await initializeFromRepo(owner, repo);
        if (!result.success) {
          setDeploying(false);
          return;
        }

        // Start deployment
        const sessionId = await startDeployment();
        if (sessionId) {
          router.push(`/build/${sessionId}`);
        }
      }
      // TODO: Handle upload and template sources
    } catch {
      setDeploying(false);
    }
  };

  /* ── Can advance? ─────────────────────────────────────────────── */
  const canAdvance = useMemo(() => {
    if (state.step === "configure") {
      return state.config.name.trim().length > 0;
    }
    return true;
  }, [state.step, state.config.name]);

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[860px] mx-auto px-4 sm:px-6 py-6">
        {/* ── Top bar: breadcrumb steps ────────────────────────── */}
        <div className="flex items-center gap-2 mb-8">
          <button
            onClick={() => router.push("/projects")}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="size-4" />
            Projects
          </button>
          <ChevronRight className="size-3.5 text-muted-foreground/40" />
          <span className="text-sm font-medium text-foreground">New Project</span>
        </div>

        {/* ── Step indicator ───────────────────────────────────── */}
        <div className="flex items-center gap-1 mb-8">
          {STEPS.map((step, i) => {
            const isCurrent = i === stepIndex;
            const isDone = i < stepIndex;
            return (
              <React.Fragment key={step.id}>
                <button
                  onClick={() => {
                    // Can only go back, not forward
                    if (i < stepIndex) {
                      setState((s) => ({ ...s, step: step.id }));
                    }
                  }}
                  disabled={i > stepIndex}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                    isCurrent
                      ? "bg-foreground text-background"
                      : isDone
                        ? "text-foreground hover:bg-muted/50 cursor-pointer"
                        : "text-muted-foreground/50 cursor-not-allowed"
                  }`}
                >
                  <span
                    className={`flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-semibold ${
                      isCurrent
                        ? "bg-background text-foreground"
                        : isDone
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {isDone ? <Check className="size-3" /> : i + 1}
                  </span>
                  {step.label}
                </button>
                {i < STEPS.length - 1 && (
                  <div
                    className={`h-px flex-1 max-w-8 ${
                      i < stepIndex ? "bg-foreground/20" : "bg-border/60"
                    }`}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* ── Step content ─────────────────────────────────────── */}
        {state.step === "source" && (
          <SourceSelector onSelect={handleSourceSelected} />
        )}

        {state.step === "configure" && state.source && (
          <ConfigureProject
            source={state.source}
            config={state.config}
            onChange={(config) => setState((s) => ({ ...s, config }))}
          />
        )}

        {state.step === "target" && (
          <TargetSelector
            value={state.target}
            onChange={(target) => setState((s) => ({ ...s, target }))}
            selfHostedAvailable={selfHostedAvailable}
          />
        )}

        {/* ── Bottom bar ───────────────────────────────────────── */}
        {state.step !== "source" && (
          <div className="flex items-center justify-between mt-8 pt-6 border-t border-border/50">
            <button
              onClick={goBack}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors rounded-xl hover:bg-muted/50"
            >
              <ArrowLeft className="size-4" />
              Back
            </button>

            {state.step === "target" ? (
              <button
                onClick={handleDeploy}
                disabled={deploying}
                className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none"
              >
                {deploying ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Deploying...
                  </>
                ) : (
                  <>
                    <Rocket className="size-4" />
                    Deploy Project
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={goNext}
                disabled={!canAdvance}
                className="inline-flex items-center gap-2 px-6 py-3 bg-foreground text-background text-sm font-medium rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continue
                <ArrowRight className="size-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

