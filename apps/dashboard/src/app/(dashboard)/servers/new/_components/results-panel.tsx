import {
  Server,
  CheckCircle2,
  Download,
  Play,
  RotateCcw,
} from "lucide-react";
import { ComponentRow } from "./component-row";
import type { ComponentState, SetupMode } from "./types";
import { BlurIp } from "@/components/BlurIp";
import { useI18n, interpolate } from "@/components/i18n-provider";

export function ResultsPanel({
  components,
  serverHost,
  overallReady,
  mode,
  onAutoInstall,
  onManualContinue,
  onRecheck,
  onDone,
}: {
  components: ComponentState[];
  serverHost: string;
  overallReady: boolean;
  mode: SetupMode;
  onAutoInstall: () => void;
  onManualContinue: () => void;
  onRecheck: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const requiredComps = components.filter((c) => !c.status?.optional);
  const infraComps = components.filter((c) => c.status?.optional);

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-2xl border border-border/50">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
          <div className="w-9 h-9 bg-info-bg rounded-xl flex items-center justify-center">
            <Server className="size-[18px] text-info" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground text-[15px]"><BlurIp>{serverHost}</BlurIp></h2>
            <p className="text-xs text-muted-foreground">
              {overallReady
                ? t.servers.setup.allRequirementsMet
                : interpolate(t.servers.setup.needAttention, {
                    count: String(requiredComps.filter((c) => !c.status?.healthy).length),
                  })}
            </p>
          </div>
        </div>

        <div className="p-5 space-y-1">
          {requiredComps.map((comp) => (
            <ComponentRow key={comp.name} component={comp} />
          ))}
          {infraComps.length > 0 && (
            <>
              <div className="flex items-center gap-2 pt-3 pb-1">
                <div className="h-px flex-1 bg-border/50" />
                <span className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider">
                  {t.servers.setup.detectedInfrastructure}
                </span>
                <div className="h-px flex-1 bg-border/50" />
              </div>
              {infraComps.map((comp) => (
                <ComponentRow key={comp.name} component={comp} />
              ))}
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        {overallReady ? (
          <button
            onClick={onDone}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all"
          >
            <CheckCircle2 className="size-4" />
            {t.servers.setup.doneGoToServers}
          </button>
        ) : mode === "auto" ? (
          <button
            onClick={onAutoInstall}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all"
          >
            <Download className="size-4" />
            {t.servers.setup.installAllMissing}
          </button>
        ) : (
          <button
            onClick={onManualContinue}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all"
          >
            <Play className="size-4" />
            {t.servers.setup.installMissingComponents}
          </button>
        )}
        <button
          onClick={onRecheck}
          className="inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
        >
          <RotateCcw className="size-4" />
          {t.servers.setup.recheck}
        </button>
      </div>
    </div>
  );
}
