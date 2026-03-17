import { ArrowLeft } from "lucide-react";
import type { Step, ComponentState } from "./types";

function getSubtitle(
  step: Step,
  serverHost: string,
  overallReady: boolean,
  components: ComponentState[],
): string {
  switch (step) {
    case "choose":
      return "Choose how you'd like to set up your server";
    case "checking":
      return "Checking server requirements\u2026";
    case "results":
      return `Results for ${serverHost}`;
    case "installing":
      return "Installing components\u2026";
  }
}

export function SetupHeader({
  step,
  serverHost,
  overallReady,
  components,
  onBack,
}: {
  step: Step;
  serverHost: string;
  overallReady: boolean;
  components: ComponentState[];
  onBack: () => void;
}) {
  return (
    <div className="flex items-center gap-3 mb-6">
      <button
        onClick={onBack}
        className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
      >
        <ArrowLeft className="size-4 text-muted-foreground" />
      </button>
      <div>
        <h1
          className="text-2xl font-medium text-foreground/80"
          style={{ letterSpacing: "-0.2px" }}
        >
          Server Setup
        </h1>
        <p className="text-sm text-muted-foreground/70 mt-0.5">
          {getSubtitle(step, serverHost, overallReady, components)}
        </p>
      </div>
    </div>
  );
}
