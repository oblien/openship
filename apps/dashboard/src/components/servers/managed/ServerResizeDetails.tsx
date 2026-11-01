"use client";

import type { CloudWorkspaceResizePreview } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { CapacitySummary } from "@/components/shared/CapacitySummary";

export function ServerResizeDetails({ preview, notice }: { preview: CloudWorkspaceResizePreview; notice?: string }) {
  const { t } = useI18n();
  const copy = t.billing.workspaces;
  const sameSize = preview.before.cpuCores === preview.after.cpuCores &&
    preview.before.memoryMb === preview.after.memoryMb && preview.before.diskMb === preview.after.diskMb;
  return <div className="@container/resize space-y-4">
    <div className="grid gap-4 @min-[36rem]/resize:grid-cols-2">
      <div className="space-y-2"><p className="text-xs text-muted-foreground">{copy.before}</p><CapacitySummary resources={preview.before} /></div>
      <div className="space-y-2"><p className="text-xs text-muted-foreground">{copy.after}</p><CapacitySummary resources={preview.after} /></div>
    </div>
    <p className="text-sm text-muted-foreground">{sameSize ? copy.noResize : notice ?? copy.restartHint}</p>
    {!sameSize && preview.restartProjects.length > 0 && <ul className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
      {preview.restartProjects.map(project => <li key={project.id} className="rounded-lg bg-muted/50 px-3 py-1.5 text-sm">{project.name}</li>)}
    </ul>}
  </div>;
}
