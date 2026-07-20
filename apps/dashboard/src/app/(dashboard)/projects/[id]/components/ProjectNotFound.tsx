"use client";

import React from "react";
import { Home, RefreshCw, AlertCircle } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";

export const ProjectNotFound: React.FC = () => {
  const { domain } = useProjectSettings();
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-center min-h-[500px] p-6">
      <div className="max-w-xl w-full">
        <div className="bg-card rounded-2xl border border-border shadow-xl p-8">
          {/* Icon and Title */}
          <div className="text-center mb-6">
            <div className="w-20 h-20 bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-red-500/20">
              <AlertCircle className="w-10 h-10 text-red-600 dark:text-red-400" strokeWidth={2} />
            </div>

            <h1 className="text-2xl font-bold text-foreground mb-2">
              {t.projects.notFound.title}
            </h1>

            <p className="text-muted-foreground text-sm">
              {t.projects.notFound.subtitle}
            </p>
          </div>

          {/* Content Section */}
          <div>
            <div className="bg-muted/40 rounded-xl border border-border p-5 mb-6">
              <p className="text-muted-foreground text-sm leading-relaxed mb-3 text-center">
                {t.projects.notFound.bodyPrefix} <code className="px-2 py-1 bg-card rounded-lg text-xs text-foreground font-semibold border border-border">{domain}</code> {t.projects.notFound.bodySuffix}
              </p>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-1 bg-muted-foreground/70 rounded-full"></div>
                  <span>{t.projects.notFound.reasonDeleted}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-1 h-1 bg-muted-foreground/70 rounded-full"></div>
                  <span>{t.projects.notFound.reasonAccess}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-1 h-1 bg-muted-foreground/70 rounded-full"></div>
                  <span>{t.projects.notFound.reasonUrl}</span>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-3 mb-6">
              <button
                onClick={() => window.location.href = '/'}
                className="flex items-center justify-center flex-1 bg-foreground hover:bg-foreground/90 text-background font-semibold py-3 rounded-xl transition-all gap-2"
              >
                <Home className="w-4 h-4" />
                {t.projects.notFound.dashboard}
              </button>

              <button
                onClick={() => window.location.reload()}
                className="flex items-center justify-center flex-1 bg-muted hover:bg-muted/80 text-foreground font-semibold py-3 rounded-xl transition-all gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                {t.projects.notFound.reload}
              </button>
            </div>

            {/* Help Link */}
            <div className="pt-4 border-t border-border text-center">
              <p className="text-xs text-muted-foreground mb-2">
                {t.projects.notFound.needHelp}
              </p>
              <div className="flex justify-center gap-2 text-xs">
                <a
                  href="https://openship.io/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground hover:text-primary font-semibold transition-colors"
                >
                  {t.projects.notFound.documentation}
                </a>
                <span className="text-muted-foreground/70">·</span>
                <a
                  href="mailto:hello@openship.io"
                  className="text-foreground hover:text-primary font-semibold transition-colors"
                >
                  {t.projects.notFound.support}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
