import { ArrowLeft } from "lucide-react";
import type { Step, ComponentState } from "./types";
import { useI18n, interpolate } from "@/components/i18n-provider";

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
  const { t } = useI18n();

  const subtitle = (() => {
    switch (step) {
      case "choose":
        return t.servers.setup.subChoose;
      case "checking":
        return t.servers.setup.subChecking;
      case "results":
        return interpolate(t.servers.setup.subResults, { host: serverHost });
      case "installing":
        return t.servers.setup.subInstalling;
    }
  })();

  return (
    <div className="flex items-center gap-3 mb-6">
      <button
        onClick={onBack}
        className="w-8 h-8 rounded-lg hover:bg-muted flex items-center justify-center transition-colors"
      >
        <ArrowLeft className="size-4 text-muted-foreground rtl:rotate-180" />
      </button>
      <div>
        <h1
          className="text-2xl font-medium text-foreground/80"
          style={{ letterSpacing: "-0.2px" }}
        >
          {t.servers.setup.serverSetup}
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {subtitle}
        </p>
      </div>
    </div>
  );
}
