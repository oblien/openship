"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useState } from "react";
import { formatDate } from "@/utils/date";
import FileIcon from "@/components/ui/FileIcon";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Deployment } from "../types";

interface CommitDetailsModalProps {
  deployment: Deployment;
  isOpen: boolean;
  onClose: () => void;
}

export const CommitDetailsModal: React.FC<CommitDetailsModalProps> = ({
  deployment,
  isOpen,
  onClose,
}) => {
  const { t } = useI18n();
  const [expandedSection, setExpandedSection] = useState<'added' | 'modified' | 'removed' | null>('modified');

  if (!isOpen) return null;

  const modalStatusMap: Record<string, string> = {
    success: t.deployments.modal.statusName.success,
    failed: t.deployments.modal.statusName.failed,
    building: t.deployments.modal.statusName.building,
    deploying: t.deployments.modal.statusName.deploying,
    canceled: t.deployments.modal.statusName.canceled,
    cancelled: t.deployments.modal.statusName.canceled,
    pending: t.deployments.modal.statusName.pending,
  };
  const statusName =
    modalStatusMap[deployment.status] ??
    deployment.status.charAt(0).toUpperCase() + deployment.status.slice(1);

  const fileTypeLabels: Record<string, string> = {
    added: t.deployments.modal.fileTypes.added,
    modified: t.deployments.modal.fileTypes.modified,
    removed: t.deployments.modal.fileTypes.removed,
  };

  const hasCommitData = deployment.commit && deployment.commit.hash && deployment.commit.hash !== 'N/A';
  const commitUrl = deployment.owner && deployment.repo && deployment.commit?.hash
    ? `https://github.com/${deployment.owner}/${deployment.repo}/commit/${deployment.commit.hash}`
    : null;

  const changedFiles = deployment.commit?.changedFiles || [];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 transition-opacity"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="bg-card rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] overflow-hidden pointer-events-auto animate-in zoom-in-95 duration-200 border border-border/50"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="sticky top-0 bg-card border-b border-border/50 px-6 py-5 flex items-center justify-between z-10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <UiIcon name="git-commit" className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-foreground">{t.deployments.modal.title}</h2>
                {hasCommitData && (
                  <p className="text-sm text-muted-foreground font-mono">{deployment.commit.hash}</p>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-10 h-10 rounded-full hover:bg-muted flex items-center justify-center transition-colors"
            >
              <UiIcon name="close" className="w-5 h-5 text-muted-foreground" />
            </button>
          </div>

          {/* Content */}
          <div className="overflow-y-auto max-h-[calc(85vh-88px)] p-6">
            {hasCommitData ? (
              <div className="space-y-6">
                {/* Commit Message */}
                <div className="bg-primary/5 rounded-2xl p-5 border border-primary/10">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-card flex items-center justify-center flex-shrink-0 shadow-sm border border-border/50">
                      <UiIcon name="git-commit" className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-base font-semibold text-foreground mb-2">
                        {deployment.commit.message}
                      </p>
                      <div className="flex items-center gap-3 text-sm text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <UiIcon name="user" className="w-4 h-4" />
                          <span>{deployment.commit.author}</span>
                        </div>
                        <span className="text-muted-foreground/30">•</span>
                        <div className="flex items-center gap-1.5">
                          <UiIcon name="calendar" className="w-4 h-4" />
                          <span>{formatDate(deployment.commit.timestamp, undefined, undefined, true)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Deployment Info */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-muted/40 border border-border/50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      {t.deployments.modal.project}
                    </p>
                    <p className="text-base font-medium text-foreground">
                      {deployment.projectName || t.deployments.modal.unknownProject}
                    </p>
                  </div>
                  <div className="bg-muted/40 border border-border/50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      {t.deployments.modal.domain}
                    </p>
                    <p className="text-base font-medium text-foreground truncate">
                      {deployment.domain || t.deployments.modal.noDomain}
                    </p>
                  </div>
                  <div className="bg-muted/40 border border-border/50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      {t.deployments.modal.status}
                    </p>
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${
                      deployment.status === 'success' ? 'bg-success-bg text-success' :
                      deployment.status === 'failed' ? 'bg-danger-bg text-danger' :
                      deployment.status === 'building' ? 'bg-info-bg text-info' :
                      'bg-muted text-muted-foreground'
                    }`}>
                      {statusName}
                    </span>
                  </div>
                  <div className="bg-muted/40 border border-border/50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                      {t.deployments.modal.environment}
                    </p>
                    <p className="text-base font-medium text-foreground">
                      {deployment.environment || 'production'}
                    </p>
                  </div>
                </div>

                {/* Changed Files */}
                {changedFiles && changedFiles.length > 0 && (
                  <div>
                    <h3 className="text-base font-bold text-foreground mb-3 flex items-center gap-2">
                      {interpolate(t.deployments.modal.changedFiles, { count: String(changedFiles.length) })}
                    </h3>
                    <div className="bg-muted/40 rounded-xl border border-border/50 p-4">
                      <div className="space-y-2">
                        {changedFiles.map((file: any, idx: number) => {
                          const fileTypeConfig: Record<string, { bg: string; text: string; label: string }> = {
                            added: { bg: 'bg-success-bg', text: 'text-success', label: fileTypeLabels.added },
                            modified: { bg: 'bg-info-bg', text: 'text-info', label: fileTypeLabels.modified },
                            removed: { bg: 'bg-danger-bg', text: 'text-danger', label: fileTypeLabels.removed },
                          };
                          const typeConfig = fileTypeConfig[file.type] || fileTypeConfig.modified;

                          return (
                            <div
                              key={idx}
                              className="flex items-center gap-3 p-3 bg-card rounded-lg border border-border/50 hover:bg-muted/60 transition-colors"
                            >
                              <FileIcon fileName={file.name} language={file.language} style={{}} />
                              <span className="text-sm text-foreground flex-1 min-w-0 truncate font-mono">
                                {file.name}
                              </span>
                              <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${typeConfig.bg} ${typeConfig.text}`}>
                                {typeConfig.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Action Buttons */}
                <div className="flex gap-3 pt-4 border-t border-border/50">
                  {commitUrl && (
                    <a
                      href={commitUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 bg-foreground text-background rounded-xl font-medium text-sm hover:opacity-90 transition-all"
                    >
                      <UiIcon name="github" className="w-4 h-4" />
                      {t.deployments.modal.viewOnGithub}
                    </a>
                  )}
                  {deployment.domain && deployment.status === 'success' && (
                    <a
                      href={`https://${deployment.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground rounded-xl font-medium text-sm hover:opacity-90 transition-all"
                    >
                      <UiIcon name="external-link" className="w-4 h-4" />
                      {t.deployments.modal.visitSite}
                    </a>
                  )}
                </div>
              </div>
            ) : (
              /* Manual Deployment */
              <div className="text-center py-12">
                <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
                  <UiIcon name="git-commit" className="w-8 h-8 text-muted-foreground/50" />
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  {t.deployments.modal.manual.title}
                </h3>
                <p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
                  {t.deployments.modal.manual.description}
                </p>
                <div className="bg-muted/40 rounded-xl border border-border/50 p-4 max-w-md mx-auto">
                  <div className="space-y-3 text-start">
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                        {t.deployments.modal.manual.deploymentId}
                      </p>
                      <code className="text-sm text-foreground font-mono">{deployment.id}</code>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                        {t.deployments.modal.manual.created}
                      </p>
                      <p className="text-sm text-foreground">{formatDate(deployment.createdAt)}</p>
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                        {t.deployments.modal.manual.type}
                      </p>
                      <p className="text-sm text-foreground capitalize">{deployment.type || t.deployments.modal.manual.typeManual}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

