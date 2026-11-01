"use client";

import { useI18n } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { DeploymentLogsPanel } from "./DeploymentLogsPanel";
import { DeploymentLayout } from "./DeploymentLayout";

export default function BuildSkeleton() {
  const { t } = useI18n();
  return (
    <PageContainer>
      <div role="status" aria-busy="true">
        <span className="sr-only">{t.importProject.buildSkeleton.loading}</span>
        <div className="mb-6 space-y-4 motion-safe:animate-pulse" aria-hidden>
          <div className="h-4 w-48 rounded bg-muted" />
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-3"><div className="h-7 w-64 max-w-full rounded-lg bg-muted" /><div className="h-4 w-40 rounded bg-muted" /></div>
            <div className="h-10 w-36 rounded-xl bg-muted" />
          </div>
        </div>
        <DeploymentLayout
          details={
            <div className="h-fit space-y-5 rounded-2xl bg-card p-5 motion-safe:animate-pulse" aria-hidden>
              <div className="h-4 w-32 rounded bg-muted" />
              {[1, 2, 3, 4, 5].map(key => <div key={key} className="flex justify-between gap-4"><div className="h-4 w-20 rounded bg-muted" /><div className="h-4 w-24 rounded bg-muted" /></div>)}
            </div>
          }
          navigation={
            <div className="grid grid-cols-2 gap-3 rounded-2xl bg-card p-5 motion-safe:animate-pulse" aria-hidden>
              {[1, 2, 3, 4, 5, 6].map(key => <div key={key} className="h-8 rounded-lg bg-muted" />)}
            </div>
          }
        >
          <DeploymentLogsPanel title={t.importProject.composeDeployment.logsTitle}>
            <div className="space-y-3 p-5 motion-safe:animate-pulse" aria-hidden>
              {["w-4/5", "w-2/3", "w-3/4", "w-1/2", "w-2/3", "w-4/5"].map((width, index) => <div key={index} className={`h-3 rounded bg-muted ${width}`} />)}
            </div>
          </DeploymentLogsPanel>
        </DeploymentLayout>
      </div>
    </PageContainer>
  );
}
