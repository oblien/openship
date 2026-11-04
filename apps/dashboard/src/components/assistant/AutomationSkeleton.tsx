import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type { AssistantAutomation } from "@repo/contracts";
import { Button } from "@/components/ui/button";
import { SkeletonBlock } from "./AssistantSkeletons";
import { AutomationSteps } from "./AutomationSteps";

export type AutomationPreview = AssistantAutomation & { agentName?: string; paused?: boolean };
const ignoreSelection = () => {};

export function AutomationEditorSkeleton({
  preview,
  embedded,
  initialStep = 0,
  onCancel,
}: {
  preview?: AutomationPreview;
  embedded?: boolean;
  initialStep?: number;
  onCancel?(): void;
}) {
  return (
    <div
      role="status"
      aria-label="Loading automation settings"
      aria-busy="true"
      className="mx-auto w-full max-w-3xl"
    >
      <div className="flex min-h-16 items-center justify-between gap-3 py-3">
        {embedded ? (
          preview ? (
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate text-sm">{preview.projectName}</span>
              <span className="hidden shrink-0 items-center gap-2 text-xs text-muted-foreground sm:inline-flex">
                <Icon
                  name={preview.enabled && !preview.paused ? "play" : "pause"}
                  className="size-3"
                />
                {preview.paused ? "All automations paused" : preview.enabled ? "Enabled" : "Paused"}
              </span>
            </div>
          ) : (
            <SkeletonBlock className="h-4 w-32" />
          )
        ) : (
          <Link
            href="/assistant?tab=automations"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <Icon name="arrow-left" className="size-4 rtl:rotate-180" /> Automations
          </Link>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Cancel changes">
              Cancel
            </Button>
          )}
          <SkeletonBlock className="h-8 w-28 rounded-xl" />
        </div>
      </div>
      <AutomationSteps flow={preview} loading currentStep={initialStep} onSelect={ignoreSelection}>
        <div className="space-y-5" aria-hidden="true">
          {initialStep === 0 ? (
            <>
              <div className="grid gap-4 @lg:grid-cols-2">
                <FieldSkeleton />
                <FieldSkeleton />
              </div>
              <FieldSkeleton />
              <SkeletonBlock className="h-3 w-4/5" />
            </>
          ) : initialStep === 1 ? (
            <>
              <FieldSkeleton />
              <SkeletonBlock className="h-3 w-2/3" />
              <SkeletonBlock className="h-3 w-36" />
              <SkeletonBlock className="h-28 w-full rounded-xl" />
              <SkeletonBlock className="h-3 w-4/5" />
            </>
          ) : initialStep === 2 ? (
            <>
              <FieldSkeleton />
              <SkeletonBlock className="h-3 w-4/5" />
              <div className="space-y-4 border-t border-border/40 pt-5">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-3 w-3/4" />
              </div>
            </>
          ) : (
            <>
              <SkeletonBlock className="h-3 w-2/3" />
              <SkeletonBlock className="h-4 w-24" />
              <div className="flex items-center gap-3 py-3">
                <SkeletonBlock className="size-8 rounded-lg" />
                <SkeletonBlock className="h-3 w-36" />
              </div>
              <SkeletonBlock className="h-3 w-4/5" />
              <div className="space-y-6 border-t border-border/40 pt-5">
                <SkeletonBlock className="h-4 w-full" />
                <SkeletonBlock className="h-8 w-full" />
              </div>
            </>
          )}
        </div>
      </AutomationSteps>
    </div>
  );
}

function FieldSkeleton() {
  return (
    <div className="space-y-2">
      <SkeletonBlock className="h-3 w-24" />
      <SkeletonBlock className="h-11 w-full rounded-xl" />
    </div>
  );
}

export function AutomationDetailSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div
        role="status"
        aria-label="Loading automation"
        aria-busy="true"
        className="mx-auto w-full max-w-3xl px-1 pb-8 pt-2"
      >
        <div className="flex min-h-16 items-center justify-between gap-3 py-3">
          <SkeletonBlock className="h-4 w-32" />
          <SkeletonBlock className="h-5 w-24" />
        </div>
        <AutomationSteps loading onSelect={ignoreSelection} />
        <SkeletonBlock className="mt-4 h-3 w-52" />
        <div className="mt-8 space-y-5 border-t border-border/40 pt-5">
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="h-3 w-3/4" />
        </div>
      </div>
    </div>
  );
}
