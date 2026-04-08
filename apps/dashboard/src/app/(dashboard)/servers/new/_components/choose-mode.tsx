import { Zap, ListChecks, ChevronRight } from "lucide-react";
import type { SetupMode } from "./types";

export function ChooseMode({
  onSelect,
  disabled,
}: {
  onSelect: (mode: SetupMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-3">
      <button
        onClick={() => onSelect("auto")}
        disabled={disabled}
        className="w-full text-left bg-card rounded-2xl border border-border/50 p-6 hover:border-primary/30 hover:bg-primary/[0.02] transition-all group"
      >
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <Zap className="size-6 text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-[15px] font-semibold text-foreground">Automatic Setup</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              Check requirements and install everything automatically.
              One click — Openship handles Docker, OpenResty, and Git.
            </p>
          </div>
          <ChevronRight className="size-5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </button>

      <button
        onClick={() => onSelect("manual")}
        disabled={disabled}
        className="w-full text-left bg-card rounded-2xl border border-border/50 p-6 hover:border-primary/30 hover:bg-primary/[0.02] transition-all group"
      >
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center shrink-0">
            <ListChecks className="size-6 text-orange-500" />
          </div>
          <div className="flex-1">
            <p className="text-[15px] font-semibold text-foreground">Step-by-Step Setup</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              Review each component and choose what to install.
              See detailed status before proceeding.
            </p>
          </div>
          <ChevronRight className="size-5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </button>
    </div>
  );
}
