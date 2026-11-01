import { Icon as UiIcon } from "@repo/ui/icons";
import type { SetupMode } from "./types";
import { useI18n } from "@/components/i18n-provider";

export function ChooseMode({
  onSelect,
  onSkip,
  disabled,
}: {
  onSelect: (mode: SetupMode) => void;
  onSkip: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <button
        onClick={() => onSelect("auto")}
        disabled={disabled}
        className="w-full text-start bg-card rounded-2xl border border-border/50 p-6 hover:border-primary/30 hover:bg-primary/[0.02] transition-all group"
      >
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <UiIcon name="bolt" className="size-6 text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-[15px] font-semibold text-foreground">{t.servers.setup.autoTitle}</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t.servers.setup.autoDesc}
            </p>
          </div>
          <UiIcon name="chevron-right" className="size-5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity rtl:rotate-180" />
        </div>
      </button>

      <button
        onClick={() => onSelect("manual")}
        disabled={disabled}
        className="w-full text-start bg-card rounded-2xl border border-border/50 p-6 hover:border-primary/30 hover:bg-primary/[0.02] transition-all group"
      >
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-orange-500/10 flex items-center justify-center shrink-0">
            <UiIcon name="list-check" className="size-6 text-orange-500" />
          </div>
          <div className="flex-1">
            <p className="text-[15px] font-semibold text-foreground">{t.servers.setup.stepTitle}</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t.servers.setup.stepDesc}
            </p>
          </div>
          <UiIcon name="chevron-right" className="size-5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity rtl:rotate-180" />
        </div>
      </button>

      <button
        onClick={onSkip}
        disabled={disabled}
        className="w-full text-start bg-card rounded-2xl border border-border/50 p-6 hover:border-primary/30 hover:bg-primary/[0.02] transition-all group"
      >
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center shrink-0">
            <UiIcon name="activity" className="size-6 text-muted-foreground" />
          </div>
          <div className="flex-1">
            <p className="text-[15px] font-semibold text-foreground">{t.servers.setup.skipTitle}</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t.servers.setup.skipDesc}
            </p>
          </div>
          <UiIcon name="chevron-right" className="size-5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity rtl:rotate-180" />
        </div>
      </button>
    </div>
  );
}
