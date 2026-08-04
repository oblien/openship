"use client";

import React from "react";
import { Home, RefreshCw, AlertCircle } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import { ResourceNotFound } from "@/components/resource-not-found";

export const ProjectNotFound: React.FC = () => {
  const { domain } = useProjectSettings();
  const { t } = useI18n();
  const nf = t.projects.notFound;
  const reasons = [nf.reasonDeleted, nf.reasonAccess, nf.reasonUrl];

  return (
    <div className="flex min-h-[500px] items-center justify-center p-6">
      <ResourceNotFound
        icon={<AlertCircle className="size-8 text-danger" strokeWidth={2} />}
        title={nf.title}
        description={nf.subtitle}
        actions={[
          {
            label: nf.dashboard,
            icon: <Home className="size-4" />,
            onClick: () => {
              window.location.href = "/";
            },
          },
          {
            label: nf.reload,
            icon: <RefreshCw className="size-4" />,
            variant: "secondary",
            onClick: () => window.location.reload(),
          },
        ]}
      >
        <div className="mt-5 w-full rounded-xl border border-border bg-muted/40 p-5 text-start">
          <p className="mb-3 text-center text-sm leading-relaxed text-muted-foreground">
            {nf.bodyPrefix}{" "}
            <code className="rounded-lg border border-border bg-card px-2 py-1 text-xs font-semibold text-foreground">
              {domain}
            </code>{" "}
            {nf.bodySuffix}
          </p>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            {reasons.map((reason) => (
              <div key={reason} className="flex items-center gap-2">
                <div className="size-1 rounded-full bg-muted-foreground/70" />
                <span>{reason}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5 w-full border-t border-border pt-4 text-center">
          <p className="mb-2 text-xs text-muted-foreground">{nf.needHelp}</p>
          <div className="flex justify-center gap-2 text-xs">
            <a
              href="https://docs.oblien.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-foreground transition-colors hover:text-primary"
            >
              {nf.documentation}
            </a>
            <span className="text-muted-foreground">·</span>
            <a
              href="mailto:support@oblien.com"
              className="font-semibold text-foreground transition-colors hover:text-primary"
            >
              {nf.support}
            </a>
          </div>
        </div>
      </ResourceNotFound>
    </div>
  );
};
